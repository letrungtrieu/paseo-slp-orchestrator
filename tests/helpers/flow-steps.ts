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

export async function delegateToLead(flow: Flow, runId: string): Promise<void> {
  const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
    acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
  });
  if (delegation.isError) throw new Error(delegation.text);
}

export async function completePeerUnderstand(
  flow: Flow,
  runId: string,
  pipelineId: string,
  summary = "Base peer investigated the project and aligned with Forked Lead on task expectations.",
  definedStages?: PipelineDefinition["stages"],
): Promise<void> {
  await eventually(() => {
    const pipeline = flow.pipeline(runId, pipelineId);
    if (!pipeline) throw new Error("pipeline disappeared before peer_understand");
    if (pipeline.peerUnderstand.status === "completed" || pipeline.status === "paused") return;
    if (
      pipeline.status !== "peer_understand"
      || pipeline.peerUnderstand.status !== "running"
      || !pipeline.peerUnderstand.basePeerAgentId
      || !pipeline.peerUnderstand.forkedLeadAgentId
    ) {
      throw new Error("peer_understand is still starting");
    }
  });
  const currentPipeline = flow.pipeline(runId, pipelineId)!;
  if (currentPipeline.peerUnderstand.status === "completed" || currentPipeline.status === "paused") return;
  const basePeerId = currentPipeline.peerUnderstand.basePeerAgentId!;
  const coordinatorId = currentPipeline.peerUnderstand.forkedLeadAgentId!;
  // Step 1: Forked Lead creates the investigation goal first when not yet set on peerUnderstand.
  if (!currentPipeline.peerUnderstand.investigationGoal) {
    const goalResponse = await flow.callAs(coordinatorId, "slp_send_peer_message", {
      toAgentId: basePeerId,
      message: `Investigate ${currentPipeline.name}: ${currentPipeline.description}`,
      waitForReply: true,
    });
    if (goalResponse.isError) throw new Error(goalResponse.text);
  }
  // Step 2: Base Peer investigates and submits its understanding report to confirm mutual understanding.
  const reportResponse = await flow.callAs(basePeerId, "slp_stage_report", {
    summary,
    findings: [summary],
    status: "completed",
  });
  if (reportResponse.isError) throw new Error(reportResponse.text);
  // Step 3: Once both confirm mutual understanding, Forked Lead creates the pipeline stages (or approves peer_understand).
  const needsStageCreation = definedStages !== undefined || flow.pipeline(runId, pipelineId)!.stages.length === 0;
  if (needsStageCreation) {
    const createStagesResponse = await flow.callAs(coordinatorId, "slp_define_pipeline", {
      pipelineId,
      summary: "Mutual understanding confirmed; creating pipeline stages.",
      stages: definedStages ?? DEFAULT_PIPELINE.stages,
    });
    if (createStagesResponse.isError) throw new Error(createStagesResponse.text);
  } else {
    const approveResponse = await flow.callAs(coordinatorId, "slp_approve_stage", {
      summary: "Base peer understanding approved; checkpointing session for stage peer forks.",
    });
    if (approveResponse.isError) throw new Error(approveResponse.text);
  }
  await eventually(() => {
    const refreshedPipeline = flow.pipeline(runId, pipelineId);
    if (!refreshedPipeline) throw new Error("pipeline disappeared after peer_understand");
    if (refreshedPipeline.status === "paused" || refreshedPipeline.status === "completed") return;
    const firstStage = refreshedPipeline.stages[refreshedPipeline.currentStageIndex];
    if (
      refreshedPipeline.peerUnderstand.status !== "completed"
      || refreshedPipeline.status !== "running"
      || firstStage?.status !== "running"
    ) {
      throw new Error("Stage 1 is still starting after peer_understand approval");
    }
  });
}

export async function definePipeline(
  flow: Flow,
  runId: string,
  definition: PipelineDefinition = DEFAULT_PIPELINE,
  options?: { stopAtPeerUnderstand?: boolean },
): Promise<string> {
  const response = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: definition });
  if (response.isError) throw new Error(response.text);
  const pipelineId = JSON.parse(response.text).pipelineId as string;
  await eventually(() => {
    const pipeline = flow.pipeline(runId, pipelineId);
    if (
      !pipeline
      || pipeline.status === "queued"
      || pipeline.status === "starting"
      || (pipeline.status === "peer_understand" && pipeline.peerUnderstand.status !== "running")
    ) {
      throw new Error("pipeline cohort is still starting");
    }
  });
  if (!options?.stopAtPeerUnderstand && flow.pipeline(runId, pipelineId)?.status === "peer_understand") {
    await completePeerUnderstand(flow, runId, pipelineId);
  }
  return pipelineId;
}

export async function startedRunWithPipeline(
  flow: Flow,
  definition: PipelineDefinition = DEFAULT_PIPELINE,
  options?: { stopAtPeerUnderstand?: boolean },
): Promise<{ runId: string; pipelineId: string }> {
  const runId = await flow.startRun();
  await delegateToLead(flow, runId);
  // The Lead owns the handoff path: the definition carries the concrete checkout returned by
  // slp_create_worktree, so the engine never silently invents a different peer workspace.
  const workspaceResponse = await flow.callAsRole(runId, "master_lead", null, "slp_create_worktree", { name: definition.name });
  if (workspaceResponse.isError) throw new Error(workspaceResponse.text);
  const workspace = JSON.parse(workspaceResponse.text) as { cwd: string };
  const pipelineId = await definePipeline(flow, runId, { ...definition, worktree: workspace.cwd }, options);
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
  if (flow.pipeline(runId, pipelineId)?.peerUnderstand.status !== "completed") {
    await completePeerUnderstand(flow, runId, pipelineId);
  }
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
