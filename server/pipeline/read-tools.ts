// Read projections expose pipeline knowledge while authentication tokens remain private to the daemon.
import type { BusCaller } from "../bus/http-mcp";
import { requirePipeline, publicPipeline } from "./stage-context";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

export function readRun(ctx: PipelineContext, caller: BusCaller): string {
  const run = ctx.store.require(caller.runId);
  // Explicit projections avoid disclosing agent bus tokens through a generic run read while exposing active Leads for collaboration.
  const leads = Object.values(run.agents)
    .filter((agentRecord) => agentRecord.role === "master_lead" && !agentRecord.archivedAt)
    .map(({ agentId, featureName, worktreePath, pipelineId }) => ({
      agentId,
      featureName,
      worktreePath,
      pipelineId,
    }));
  return JSON.stringify({
    id: run.id,
    title: run.title,
    status: run.status,
    mode: run.mode,
    criteria: run.criteria,
    repoPath: run.repoPath,
    baseBranch: run.baseBranch,
    integrationBranch: run.integrationBranch,
    leadWorktree: run.devCwd,
    finalReport: run.finalReport,
    supervisorReport: run.supervisorReport,
    leads,
    pipelines: Object.values(run.pipelines).map(({ id, name, status, worktree, leadAgentId, currentStageIndex }) => ({
      id,
      name,
      status,
      worktree,
      leadAgentId,
      currentStageIndex,
    })),
  });
}

export function listPipelines(ctx: PipelineContext, caller: BusCaller): string {
  // Summaries make coordination cheap and expose Lead and Peer IDs for cross-Lead and cross-stage consultation.
  return JSON.stringify({
    pipelines: Object.values(ctx.store.require(caller.runId).pipelines).map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      version: pipeline.version,
      description: pipeline.description,
      worktree: pipeline.worktree,
      branch: pipeline.branch,
      leadAgentId: pipeline.leadAgentId,
      status: pipeline.status,
      currentStageIndex: pipeline.currentStageIndex,
      stages: pipeline.stages.map(({ id, name, goal, status, forkedLeadAgentId, peerAgentIds }) => ({
        id,
        name,
        goal,
        status,
        forkedLeadAgentId,
        peerAgentIds,
      })),
    })),
  });
}

export function readPipeline(ctx: PipelineContext, caller: BusCaller, pipelineId?: string): string {
  const run = ctx.store.require(caller.runId);
  const selectedId = pipelineId ?? run.agents[caller.agentId]?.pipelineId;
  // Stage agents know their assignment; top-level agents must choose explicitly rather than guessing.
  if (!selectedId) throw new ToolError("Provide pipelineId or use slp_list_pipelines.");
  return JSON.stringify(publicPipeline(requirePipeline(run, selectedId)));
}
