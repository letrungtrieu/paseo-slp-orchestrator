// Reusable story steps for the Lead-authored pipeline protocol. The helpers intentionally
// drive the MCP tools instead of mutating pipeline state, so flow tests cover authentication,
// role checks and the same asynchronous stage handoffs used by real agents.
import { vi } from "vitest";
import type { PipelineDefinition, PipelineState, StageState } from "../../shared/pipeline";
import type { BusToolOutcome } from "../../server/bus/http-mcp";
import type { Flow } from "./flow-fixture";
import { commitFiles, runGitSync } from "./git-fixture";

// Planning advisors hand the Lead a brief that locks the developer's scope; tests reuse one compact example.
export const SAMPLE_BRIEF = {
  approach: "Parse the CSV with the existing reader and add one import service.",
  criteria: [{ id: "C1", requirement: "Every valid CSV row becomes an invoice with a two-decimal total.", verification: "Run the billing import unit test." }],
  inScope: ["src/billing-import.ts"],
  outOfScope: ["Editing invoices"],
};

// The enforced feature shape: advisors plan, then exactly one developer implements the locked brief.
export const DEFAULT_PIPELINE: PipelineDefinition = {
  name: "billing-import",
  version: "1.0",
  worktree: "pipeline-billing-import",
  description: "Plan and implement the billing import flow.",
  stages: [
    {
      name: "planning",
      goal: "Choose the billing import approach and lock the brief.",
      peers: [
        { role: "reviewer", task: "Compare parsing techniques and recommend one." },
        { role: "architect", task: "Propose where the import service lives." },
      ],
    },
    {
      name: "coding",
      goal: "Implement the locked brief in the shared worktree.",
      peers: [{ role: "developer", task: "Implement the billing import behavior and report evidence." }],
    },
  ],
};

// Same shape under another name for tests that need a second, independent pipeline identity.
export const TWO_PEER_PIPELINE: PipelineDefinition = {
  ...DEFAULT_PIPELINE,
  name: "billing-review",
};

export const SECOND_STAGE_PIPELINE: PipelineDefinition = {
  ...DEFAULT_PIPELINE,
  name: "billing-sequential",
};

// Smallest valid feature pipeline: no planning, so the brief comes with the definition.
export const SINGLE_DEVELOPER_PIPELINE: PipelineDefinition = {
  name: "billing-quickfix",
  version: "1.0",
  worktree: "pipeline-billing-quickfix",
  description: "Implement a small billing fix directly from a brief.",
  brief: SAMPLE_BRIEF,
  stages: [{ name: "coding", goal: "Implement the brief.", peers: [{ role: "developer", task: "Implement the fix." }] }],
};

// Polling is needed because stage creation is deliberately detached from the defining tool call.
export const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4000, interval: 10 });

// Delegation requires a human-approved product spec, so tests share one that has every template section.
export const SAMPLE_PRODUCT_SPEC = [
  "Screens: Billing import page with a file picker, an Import button (disabled until a file is chosen) and a result table.",
  "States: empty table before import; spinner while importing; error banner when the file is invalid.",
  "Given a valid CSV When the user clicks Import Then the table lists every imported invoice with its total.",
  "Rules: totals use two decimals. Out of scope: editing invoices.",
].join("\n");

export async function delegateToLead(flow: Flow, runId: string): Promise<void> {
  const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
    acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
    productSpec: SAMPLE_PRODUCT_SPEC,
  });
  if (delegation.isError) throw new Error(delegation.text);
}

export async function definePipeline(
  flow: Flow,
  runId: string,
  definition: PipelineDefinition = DEFAULT_PIPELINE,
): Promise<string> {
  const response = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: definition });
  if (response.isError) throw new Error(response.text);
  const pipelineId = JSON.parse(response.text).pipelineId as string;
  // Wait until Stage 1's peer cohort has been spawned in the Lead's worktree.
  await eventually(() => {
    const pipeline = flow.pipeline(runId, pipelineId);
    if (!pipeline || pipeline.status === "queued" || pipeline.status === "starting") {
      throw new Error("pipeline cohort is still starting");
    }
  });
  return pipelineId;
}

