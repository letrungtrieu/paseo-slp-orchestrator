// Reusable story steps for the Lead-authored pipeline protocol. The helpers intentionally
// drive the MCP tools instead of mutating pipeline state, so flow tests cover authentication,
// role checks and the same asynchronous stage handoffs used by real agents.
import { vi } from "vitest";
import type { PipelineDefinition, PipelineState, StageState } from "../../shared/pipeline";
import type { Flow } from "./flow-fixture";
import { commitFiles, runGitSync } from "./git-fixture";

export const DEFAULT_PIPELINE: PipelineDefinition = {
  name: "billing-import",
  version: "1.0",
  worktree: "pipeline-billing-import",
  description: "Implement, review and verify the billing import flow.",
  stages: [
    {
      name: "review-codebase",
      goal: "Understand the existing billing boundaries before changing code.",
      peers: [
        { role: "reviewer", task: "Review the codebase and report its important boundaries." },
        { role: "developer", task: "Prepare a small change plan from the review findings." },
      ],
    },
    {
      name: "coding",
      goal: "Implement the accepted billing import behavior in the shared worktree.",
      peers: [{ role: "developer", task: "Implement the billing import behavior and report evidence." }],
    },
    {
      name: "qa",
      goal: "Exercise the completed behavior and report any quality risks.",
      peers: [{ role: "qa_engineer", task: "Run focused checks and report the observed behavior." }],
    },
  ],
};

export const TWO_PEER_PIPELINE: PipelineDefinition = {
  ...DEFAULT_PIPELINE,
  name: "billing-review",
  stages: [DEFAULT_PIPELINE.stages[0]],
};

export const SECOND_STAGE_PIPELINE: PipelineDefinition = {
  ...DEFAULT_PIPELINE,
  name: "billing-sequential",
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

export async function reportPeer(flow: Flow, runId: string, pipelineId: string, peerRole: string, summary = "Evidence collected"): Promise<void> {
  const stage = currentStage(flow, runId, pipelineId);
  const peerId = flow.agentId(runId, peerRole, stage.id);
  const response = await flow.callAs(peerId, "slp_stage_report", { summary, findings: [summary], status: "completed" });
  if (response.isError) throw new Error(response.text);
}

export async function approveCurrentStage(flow: Flow, runId: string, pipelineId: string, summary = "The stage goal is met."): Promise<void> {
  const approvedStage = currentStage(flow, runId, pipelineId);
  const coordinatorId = flow.agentId(runId, "forked_lead", approvedStage.id);
  const response = await flow.callAs(coordinatorId, "slp_approve_stage", { summary });
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
