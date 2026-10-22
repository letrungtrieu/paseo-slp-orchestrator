// Read projections expose pipeline knowledge while authentication tokens remain private to the daemon.
import type { BusCaller } from "../bus/http-mcp";
import { isPipelineLeadRole } from "../../shared/roles";
import { requirePipeline, publicPipeline } from "./stage-context";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

export function readRun(ctx: PipelineContext, caller: BusCaller): string {
  const run = ctx.store.require(caller.runId);
  // Explicit projections avoid disclosing agent bus tokens through a generic run read while exposing active Leads for collaboration.
  const leads = Object.values(run.agents)
    .filter((agentRecord) => isPipelineLeadRole(agentRecord.role) && !agentRecord.archivedAt)
    .map(({ agentId, role, featureName, worktreePath, pipelineId }) => ({
      agentId,
      // Lets Leads tell the QA Lead apart from feature siblings when choosing whom to consult.
      role,
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
    // The approved spec is the contract every Lead builds and the QA Lead verifies, so any agent can re-read it.
    productSpec: run.productSpec,
    repoPath: run.repoPath,
    baseBranch: run.baseBranch,
    integrationBranch: run.integrationBranch,
    // The QA worktree once delegated: the merge target of every feature Lead.
    leadWorktree: run.devCwd,
    qaLeadAgentId: run.qaLeadAgentId || null,
    finalReport: run.finalReport,
    supervisorReport: run.supervisorReport,
    leads,
    pipelines: Object.values(run.pipelines).map(({ id, name, kind, status, worktree, leadAgentId, currentStageIndex }) => ({
      id,
      name,
      kind,
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
      kind: pipeline.kind,
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