export async function startedRunWithPipeline(
  flow: Flow,
  definition: PipelineDefinition = DEFAULT_PIPELINE,
): Promise<{ runId: string; pipelineId: string }> {
  const runId = await flow.startRun();
  await delegateToLead(flow, runId);
  // slp_delegate provisions the Lead's dedicated worktree immediately; slp_create_worktree is also available when overriding worktree.
  const workspaceResponse = await flow.callAsRole(runId, "master_lead", null, "slp_create_worktree", { name: definition.name });
  if (workspaceResponse.isError) throw new Error(workspaceResponse.text);
  const workspace = JSON.parse(workspaceResponse.text) as { cwd: string };
  const pipelineId = await definePipeline(flow, runId, { ...definition, worktree: workspace.cwd });
  return { runId, pipelineId };
}

export function currentStage(flow: Flow, runId: string, pipelineId: string): StageState {
  const pipeline = flow.pipeline(runId, pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline ${pipelineId}`);
  const stage = pipeline.stages[pipeline.currentStageIndex];
  if (!stage) throw new Error(`Pipeline ${pipelineId} has no current stage`);
  return stage;
}

export function stageByName(flow: Flow, runId: string, pipelineId: string, name: string): StageState {
  const pipeline = flow.pipeline(runId, pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline ${pipelineId}`);
  const stage = pipeline.stages.find((candidate) => candidate.name === name);
  if (!stage) throw new Error(`Unknown stage ${name}`);
  return stage;
}

export async function waitForStage(flow: Flow, runId: string, pipelineId: string, status: StageState["status"]): Promise<void> {
  await eventually(() => {
    if (currentStage(flow, runId, pipelineId).status !== status) throw new Error(`stage is not ${status}`);
  });
}

// QA graders must attach a scorecard; every other kind reports plain evidence.
export function passingScorecard(summary = "Evidence collected") {
  return [{ criterionId: "C1", status: "pass", reason: summary, evidence: "unit test output" }];
}

export async function reportPeer(flow: Flow, runId: string, pipelineId: string, peerRole: string, summary = "Evidence collected"): Promise<void> {
  const stage = currentStage(flow, runId, pipelineId);
  const peerId = flow.agentId(runId, peerRole, stage.id);
  const isGrader = /(^|[-_])qa/.test(peerRole);
  const response = await flow.callAs(peerId, "slp_stage_report", {
    summary, findings: [summary], status: "completed", ...(isGrader ? { scorecard: passingScorecard(summary) } : {}),
  });
  if (response.isError) throw new Error(response.text);
}

export async function approveCurrentStage(flow: Flow, runId: string, pipelineId: string, summary = "The stage goal is met."): Promise<void> {
  const approvedStage = currentStage(flow, runId, pipelineId);
  const coordinatorId = flow.agentId(runId, "forked_lead", approvedStage.id);
  // Planning approval must carry the brief that locks the next stage's scope.
  const response = await flow.callAs(coordinatorId, "slp_approve_stage", approvedStage.kind === "planning" ? { summary, brief: SAMPLE_BRIEF } : { summary });
  if (response.isError) throw new Error(response.text);
  // Stage closure archives the old cohort and asynchronously spawns the next stage's agents;
  // callers must wait until either the pipeline finishes/pauses or the new cohort is running.
  await eventually(() => {
    const pipeline = flow.pipeline(runId, pipelineId);
    if (!pipeline) throw new Error("pipeline disappeared during stage handoff");
    if (pipeline.status === "completed" || pipeline.status === "paused") return;
    const activeStage = pipeline.stages[pipeline.currentStageIndex];
    if (!activeStage || activeStage.id === approvedStage.id || activeStage.status !== "running") {
      throw new Error("stage handoff is still pending");
    }
  });
}

export async function completePipeline(flow: Flow, runId: string, pipelineId: string): Promise<void> {
  while (flow.pipeline(runId, pipelineId)?.status !== "completed") {
    const stage = currentStage(flow, runId, pipelineId);
    for (const assignment of stage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);
  }
}

