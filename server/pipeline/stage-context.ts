// Stage identity is derived from authenticated agent records so peers cannot act on a sibling pipeline.
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineState } from "../../shared/pipeline";
import { isPipelineLeadRole } from "../../shared/roles";
import type { Run } from "../../shared/state";
import type { PipelineContext } from "./context";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";
import { fallbackLeadIdFor } from "./qa/qa-phase-state";

export function requirePipeline(run: Run, pipelineId: string): PipelineState {
  const pipeline = Object.hasOwn(run.pipelines, pipelineId) ? run.pipelines[pipelineId] : undefined;
  if (!pipeline) throw new ToolError(`Unknown pipeline '${pipelineId}'. Use slp_list_pipelines.`);
  return pipeline;
}

export function stageForCaller(ctx: PipelineContext, caller: BusCaller) {
  const run = ctx.store.require(caller.runId);
  const agent = run.agents[caller.agentId];
  // Persisted records from completed stages remain audit evidence, never an authorization to submit again.
  if (!agent || agent.archivedAt || !agent.pipelineId || !agent.stageId) throw new ToolError("This tool requires an active stage assignment.");
  const pipeline = requirePipeline(run, agent.pipelineId);
  const stage = pipeline.stages[pipeline.currentStageIndex];
  if (run.status !== "running" || pipeline.status !== "running" || !stage || stage.id !== agent.stageId || stage.status !== "running") {
    throw new ToolError("Your stage is no longer running. Read slp_get_pipeline for its current state.");
  }
  const belongsToStage =
    isPipelineLeadRole(agent.role)
      ? stage.forkedLeadAgentId === caller.agentId || pipeline.leadAgentId === caller.agentId
      : stage.peerAgentIds.includes(caller.agentId);
  if (!belongsToStage) throw new ToolError("Agent is not a participant of this stage.");
  return { run, pipeline, stage, agent };
}

export function requireStageLead(ctx: PipelineContext, caller: BusCaller) {
  const assignment = stageForCaller(ctx, caller);
  // Goal approval belongs only to this stage's Lead, independently of any peer's business role name.
  if (!isPipelineLeadRole(assignment.agent.role)) throw new ToolError("Only this stage's Lead can decide completion.");
  return assignment;
}

export function pausePipelineForAgent(ctx: PipelineContext, agentId: string, reason: string): void {
  const lookup = ctx.store.findAgent(agentId);
  if (!lookup || lookup.agentRecord.archivedAt || !lookup.agentRecord.pipelineId) return;
  const pipeline = requirePipeline(lookup.run, lookup.agentRecord.pipelineId);
  if (["completed", "integrated", "failed"].includes(pipeline.status)) return;
  pausePipeline(ctx, lookup.run.id, pipeline.id, reason);
}

export function pausePipeline(ctx: PipelineContext, runId: string, pipelineId: string, reason: string): void {
  const run = ctx.store.require(runId);
  const pipeline = requirePipeline(run, pipelineId);
  const targetLeadId = pipeline.leadAgentId && !run.agents[pipeline.leadAgentId]?.archivedAt
    ? pipeline.leadAgentId
    : fallbackLeadIdFor(run, pipeline);
  ctx.store.mutate(runId, (mutableRun) => {
    const mutablePipeline = mutableRun.pipelines[pipelineId];
    mutablePipeline.status = "paused";
    mutablePipeline.pausedReason = reason;
    mutablePipeline.updatedAt = new Date().toISOString();
    // A recovery decision replaces outstanding conversation waits as well as workflow obligations.
    for (const agent of Object.values(mutableRun.agents)) {
      if (agent.pipelineId !== pipelineId) continue;
      agent.awaitingTool = null;
      agent.awaitingSince = null;
      agent.waitingForAgentId = null;
      agent.deferredTool = null;
    }
    // Persist the notification with the pause so a reload cannot strand a pipeline without its owner knowing.
    mutableRun.mailbox.push(stageMail(targetLeadId,
      `Pipeline ${mutablePipeline.name} (${pipelineId}) paused: ${reason}\nInspect slp_get_pipeline, then use slp_resume_pipeline with a recovery decision.`, "slp_resume_pipeline"));
  });
  ctx.logEvent(runId, { taskId: null, from: "pipeline", to: targetLeadId, kind: "pipeline.paused", summary: `${pipelineId}: ${reason}`, outcome: "blocked" });
}

export function publicPipeline(pipeline: PipelineState) {
  // Pipeline state contains assignments and stage evidence; authentication tokens live only in run.agents.
  return { ...pipeline, completedStages: pipeline.stages.filter((stage) => stage.status === "completed").length };
}
