// Reusable story steps of the SLP flow (spec phases 1-6). Each step performs the tool calls an
// agent would make and waits for the pipeline's detached follow-up work to settle.
import { vi } from "vitest";
import { ACCEPTANCE_DOC_SECTIONS } from "../../server/prompts/task-spec";
import { approveGate } from "../../server/pipeline/gates";
import type { GateKind, TaskPhase } from "../../shared/state";
import type { Flow } from "./flow-fixture";
import { commitFiles, writeWorkingFiles } from "./git-fixture";

export const API_TASK = {
  id: "api-layer",
  title: "API layer",
  purpose: "Expose the billing endpoints",
  assumptions: ["router lives in src/api/router.ts"],
  writableScope: ["src/api/"],
};
export const UI_TASK = {
  id: "ui-layer",
  title: "UI layer",
  purpose: "Render the billing page",
  writableScope: ["src/ui/"],
};

export const IMPLEMENTER_PLAN = {
  restatedGoal: "Add the billing endpoints",
  discrepancies: ["router is in src/api/routes.ts, not router.ts"],
  plannedFiles: ["src/api/billing.ts"],
};

export const COMPLETE_ACCEPTANCE_DOC = ACCEPTANCE_DOC_SECTIONS.map((section) => `## ${section}\nDone.`).join("\n\n");

export const forkedLeadReply = (verdict: "approve" | "clarify" | "escalate", message = "ok") =>
  `Here is my verdict.\n\`\`\`json\n${JSON.stringify({ verdict, message })}\n\`\`\``;

// Polling with a tight interval: the pipeline's follow-up work is detached, so assertions must wait instead of reading state once.
export const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4000, interval: 10 });

// Phase 1: Supervisor delegates, Master Lead defines tasks, queued tasks reach the handshake.
export async function delegateAndDefineTasks(flow: Flow, runId: string, taskDefinitions: object[] = [API_TASK, UI_TASK]): Promise<void> {
  const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
    acceptanceCriteria: "Billing works end to end with tests and docs.",
  });
  if (delegation.isError) throw new Error(delegation.text);
  const definition = await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", {
    masterSpecPath: ".slp/MASTER_SPEC.md",
    tasks: taskDefinitions,
  });
  if (definition.isError) throw new Error(definition.text);
  // Tasks leave 'queued' only after the fork checkpoint and worktree creation, which run after the tool call returned.
  await eventually(() => {
    for (const task of Object.values(flow.run(runId).tasks)) {
      if (task.phase === "queued") throw new Error(`${task.id} still queued`);
    }
  });
}

export async function startedRunWithTasks(flow: Flow, taskDefinitions?: object[]): Promise<string> {
  const runId = await flow.startRun();
  await delegateAndDefineTasks(flow, runId, taskDefinitions);
  return runId;
}

// Handshake round: the implementer submits a plan and the scripted Forked Lead answers.
export async function submitPlanAndAwaitReview(flow: Flow, runId: string, taskId: string, verdict: "approve" | "clarify" | "escalate", message = "ok"): Promise<void> {
  const forkedLeadId = flow.agentId(runId, "forked_lead", taskId);
  // The turn count before submitting distinguishes this review from earlier ones of the same Forked Lead.
  const reviewsBefore = flow.gateway.turns.filter((turn) => turn.agentId === forkedLeadId).length;
  flow.gateway.scriptTurnReplies(forkedLeadId, [forkedLeadReply(verdict, message)]);
  const submission = await flow.callAsRole(runId, "implementer", taskId, "slp_submit_plan", IMPLEMENTER_PLAN);
  if (submission.isError) throw new Error(submission.text);
  // the verdict is processed after runTurn resolves, so wait for the review turn and its effects
  await eventually(() => {
    if (flow.gateway.turns.filter((turn) => turn.agentId === forkedLeadId).length <= reviewsBefore) throw new Error("review not run yet");
  });
}

export async function approveHandshake(flow: Flow, runId: string, taskId: string): Promise<void> {
  await submitPlanAndAwaitReview(flow, runId, taskId, "approve");
  await eventually(() => {
    // Either phase is acceptable here: with an after_handshake gate the task stays in handshaking until approved.
    if (!["implementing", "handshaking"].includes(flow.task(runId, taskId).phase)) throw new Error("unexpected phase");
    if (flow.task(runId, taskId).agentIds.forked_lead) throw new Error("forked lead still present");
  });
}

