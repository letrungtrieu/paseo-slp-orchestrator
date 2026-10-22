// Pipeline finalization verifies both checkouts before merging the pipeline branch into integration.
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { currentBranchName, runGit } from "../git/git";
import { retireIntegratedPipelineWorkspace } from "./agent-hierarchy";
import type { PipelineContext } from "./context";
import { requirePipeline } from "./stage-context";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";
import { completedPipeline, requireCleanWorktree } from "./worktree-checks";
import { applyQaHandover, retireIdleFeatureLeads, retireMergingLeadWhenIdle } from "./qa/qa-handover";
import { finalizeQaPipeline } from "./qa/qa-pipeline";
import { allFeaturePipelinesIntegrated, isQaPipeline, runHasQaLead } from "./qa/qa-phase-state";

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

// Build actionable conflict guidance listing pipeline Peers and sibling Leads so the Lead can consult them before resolving.
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
  const siblingLeadContacts = Object.values(run.pipelines)
    .filter((candidatePipeline) => candidatePipeline.id !== pipeline.id)
    .flatMap((siblingPipeline) => {
      const siblingCoordinatorId =
        (siblingPipeline.leadAgentId && !run.agents[siblingPipeline.leadAgentId]?.archivedAt
          ? siblingPipeline.leadAgentId
          : null) ??
        [...siblingPipeline.stages]
          .reverse()
          .map((siblingStage) => siblingStage.forkedLeadAgentId)
          .find((coordinatorId): coordinatorId is string => Boolean(coordinatorId && !run.agents[coordinatorId]?.archivedAt));
      return siblingCoordinatorId ? [`${siblingPipeline.name} -> Lead (${siblingCoordinatorId})`] : [];
    });
  const consultationHints = [
    pipelinePeerContacts.length > 0
      ? `Pipeline Peers to ask if you need context on this pipeline's changes (via slp_send_peer_message): ${pipelinePeerContacts.join(", ")}.`
      : null,
    siblingLeadContacts.length > 0
      ? `Sibling Leads to ask if the conflict involves another feature pipeline (via slp_send_peer_message): ${siblingLeadContacts.join(", ")}.`
      : null,
    `Resolution workflow: consult relevant Peers or sibling Leads if any conflicting logic is unclear, merge '${run.integrationBranch}' into '${pipeline.branch}' inside '${pipeline.worktree}', resolve conflicts and commit cleanly, then call slp_finalize_pipeline again.`,
  ].filter(Boolean).join(" ");
  return `Could not merge pipeline '${pipeline.name}': ${rawErrorMessage}. ${conflictedFilesSummary}. ${consultationHints}`;
}

// Format the consolidated summary handed to the primary Lead once every active pipeline has been merged into integrationBranch.
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
    "## Next Action for Lead",
    "1. Review the integrated codebase in the integration branch.",
    "2. Once you have verified that all integrated features work together and meet the overall acceptance criteria, call `slp_report` to hand the result to the Supervisor.",
  ].join("\n\n");
}

