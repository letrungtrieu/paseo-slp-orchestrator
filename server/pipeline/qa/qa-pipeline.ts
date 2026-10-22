// QA pipelines run in place on the QA branch: there is no separate pipeline branch, so defining one reuses the
// QA worktree and finalizing one closes it without a merge before handing slp_report to the QA Lead.
import type { BusCaller } from "../../bus/http-mcp";
import type { PipelineInputDefinition, PipelineState } from "../../../shared/pipeline";
import type { Run } from "../../../shared/state";
import { runGit } from "../../git/git";
import type { PipelineContext } from "../context";
import { requirePipeline } from "../stage-context";
import { ToolError } from "../tool-error";
import { completedPipeline, requireCleanWorktree } from "../worktree-checks";
import { isQaPhaseActive, isQaPipeline, qaPipelinesOf } from "./qa-phase-state";

export interface QaPipelineWorkspace {
  workspaceId: string;
  cwd: string;
  branch: string;
  baseCommit: string;
}

export function assertQaPipelineDefinitionAllowed(
  run: Run,
  callerAgentId: string,
  definitions: readonly PipelineInputDefinition[],
): void {
  if (callerAgentId !== run.qaLeadAgentId) throw new ToolError("Only this run's current QA Lead can define QA pipelines.");
  // Testing a partially merged branch would miss cross-feature defects and waste heavy-resource runs.
  if (!isQaPhaseActive(run)) {
    throw new ToolError("Feature branches are still being merged into the QA branch. Keep preparing your QA plan; the engine hands the merged branch to you when every feature Lead has finished.");
  }
  // Two QA pipelines would share one worktree and one set of heavy resources, so they run strictly one after another.
  if (definitions.length !== 1) throw new ToolError("Define exactly one QA pipeline at a time.");
  const activeQaPipeline = qaPipelinesOf(run).find((pipeline) => !["integrated", "failed"].includes(pipeline.status));
  if (activeQaPipeline) {
    throw new ToolError(`QA pipeline '${activeQaPipeline.name}' is still ${activeQaPipeline.status}; finish or close it before defining another.`);
  }
  // Models often copy feature examples that pass a worktree; accept the QA worktree itself, reject anything else.
  const requestedWorktree = definitions[0].worktree?.trim();
  if (requestedWorktree && requestedWorktree !== run.devCwd) {
    throw new ToolError(`QA pipelines always run in the QA worktree '${run.devCwd}'; omit worktree.`);
  }
}

export async function qaPipelineWorkspace(run: Run): Promise<QaPipelineWorkspace> {
  // The base commit records exactly which merged state the QA peers started verifying.
  const baseCommit = (await runGit(run.devCwd, ["rev-parse", "HEAD"])).trim();
  return { workspaceId: run.devWorkspaceId, cwd: run.devCwd, branch: run.integrationBranch, baseCommit };
}

function closedQaPipelineResult(pipeline: PipelineState): string {
  // mergedCommit doubles as the verified commit so the UI's integrated-pipeline row shows exactly what QA checked.
  return JSON.stringify({
    pipelineId: pipeline.id,
    status: pipeline.status,
    verifiedCommit: pipeline.mergedCommit,
    integratedAt: pipeline.integratedAt,
    nextAction: "QA pipeline closed on the QA branch. Call slp_report now with the tested scope, results with metrics, evidence paths and known issues.",
  });
}

export async function finalizeQaPipeline(
  ctx: PipelineContext,
  caller: BusCaller,
  pipelineId: string,
  summary: string,
): Promise<string> {
  const run = ctx.store.require(caller.runId);
  const pipeline = requirePipeline(run, pipelineId);
  if (!isQaPipeline(pipeline)) throw new ToolError(`Pipeline '${pipeline.name}' is not a QA pipeline.`);
  // A retried call after success returns the durable result instead of archiving peers twice.
  if (pipeline.status === "integrated") return closedQaPipelineResult(pipeline);
  if (caller.agentId !== run.qaLeadAgentId) throw new ToolError("Only this run's current QA Lead can close its QA pipeline.");
  if (run.status !== "running") throw new ToolError(`Cannot finalize a pipeline while run is '${run.status}'.`);
  if (!completedPipeline(pipeline)) throw new ToolError("Every QA stage must be completed and approved first.");
  if (pipeline.gate) throw new ToolError("Approve the pipeline's human gate before closing it.");
  // Fixes made by QA peers ship with the QA branch, so anything left uncommitted would silently miss the Supervisor's merge.
  await requireCleanWorktree(run.devCwd, "QA worktree", true);
  const verifiedCommit = (await runGit(run.devCwd, ["rev-parse", "HEAD"])).trim();
  const qaPeerIds = Object.values(ctx.store.require(caller.runId).agents)
    .filter((agentRecord) => agentRecord.pipelineId === pipelineId && agentRecord.role === "peer" && !agentRecord.archivedAt)
    .map((agentRecord) => agentRecord.agentId);
  // QA peers often hold heavy tools open; releasing them before the report frees the host for the Supervisor's review.
  for (const qaPeerId of qaPeerIds) {
    await ctx.gateway.archive(qaPeerId).catch(() => undefined);
  }
  const closedAt = new Date().toISOString();
  ctx.store.mutate(caller.runId, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipelineId);
    mutablePipeline.status = "integrated";
    mutablePipeline.mergedCommit = verifiedCommit;
    mutablePipeline.integratedAt = closedAt;
    mutablePipeline.finalReport = summary;
    mutablePipeline.pausedReason = null;
    mutablePipeline.updatedAt = closedAt;
    const qaLeadRecord = mutableRun.agents[caller.agentId];
    // Keep the active turn's timestamp so the sweeper nudges only if this same turn ends without slp_report.
    const activeTurnSince = qaLeadRecord?.awaitingSince ?? closedAt;
    for (const agentRecord of Object.values(mutableRun.agents)) {
      if (agentRecord.pipelineId !== pipelineId) continue;
      agentRecord.awaitingTool = null;
      agentRecord.awaitingSince = null;
      agentRecord.nudges = 0;
      agentRecord.waitingForAgentId = null;
      agentRecord.deferredTool = null;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => mutableRun.agents[queuedMessage.toAgentId]?.pipelineId !== pipelineId,
    );
    if (qaLeadRecord) {
      qaLeadRecord.pipelineId = null;
      qaLeadRecord.stageId = null;
      qaLeadRecord.awaitingTool = "slp_report";
      qaLeadRecord.awaitingSince = activeTurnSince;
      qaLeadRecord.nudges = 0;
    }
  });
  ctx.logEvent(caller.runId, {
    taskId: null,
    from: caller.agentId,
    to: "pipeline",
    kind: "pipeline.qa_closed",
    summary: `${pipeline.name}: ${verifiedCommit}`,
    outcome: "delivered",
  });
  return closedQaPipelineResult(requirePipeline(ctx.store.require(caller.runId), pipelineId));
}