// The scope of the writable directory of a task, used to place a real in-scope commit.
export function commitInScopeWork(flow: Flow, runId: string, taskId: string, fileName = "feature.ts"): void {
  const task = flow.task(runId, taskId);
  // Commits (not just file writes) so the scope gate sees the work through the committed diff as it does in production.
  const scopeDirectory = task.writableScope[0].replace(/\/$/, "");
  commitFiles(task.workspace!.cwd, { [`${scopeDirectory}/${fileName}`]: `export const ${taskId.replace(/-/g, "_")} = true;\n` }, `work for ${taskId}`);
}

export async function finishImplementation(flow: Flow, runId: string, taskId: string): Promise<void> {
  commitInScopeWork(flow, runId, taskId);
  const stageReport = await flow.callAsRole(runId, "implementer", taskId, "slp_stage_done", { summary: "implemented" });
  if (stageReport.isError) throw new Error(stageReport.text);
}

export async function waitForPhase(flow: Flow, runId: string, taskId: string, expectedPhase: TaskPhase): Promise<void> {
  await eventually(() => {
    const actualPhase = flow.task(runId, taskId).phase;
    if (actualPhase !== expectedPhase) throw new Error(`${taskId} is ${actualPhase}, expected ${expectedPhase}`);
  });
}

export async function approveVerification(flow: Flow, runId: string, taskId: string): Promise<void> {
  await eventually(() => {
    // Verifiers are created lazily after the scope gate, so wait for them to exist before voting.
    for (const verifierRole of flow.task(runId, taskId).verifiers) flow.agentId(runId, verifierRole, taskId);
  });
  for (const verifierRole of flow.task(runId, taskId).verifiers) {
    const verdictOutcome = await flow.callAsRole(runId, verifierRole, taskId, "slp_verdict", { verdict: "APPROVED" });
    if (verdictOutcome.isError) throw new Error(verdictOutcome.text);
    // sequential stages create the next verifier only after this approval
    if (!flow.task(runId, taskId).verifyParallel) await eventually(() => undefined);
  }
}

export function writeAcceptanceDoc(flow: Flow, runId: string, taskId: string, documentText = COMPLETE_ACCEPTANCE_DOC): void {
  writeWorkingFiles(flow.task(runId, taskId).workspace!.cwd, { ".slp/ACCEPTANCE_DOC.md": documentText });
}

// Drives a task from handshake to ready_for_merge, approving any human gate it meets on the way.
export async function driveToReadyForMerge(
  flow: Flow,
  runId: string,
  taskId: string,
  onGateOpened: (gateKind: GateKind) => void = () => undefined,
): Promise<void> {
  // Gates only open in some modes, so each step tolerates both the gated and the ungated path.
  const approveOpenGate = async () => {
    const openGate = flow.task(runId, taskId).gate;
    if (!openGate) return;
    onGateOpened(openGate.kind);
    await approveGate(flow.ctx, runId, taskId);
  };
  await approveHandshake(flow, runId, taskId);
  await approveOpenGate();
  await waitForPhase(flow, runId, taskId, "implementing");
  await finishImplementation(flow, runId, taskId);
  await approveOpenGate();
  await approveVerificationWhenWoken(flow, runId, taskId);
  await approveOpenGate();
  await waitForPhase(flow, runId, taskId, "documenting");
  writeAcceptanceDoc(flow, runId, taskId);
  const docReport = await flow.callAsRole(runId, "implementer", taskId, "slp_doc_done", {});
  if (docReport.isError) throw new Error(docReport.text);
  await waitForPhase(flow, runId, taskId, "ready_for_merge");
  await approveOpenGate();
}

async function approveVerificationWhenWoken(flow: Flow, runId: string, taskId: string): Promise<void> {
  await approveVerification(flow, runId, taskId);
  await eventually(() => {
    const task = flow.task(runId, taskId);
    // with an after_verification gate the phase stays 'verifying' while the gate is open
    if (task.phase === "verifying" && !task.gate) throw new Error("verification round still open");
  });
}
