// Pipeline finalization verifies both checkouts before merging the pipeline branch into integration.
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { currentBranchName, runGit } from "../git/git";
import type { PipelineContext } from "./context";
import { requirePipeline } from "./stage-context";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";

// Serialize concurrent merge calls per run so parallel Forked Leads finishing at the same time merge sequentially without failing on a lock error.
const finalizingRunLocks = new Map<string, Promise<unknown>>();

async function withRunFinalizeLock<ResultType>(runId: string, operation: () => Promise<ResultType>): Promise<ResultType> {
  const previousLock = finalizingRunLocks.get(runId) ?? Promise.resolve();
  const currentExecution = previousLock.catch(() => undefined).then(operation);
  finalizingRunLocks.set(runId, currentExecution);
  try {
    return await currentExecution;
  } finally {
    if (finalizingRunLocks.get(runId) === currentExecution) {
      finalizingRunLocks.delete(runId);
    }
  }
}

async function requireCleanWorktree(worktreePath: string, label: string): Promise<void> {
  const porcelainStatus = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (porcelainStatus.trim()) throw new ToolError(`${label} has uncommitted or untracked files.`);
}

function completedPipeline(pipeline: PipelineState): boolean {
  return pipeline.status === "completed"
    && pipeline.stages.length > 0
    && pipeline.stages.every((stage) => stage.status === "completed" && stage.result !== null);
}

// Build actionable conflict guidance listing pipeline Peers and sibling Forked Leads so the Forked Lead can consult them before resolving.
function formatMergeConflictGuidance(
  run: Run,
  pipeline: PipelineState,
  conflictedFilesOutput: string,
  mergeError: unknown,
): string {
  const rawErrorMessage = mergeError instanceof Error ? mergeError.message : String(mergeError);
  const conflictedFileList = conflictedFilesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const conflictedFilesSummary = conflictedFileList.length > 0
    ? `Conflicted files: ${conflictedFileList.join(", ")}`
    : "Inspect git status/diff to identify conflicting hunks.";
  const pipelinePeerContacts = pipeline.stages.flatMap((completedStage) =>
    completedStage.peerAgentIds.flatMap((peerAgentId, peerIndex) => {
      if (!peerAgentId || run.agents[peerAgentId]?.archivedAt) return [];
      const peerAssignment = completedStage.peers[peerIndex];
      return [`${peerAssignment?.role ?? "peer"} (${peerAgentId}, stage '${completedStage.name}')`];
    }),
  );
  const siblingForkedLeadContacts = Object.values(run.pipelines)
    .filter((candidatePipeline) => candidatePipeline.id !== pipeline.id)
    .flatMap((siblingPipeline) => {
      const siblingCoordinatorId = [...siblingPipeline.stages]
        .reverse()
        .map((siblingStage) => siblingStage.forkedLeadAgentId)
        .find((coordinatorId): coordinatorId is string => Boolean(coordinatorId && !run.agents[coordinatorId]?.archivedAt));
      return siblingCoordinatorId ? [`${siblingPipeline.name} -> Forked Lead (${siblingCoordinatorId})`] : [];
    });
  const consultationHints = [
    pipelinePeerContacts.length > 0
      ? `Pipeline Peers to ask if you need context on this pipeline's changes (via slp_send_peer_message): ${pipelinePeerContacts.join(", ")}.`
      : null,
    siblingForkedLeadContacts.length > 0
      ? `Sibling Forked Leads to ask if the conflict involves another feature pipeline (via slp_send_peer_message): ${siblingForkedLeadContacts.join(", ")}.`
      : null,
    `Resolution workflow: consult relevant Peers or sibling Forked Leads if any conflicting logic is unclear, merge '${run.integrationBranch}' into '${pipeline.branch}' inside '${pipeline.worktree}', resolve conflicts and commit cleanly, then call slp_finalize_pipeline again.`,
  ].filter(Boolean).join(" ");
  return `Could not merge pipeline '${pipeline.name}': ${rawErrorMessage}. ${conflictedFilesSummary}. ${consultationHints}`;
}