export function commitPipelineWork(flow: Flow, runId: string, pipelineId: string, fileName = "src/billing-import.ts"): void {
  const pipeline = flow.pipeline(runId, pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline ${pipelineId}`);
  commitFiles(pipeline.worktree, { [fileName]: "export const billingImportReady = true;\n" }, "implement billing import");
}

export function pipelineBranch(flow: Flow, runId: string, pipelineId: string): string {
  const pipeline = flow.pipeline(runId, pipelineId);
  if (!pipeline?.branch) throw new Error(`Pipeline ${pipelineId} has no branch`);
  return pipeline.branch;
}

export function pipelineHead(flow: Flow, runId: string, pipelineId: string): string {
  const pipeline = flow.pipeline(runId, pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline ${pipelineId}`);
  return runGitSync(pipeline.worktree, ["rev-parse", "HEAD"]).trim();
}

export type PipelineStory = { runId: string; pipelineId: string; pipeline: PipelineState };

// A one-stage QA pass; worktree is omitted because QA pipelines always run in the QA worktree.
export const QA_PIPELINE = {
  name: "qa-verification",
  description: "Verify the merged QA branch",
  stages: [{ name: "verify", goal: "Verify the merged build", peers: [{ role: "qa-engineer", task: "Run every suite on the merged build" }] }],
};

// Drives the QA Lead from handover to report so feature-flow tests can reach the Supervisor quickly.
export async function verifyAndReportFromQaLead(flow: Flow, runId: string, summary = "QA verified the merged build."): Promise<string> {
  const qaLeadId = flow.run(runId).qaLeadAgentId;
  const defined = await flow.callAs(qaLeadId, "slp_define_pipeline", { pipeline: QA_PIPELINE });
  if (defined.isError) throw new Error(defined.text);
  const { pipelineId } = JSON.parse(defined.text) as { pipelineId: string };
  await eventually(() => {
    if (flow.pipeline(runId, pipelineId)?.status !== "running") throw new Error("QA stage is still starting");
  });
  await completePipeline(flow, runId, pipelineId);
  const closed = await flow.callAs(qaLeadId, "slp_finalize_pipeline", { pipelineId, summary });
  if (closed.isError) throw new Error(closed.text);
  const reported = await flow.callAs(qaLeadId, "slp_report", { summary });
  if (reported.isError) throw new Error(reported.text);
  return pipelineId;
}

// The QA branch is the only slp/* branch that must survive feature merges, because QA still runs on it.
export function localSlpBranches(flow: Flow): string[] {
  return runGitSync(flow.repoPath, ["branch", "--list", "slp/*"])
    .split("\n")
    .map((branchLine) => branchLine.replace(/^[*+ ]+/, "").trim())
    .filter(Boolean);
}

// Runs a blocking slp_ask to completion: the asker is left waiting inside its tool call, the recipient
// answers through slp_answer, and the outcome the asker's call returned is handed back for assertions.
export async function askAndAnswer(
  flow: Flow,
  askerId: string,
  recipientId: string,
  question: string,
  answer: string,
): Promise<{ askOutcome: BusToolOutcome; questionId: string }> {
  const runId = flow.store.findAgent(askerId)!.run.id;
  // Not awaited yet: the call must stay open while the recipient answers it.
  const pendingAsk = flow.callAs(askerId, "slp_ask", { toAgentId: recipientId, question });
  const questionId = await vi.waitFor(() => {
    const askedQuestion = flow.store.questions.listPendingForRecipient(runId, recipientId).find((candidate) => candidate.question === question);
    if (!askedQuestion) throw new Error("question not recorded yet");
    return askedQuestion.questionId;
  });
  const answerOutcome = await flow.callAs(recipientId, "slp_answer", { questionId, answer });
  if (answerOutcome.isError) throw new Error(`slp_answer failed: ${answerOutcome.text}`);
  return { askOutcome: await pendingAsk, questionId };
}
