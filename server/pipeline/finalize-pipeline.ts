// Pipeline finalization verifies both checkouts before merging the Lead's branch into integration.
import type { PipelineState } from "../../shared/pipeline";
import { currentBranchName, runGit } from "../git/git";
import type { PipelineContext } from "./context";
import { requirePipeline } from "./stage-context";
import { ToolError } from "./tool-error";

// A run-level lock prevents two concurrent Lead turns from merging the same integration branch.
const finalizingRuns = new Set<string>();

async function requireCleanWorktree(worktreePath: string, label: string): Promise<void> {
  const porcelainStatus = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (porcelainStatus.trim()) throw new ToolError(`${label} has uncommitted or untracked files.`);
}

function completedPipeline(pipeline: PipelineState): boolean {
  return pipeline.status === "completed"
    && pipeline.stages.length > 0
    && pipeline.stages.every((stage) => stage.status === "completed" && stage.result !== null);
}

function integratedResult(pipeline: PipelineState, allIntegrated = true): string {
  return JSON.stringify({
    pipelineId: pipeline.id,
    status: pipeline.status,
    mergedCommit: pipeline.mergedCommit,
    integratedAt: pipeline.integratedAt,
    nextAction: allIntegrated
      ? "All defined pipelines are integrated. Verify the combined result, then call slp_report in this turn."
      : "Other pipelines still need integration; continue coordinating them before calling slp_report.",
  });
}

export async function finalizePipeline(
  ctx: PipelineContext,
  runId: string,
  pipelineId: string,
  summary: string,
): Promise<string> {
  const initialRun = ctx.store.require(runId);
  const initialPipeline = requirePipeline(initialRun, pipelineId);
  // Retried tool calls after a successful merge return the durable result instead of creating a
  // second merge commit or sending duplicate completion mail.
  if (initialPipeline.status === "integrated") {
    const allPipelinesDone = Object.values(initialRun.pipelines).every((candidate) => candidate.status === "integrated");
    return integratedResult(initialPipeline, allPipelinesDone);
  }
  if (finalizingRuns.has(runId)) throw new ToolError("Another pipeline in this run is being finalized.");
  finalizingRuns.add(runId);
  try {
    const run = ctx.store.require(runId);
    const pipeline = requirePipeline(run, pipelineId);
    if (run.status !== "running") throw new ToolError(`Cannot finalize a pipeline while run is '${run.status}'.`);
    if (!completedPipeline(pipeline)) throw new ToolError("Every pipeline stage must be completed and approved first.");
    if (pipeline.gate) throw new ToolError("Approve the pipeline's human gate before integration.");
    if (!pipeline.branch) throw new ToolError("Pipeline has no source branch.");

    const pipelineBranch = await currentBranchName(pipeline.worktree);
    if (pipelineBranch !== pipeline.branch) {
      throw new ToolError(`Pipeline worktree is on '${pipelineBranch}', expected '${pipeline.branch}'.`);
    }
    const integrationBranch = await currentBranchName(run.devCwd);
    if (integrationBranch !== run.integrationBranch) {
      throw new ToolError(`Lead worktree is on '${integrationBranch}', expected '${run.integrationBranch}'.`);
    }
    // Both source and destination must be clean, including untracked files, before the merge can
    // be attributed to this pipeline and safely retried after a daemon restart.
    await requireCleanWorktree(pipeline.worktree, "Pipeline worktree");
    await requireCleanWorktree(run.devCwd, "Lead worktree");
    // Read-only git checks await subprocesses; cancellation must be observed before starting the merge.
    if (ctx.store.require(runId).status !== "running") throw new ToolError("Run stopped before pipeline integration.");

    let mergedCommit: string;
    try {
      await runGit(run.devCwd, [
        "merge",
        "--no-ff",
        "-m",
        `SLP: merge pipeline ${pipeline.name}`,
        pipeline.branch,
      ]);
    } catch (mergeError) {
      // A failed merge can leave the Lead checkout inside a conflict; abort before returning the
      // error so the Master Lead can recover or retry without manually repairing MERGE_HEAD.
      await runGit(run.devCwd, ["merge", "--abort"]).catch(() => undefined);
      throw new ToolError(`Could not merge pipeline '${pipeline.name}': ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`);
    }
    try {
      await runGit(run.devCwd, ["merge-base", "--is-ancestor", pipeline.branch, "HEAD"]);
    } catch (verificationError) {
      throw new ToolError(`Merged branch verification failed for '${pipeline.name}': ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`);
    }
    await requireCleanWorktree(run.devCwd, "Lead worktree after merge");
    mergedCommit = (await runGit(run.devCwd, ["rev-parse", "HEAD"])).trim();
    if (!mergedCommit) throw new ToolError("The integration merge did not produce a commit hash.");

    const integratedAt = new Date().toISOString();
    let allIntegrated = false;
    ctx.store.mutate(runId, (mutableRun) => {
      const mutablePipeline = requirePipeline(mutableRun, pipelineId);
      mutablePipeline.status = "integrated";
      mutablePipeline.mergedCommit = mergedCommit;
      mutablePipeline.integratedAt = integratedAt;
      mutablePipeline.finalReport = summary;
      mutablePipeline.pausedReason = null;
      mutablePipeline.gate = null;
      mutablePipeline.updatedAt = integratedAt;
      allIntegrated = Object.values(mutableRun.pipelines).every((candidate) => candidate.status === "integrated");
      // Stamp slp_report directly on the calling Master Lead instead of sending a self-mail that wastes an extra turn.
      if (mutableRun.status === "running" && allIntegrated) {
        const masterLeadRecord = mutableRun.agents[mutableRun.masterLeadAgentId];
        if (masterLeadRecord) {
          masterLeadRecord.awaitingTool = "slp_report";
          masterLeadRecord.awaitingSince = integratedAt;
          masterLeadRecord.nudges = 0;
        }
      }
    });
    ctx.logEvent(runId, {
      taskId: null,
      from: run.masterLeadAgentId,
      to: "pipeline",
      kind: "pipeline.integrated",
      summary: `${pipeline.name}: ${mergedCommit}`,
      outcome: "delivered",
    });
    return integratedResult(ctx.store.require(runId).pipelines[pipelineId], allIntegrated);
  } finally {
    finalizingRuns.delete(runId);
  }
}