// Format the consolidated summary handed to the Master Lead once every active pipeline has been merged into integrationBranch.
function masterLeadIntegrationHandover(run: Run): string {
  const integratedPipelineSummaries = Object.values(run.pipelines).map((integratedPipeline) =>
    [
      `### Pipeline: ${integratedPipeline.name} (\`${integratedPipeline.id}\`)`,
      `- **Branch**: \`${integratedPipeline.branch ?? "n/a"}\` -> \`${run.integrationBranch}\` (commit \`${integratedPipeline.mergedCommit ?? "n/a"}\`)`,
      `- **Consolidated Summary**: ${integratedPipeline.finalReport ?? "Integrated."}`,
    ].join("\n"),
  );
  return [
    `All pipelines have been verified and merged into integration branch \`${run.integrationBranch}\` (\`${run.devCwd}\`).`,
    "## Consolidated Pipeline Summaries",
    integratedPipelineSummaries.join("\n\n"),
    "## Next Action for Master Lead",
    "1. Review the integrated codebase in your integration worktree (`run.devCwd`).",
    "2. **Optional Autonomous End-User UAT Team**: If end-to-end user acceptance testing across the combined features is warranted before final delivery, spawn an End-User UAT pipeline (`slp_create_worktree` + `slp_define_pipeline` using `end-user` or `qa-engineer` peers) to test the integrated application as a real end user.",
    "3. Once you have verified that all integrated features work together and meet the overall acceptance criteria, call `slp_report` to hand the result to the Supervisor.",
  ].join("\n\n");
}

function integratedResult(pipeline: PipelineState, allIntegrated = true, callerRole: BusCaller["role"] = "master_lead"): string {
  const nextAction = callerRole === "forked_lead"
    ? allIntegrated
      ? "Pipeline branch merged into integration. Consolidated summaries have been attached and handed to the Master Lead. End your turn."
      : "Pipeline branch merged into integration. Keep your session idle in case sibling Forked Leads consult you on merge conflicts before all pipelines finish."
    : allIntegrated
      ? "All defined pipelines are integrated. Verify the combined result (or spawn an End-User UAT pipeline if needed), then call slp_report in this turn."
      : "Other pipelines still need integration; continue coordinating them before calling slp_report.";
  return JSON.stringify({
    pipelineId: pipeline.id,
    status: pipeline.status,
    mergedCommit: pipeline.mergedCommit,
    integratedAt: pipeline.integratedAt,
    nextAction,
  });
}