function integratedResult(pipeline: PipelineState, allIntegrated = true, isPrimaryLeadCaller = true, hasQaLead = false): string {
  // With a QA Lead, a feature Lead's job ends at the merge: verification and reporting belong to the QA Lead.
  const qaNextAction = allIntegrated
    ? "Pipeline branch merged into the QA branch. Every feature is merged, so the QA Lead now verifies the combined build and reports to the Supervisor. End your turn."
    : "Pipeline branch merged into the QA branch. Keep your session idle in case sibling Leads consult you on merge conflicts before every feature is merged.";
  const nextAction = hasQaLead ? qaNextAction : !isPrimaryLeadCaller
    ? allIntegrated
      ? "Pipeline branch merged into integration. Consolidated summaries have been attached and handed to the primary Lead. End your turn."
      : "Pipeline branch merged into integration. Keep your session idle in case sibling Leads consult you on merge conflicts before all pipelines finish."
    : allIntegrated
      ? "All defined pipelines are integrated. Verify the combined result, then call slp_report in this turn."
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
  // Prevent a sibling Lead from accidentally finalizing a pipeline owned by another Lead unless primary Lead explicitly targets it.
  const isPrimaryLeadWithExplicitId = caller.agentId === initialRun.masterLeadAgentId && Boolean(rawPipelineId);
  if (!isPrimaryLeadWithExplicitId && callerAgentRecord?.pipelineId && callerAgentRecord.pipelineId !== pipelineId) {
    throw new ToolError(`Lead for pipeline '${callerAgentRecord.pipelineId}' cannot finalize pipeline '${pipelineId}'.`);
  }
  const initialPipeline = requirePipeline(initialRun, pipelineId);
  // QA pipelines already live on the QA branch, so closing them is a separate path with nothing to merge.
  if (isQaPipeline(initialPipeline)) {
    return withRunFinalizeLock(runId, () => finalizeQaPipeline(ctx, caller, pipelineId, summary));
  }
  if (callerAgentRecord?.role === "qa_lead") {
    throw new ToolError("The QA Lead only closes QA pipelines; feature Leads merge their own branches.");
  }
  const isPrimaryLeadCaller = caller.agentId === initialRun.masterLeadAgentId;
  const hasQaLead = runHasQaLead(initialRun);
  // Retried tool calls after a successful merge return the durable result instead of creating a
  // second merge commit or sending duplicate completion mail.
  if (initialPipeline.status === "integrated") {
    return integratedResult(initialPipeline, allFeaturePipelinesIntegrated(initialRun), isPrimaryLeadCaller, hasQaLead);
  }
  return withRunFinalizeLock(runId, async () => {
    const run = ctx.store.require(runId);
    const pipeline = requirePipeline(run, pipelineId);
    if (pipeline.status === "integrated") {
      return integratedResult(pipeline, allFeaturePipelinesIntegrated(run), caller.agentId === run.masterLeadAgentId, hasQaLead);
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
    // Pipeline worktrees must be completely clean (including untracked files), while the Lead checkout only requires clean tracked files.
    await requireCleanWorktree(pipeline.worktree, "Pipeline worktree", true);
    await requireCleanWorktree(run.devCwd, "Lead worktree", false);
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
      // Capture conflicted file paths before aborting the merge so the Lead knows which files and peers/sibling Leads to consult.
      const conflictedFilesOutput = await runGit(run.devCwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      await runGit(run.devCwd, ["merge", "--abort"]).catch(() => undefined);
      throw new ToolError(formatMergeConflictGuidance(run, pipeline, conflictedFilesOutput, mergeError));
    }
    try {
      await runGit(run.devCwd, ["merge-base", "--is-ancestor", pipeline.branch, "HEAD"]);
    } catch (verificationError) {
      throw new ToolError(`Merged branch verification failed for '${pipeline.name}': ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`);
    }
    await requireCleanWorktree(run.devCwd, "Lead worktree after merge", false);
    mergedCommit = (await runGit(run.devCwd, ["rev-parse", "HEAD"])).trim();
    if (!mergedCommit) throw new ToolError("The integration merge did not produce a commit hash.");

    const preArchiveRun = ctx.store.require(runId);
    const willAllPipelinesBeIntegrated = allFeaturePipelinesIntegrated(preArchiveRun, pipelineId);
    const remainingPipelineAgents = Object.values(preArchiveRun.agents).filter(
      (agentRecord) => agentRecord.pipelineId === pipelineId && !agentRecord.archivedAt,
    );
    // Close all peers of this integrated pipeline first so parent archival never cascades to active children.
    for (const peerRecord of remainingPipelineAgents.filter((agentRecord) => agentRecord.role === "peer")) {
      await ctx.gateway.archive(peerRecord.agentId).catch(() => undefined);
    }
    if (willAllPipelinesBeIntegrated && hasQaLead) {
      await retireIdleFeatureLeads(ctx, runId, caller.agentId);
    } else if (willAllPipelinesBeIntegrated) {
      // Once the final pipeline integrates, archive all sibling Leads while keeping the primary Lead alive to verify and report.
      const siblingLeadsToArchive = Object.values(ctx.store.require(runId).agents).filter(
        (agentRecord) =>
          agentRecord.role === "master_lead" &&
          agentRecord.agentId !== preArchiveRun.masterLeadAgentId &&
          !agentRecord.archivedAt,
      );
      for (const siblingLeadRecord of siblingLeadsToArchive) {
        await ctx.gateway.archive(siblingLeadRecord.agentId).catch(() => undefined);
      }
    }
    // Clean up the merged pipeline's owned worktree and delete its local slp/* branch immediately so temporary branches never persist or get pushed.
    await retireIntegratedPipelineWorkspace(ctx, runId, pipelineId, willAllPipelinesBeIntegrated);
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
      // Preserve the active turn's obligation timestamp before clearing pipeline-scoped obligations below.
      const previousPrimaryLeadAwaitingSince =
        mutableRun.agents[mutableRun.masterLeadAgentId]?.awaitingSince ??
        mutableRun.agents[caller.agentId]?.awaitingSince ??
        null;
      // Clear any remaining obligation and queued mail on this pipeline's agents now that integration succeeded.
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
      allIntegrated = allFeaturePipelinesIntegrated(mutableRun);
      if (mutableRun.status === "running" && allIntegrated && hasQaLead) {
        applyQaHandover(mutableRun);
      } else if (mutableRun.status === "running" && allIntegrated) {
        // If the original primary Lead was archived earlier, promote the calling unarchived Lead to deliver slp_report.
        const currentPrimaryLead = mutableRun.agents[mutableRun.masterLeadAgentId];
        if (
          (!currentPrimaryLead || currentPrimaryLead.archivedAt) &&
          mutableRun.agents[caller.agentId]?.role === "master_lead" &&
          !mutableRun.agents[caller.agentId]?.archivedAt
        ) {
          mutableRun.masterLeadAgentId = caller.agentId;
        }
        const primaryLeadRecord = mutableRun.agents[mutableRun.masterLeadAgentId];
        if (primaryLeadRecord) {
          // Detach the completed pipeline pointer while preserving the Lead's live workspace for verification and reporting.
          primaryLeadRecord.pipelineId = null;
          primaryLeadRecord.stageId = null;
          primaryLeadRecord.worktreePath = primaryLeadRecord.worktreePath || mutableRun.devCwd;
          primaryLeadRecord.workspaceId = primaryLeadRecord.workspaceId || mutableRun.devWorkspaceId;
        }
        if (caller.agentId !== mutableRun.masterLeadAgentId) {
          // Attach the consolidated summaries from all Leads and wake the primary Lead to verify and report to Supervisor.
          mutableRun.mailbox.push(
            stageMail(mutableRun.masterLeadAgentId, masterLeadIntegrationHandover(mutableRun), "slp_report"),
          );
        } else if (primaryLeadRecord) {
          // Stamp slp_report directly on the calling primary Lead while keeping its active turn timestamp so turn_ended nudges if omitted.
          primaryLeadRecord.awaitingTool = "slp_report";
          primaryLeadRecord.awaitingSince = previousPrimaryLeadAwaitingSince ?? integratedAt;
          primaryLeadRecord.nudges = 0;
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
    if (allIntegrated && hasQaLead) retireMergingLeadWhenIdle(ctx, runId, caller.agentId);
    const finalRunSnapshot = ctx.store.require(runId);
    return integratedResult(finalRunSnapshot.pipelines[pipelineId], allIntegrated, caller.agentId === finalRunSnapshot.masterLeadAgentId, hasQaLead);
  });
}