export async function finalizePipeline(
  ctx: PipelineContext,
  caller: BusCaller,
  rawPipelineId: string | undefined,
  summary: string,
): Promise<string> {
  const runId = caller.runId;
  const initialRun = ctx.store.require(runId);
  const callerAgentRecord = initialRun.agents[caller.agentId];
  const pipelineId = rawPipelineId ?? callerAgentRecord?.pipelineId ?? null;
  if (!pipelineId) throw new ToolError("Pipeline id is required.");
  // Prevent a Forked Lead from accidentally finalizing a sibling pipeline that belongs to another coordinator.
  if (caller.role === "forked_lead" && callerAgentRecord?.pipelineId && callerAgentRecord.pipelineId !== pipelineId) {
    throw new ToolError(`Forked Lead for pipeline '${callerAgentRecord.pipelineId}' cannot finalize pipeline '${pipelineId}'.`);
  }
  const initialPipeline = requirePipeline(initialRun, pipelineId);
  // Retried tool calls after a successful merge return the durable result instead of creating a
  // second merge commit or sending duplicate completion mail.
  if (initialPipeline.status === "integrated") {
    const allPipelinesDone = Object.values(initialRun.pipelines).every((candidate) => candidate.status === "integrated");
    return integratedResult(initialPipeline, allPipelinesDone, caller.role);
  }
  return withRunFinalizeLock(runId, async () => {
    const run = ctx.store.require(runId);
    const pipeline = requirePipeline(run, pipelineId);
    if (pipeline.status === "integrated") {
      const allPipelinesDone = Object.values(run.pipelines).every((candidate) => candidate.status === "integrated");
      return integratedResult(pipeline, allPipelinesDone, caller.role);
    }
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
      // Capture conflicted file paths before aborting the merge so the Forked Lead knows which files and peers/Forked Leads to consult.
      const conflictedFilesOutput = await runGit(run.devCwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      await runGit(run.devCwd, ["merge", "--abort"]).catch(() => undefined);
      throw new ToolError(formatMergeConflictGuidance(run, pipeline, conflictedFilesOutput, mergeError));
    }
    try {
      await runGit(run.devCwd, ["merge-base", "--is-ancestor", pipeline.branch, "HEAD"]);
    } catch (verificationError) {
      throw new ToolError(`Merged branch verification failed for '${pipeline.name}': ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`);
    }
    await requireCleanWorktree(run.devCwd, "Lead worktree after merge");
    mergedCommit = (await runGit(run.devCwd, ["rev-parse", "HEAD"])).trim();
    if (!mergedCommit) throw new ToolError("The integration merge did not produce a commit hash.");

    const preArchiveRun = ctx.store.require(runId);
    const willAllPipelinesBeIntegrated = Object.values(preArchiveRun.pipelines).every(
      (candidatePipeline) => candidatePipeline.id === pipelineId || candidatePipeline.status === "integrated",
    );
    const finalStageCoordinatorId = pipeline.stages.at(-1)?.forkedLeadAgentId ?? null;
    const remainingPipelineAgents = Object.values(preArchiveRun.agents).filter(
      (agentRecord) => agentRecord.pipelineId === pipelineId && !agentRecord.archivedAt,
    );
    // Close all peers of this integrated pipeline first so parent archival never cascades to active children.
    for (const peerRecord of remainingPipelineAgents.filter((agentRecord) => agentRecord.role === "peer")) {
      await ctx.gateway.archive(peerRecord.agentId).catch(() => undefined);
    }
    if (willAllPipelinesBeIntegrated) {
      // Once the final pipeline integrates, archive all remaining Forked Leads across every integrated pipeline.
      const allRemainingPipelineCoordinators = Object.values(ctx.store.require(runId).agents).filter(
        (agentRecord) => agentRecord.role === "forked_lead" && agentRecord.pipelineId !== null && !agentRecord.archivedAt,
      );
      for (const coordinatorRecord of allRemainingPipelineCoordinators) {
        await ctx.gateway.archive(coordinatorRecord.agentId).catch(() => undefined);
      }
    } else {
      // Keep the final stage's Forked Lead alive while sibling pipelines are still running so they can consult it on cross-feature conflicts.
      for (const coordinatorRecord of remainingPipelineAgents.filter(
        (agentRecord) => agentRecord.role === "forked_lead" && agentRecord.agentId !== finalStageCoordinatorId,
      )) {
        await ctx.gateway.archive(coordinatorRecord.agentId).catch(() => undefined);
      }
    }
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
      // Clear any remaining obligation on this pipeline's agents now that integration succeeded.
      for (const agentRecord of Object.values(mutableRun.agents)) {
        if (agentRecord.pipelineId !== pipelineId) continue;
        agentRecord.awaitingTool = null;
        agentRecord.awaitingSince = null;
        agentRecord.nudges = 0;
        agentRecord.waitingForAgentId = null;
        agentRecord.deferredTool = null;
      }
      allIntegrated = Object.values(mutableRun.pipelines).every((candidate) => candidate.status === "integrated");
      if (mutableRun.status === "running" && allIntegrated) {
        if (caller.role === "forked_lead") {
          // Attach the consolidated summaries from all Forked Leads and wake the Master Lead to run UAT or report to Supervisor.
          mutableRun.mailbox.push(
            stageMail(mutableRun.masterLeadAgentId, masterLeadIntegrationHandover(mutableRun), "slp_report"),
          );
        } else {
          // Stamp slp_report directly on the calling Master Lead instead of sending a self-mail that wastes an extra turn.
          const masterLeadRecord = mutableRun.agents[mutableRun.masterLeadAgentId];
          if (masterLeadRecord) {
            masterLeadRecord.awaitingTool = "slp_report";
            masterLeadRecord.awaitingSince = integratedAt;
            masterLeadRecord.nudges = 0;
          }
        }
      }
    });
    ctx.logEvent(runId, {
      taskId: null,
      from: caller.agentId,
      to: "pipeline",
      kind: "pipeline.integrated",
      summary: `${pipeline.name}: ${mergedCommit}`,
      outcome: "delivered",
    });
    return integratedResult(ctx.store.require(runId).pipelines[pipelineId], allIntegrated, caller.role);
  });
}
