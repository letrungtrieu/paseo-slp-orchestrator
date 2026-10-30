// MCP bus tool and UI RPC handlers for submitting and reviewing multi-version HTML/CSS/JS feature mockups.
import {
  deriveFeatureMockupSlug,
  type BoardTicket,
  type MockupElementCommentInput,
} from "../../shared/board";
import type { Run } from "../../shared/state";
import type { BusCaller } from "../bus/http-mcp";
import { formatMockupElementCommentsMarkdown } from "../store/board-mockup-revisions";
import { resolveTargetTicketForCaller } from "./board-tools";
import type { PipelineContext } from "./context";
import {
  snapshotFeatureMockupVersion,
  syncMockupVersionToWorkingDirectory,
} from "./mockup-files";
import { ToolError } from "./tool-error";

// Resolves the Lead's active worktree directory so mockup snapshots sync between worktree and repoPath.
function resolveLeadWorktreePath(
  run: Run | undefined,
  leadAgentId: string | null | undefined,
  pipelineId: string | null | undefined,
): string | null {
  if (!run) return null;
  if (pipelineId && run.pipelines[pipelineId]?.worktree) {
    return run.pipelines[pipelineId].worktree;
  }
  if (leadAgentId && run.agents[leadAgentId]?.worktreePath) {
    return run.agents[leadAgentId].worktreePath;
  }
  return null;
}

// Allows a Feature Lead (`master_lead`) to submit `.slp/mockups/<feature>/index.html` as a new version (`v1`, `v2`, ...) to the Supervisor.
export async function submitBoardMockup(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    pipelineId?: string;
    feature?: string;
    title?: string;
    summary: string;
  },
): Promise<string> {
  const run = ctx.store.require(caller.runId);
  const callerRecord = run.agents[caller.agentId];
  const resolvedPipelineId =
    input.pipelineId?.trim() ||
    callerRecord?.pipelineId ||
    Object.values(run.pipelines).find((pipeline) => pipeline.leadAgentId === caller.agentId)?.id ||
    null;

  let targetTicket: BoardTicket;
  try {
    targetTicket = resolveTargetTicketForCaller(
      ctx,
      run,
      caller,
      input.ticketId,
      resolvedPipelineId ?? undefined,
    );
  } catch {
    // Auto-create the ticket when a Lead submits a mockup before a ticket row was explicitly created.
    const fallbackPipeline = resolvedPipelineId ? run.pipelines[resolvedPipelineId] : undefined;
    targetTicket = ctx.store.board.saveSpec({
      repoPath: run.repoPath,
      title: input.title?.trim() || fallbackPipeline?.name || callerRecord?.featureName || run.title,
      acceptanceCriteria: callerRecord?.featureCriteria ?? run.criteria ?? "",
      specContent: callerRecord?.featureSpec ?? run.productSpec ?? run.criteria ?? run.title,
      author: "supervisor",
      summary: "Auto-created from Lead mockup submission",
      activeRunId: run.id,
      activePipelineId: resolvedPipelineId,
      leadAgentId: caller.agentId,
    });
  }

  const nextMockupVersion = targetTicket.currentMockupRev + 1;
  const resolvedFeatureSlug = input.feature?.trim()
    ? deriveFeatureMockupSlug(input.feature, targetTicket.ticketKey)
    : targetTicket.featureSlug || deriveFeatureMockupSlug(targetTicket.title, targetTicket.ticketKey);
  const activePipeline = resolvedPipelineId ? run.pipelines[resolvedPipelineId] : undefined;
  // Provide candidate fallback slugs (pipeline name, Lead featureName, ticket key) in case the agent used a pipeline-named folder.
  const fallbackFeatureSlugs = [
    ...(activePipeline?.name
      ? [deriveFeatureMockupSlug(activePipeline.name, targetTicket.ticketKey), activePipeline.name]
      : []),
    ...(callerRecord?.featureName
      ? [deriveFeatureMockupSlug(callerRecord.featureName, targetTicket.ticketKey), callerRecord.featureName]
      : []),
    targetTicket.ticketKey.toLowerCase(),
  ];
  const leadWorktreePath = resolveLeadWorktreePath(run, caller.agentId, resolvedPipelineId);

  // Validate `.slp/mockups/<feature>/index.html` and clone it into `.slp/mockups/<feature>/versions/v<N>/`.
  let snapshotResult;
  try {
    snapshotResult = await snapshotFeatureMockupVersion({
      repoPath: run.repoPath,
      leadWorktreePath,
      featureSlug: resolvedFeatureSlug,
      fallbackFeatureSlugs,
      versionNumber: nextMockupVersion,
    });
  } catch (snapshotError) {
    throw new ToolError(
      snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
    );
  }

  const updatedTicket = ctx.store.board.saveMockupRevision({
    ticketIdOrKey: targetTicket.id,
    repoPath: run.repoPath,
    authorAgentId: caller.agentId,
    title: input.title?.trim() || targetTicket.title,
    summary: input.summary,
    featureSlug: snapshotResult.featureSlug,
    workingDirPath: snapshotResult.workingDirPath,
    versionDirPath: snapshotResult.versionDirPath,
    entryHtmlPath: snapshotResult.entryHtmlPath,
    activePipelineId: resolvedPipelineId ?? targetTicket.activePipelineId,
    leadAgentId: caller.agentId,
  });

  ctx.logEvent(run.id, {
    taskId: updatedTicket.activePipelineId,
    from: caller.agentId,
    to: run.supervisorAgentId || "supervisor",
    kind: "board.mockup_submitted",
    summary: `${updatedTicket.ticketKey} Mockup v${updatedTicket.currentMockupRev} (${snapshotResult.entryHtmlPath})`,
    outcome: "delivered",
  });

  // Clear any pending stage-approval obligation on the Lead while waiting for the human/Supervisor to review the submitted mockup,
  // preventing the sweeper from nudging the Lead to call slp_approve_stage before the mockup is approved.
  ctx.store.mutate(run.id, (mutableRun) => {
    const mutableLeadRecord = mutableRun.agents[caller.agentId];
    if (mutableLeadRecord) {
      mutableLeadRecord.awaitingTool = null;
      mutableLeadRecord.awaitingSince = null;
      mutableLeadRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) =>
        !(
          queuedMessage.toAgentId === caller.agentId &&
          queuedMessage.awaitTool === "slp_approve_stage"
        ),
    );
  });

  // Notify the Supervisor so it can report the interactive mockup version back to the human for review.
  if (
    run.supervisorAgentId &&
    run.agents[run.supervisorAgentId] &&
    !run.agents[run.supervisorAgentId].archivedAt
  ) {
    const supervisorMailPrompt = [
      `## Interactive HTML Mockup Submitted — Ticket \`${updatedTicket.ticketKey}\` (${updatedTicket.title} · v${updatedTicket.currentMockupRev})`,
      `- **From Feature Lead**: \`${caller.agentId}\``,
      `- **Feature Folder**: \`${snapshotResult.workingDirPath}/index.html\``,
      `- **Archived Version Snapshot**: \`${snapshotResult.entryHtmlPath}\``,
      `### Lead Summary\n${input.summary.trim()}`,
      [
        "### Supervisor Action Required",
        `1. Report Mockup **${updatedTicket.title} (v${updatedTicket.currentMockupRev})** to the human so they can open and preview it in the **2. MOCKUP** column on the Kanban board (clicking \`${updatedTicket.title} (v${updatedTicket.currentMockupRev}) [ → ]\` opens the interactive HTML/CSS/JS preview and element-comment studio).`,
        `2. Wait for the human's feedback. Once the human approves or requests adjustments, call \`slp_review_mockup({ ticketId: "${updatedTicket.ticketKey}", decision: "approve" | "rework", version: ${updatedTicket.currentMockupRev}, feedback: "..." })\`.`,
      ].join("\n"),
    ].join("\n\n");

    ctx.mailbox.enqueue(run.id, run.supervisorAgentId, supervisorMailPrompt, {
      taskId: updatedTicket.activePipelineId,
      awaitTool: null,
      from: `lead:${caller.agentId.slice(0, 8)}`,
      supersedeKey: `mockup-submitted:${updatedTicket.id}`,
      summary: `${updatedTicket.ticketKey} Mockup v${updatedTicket.currentMockupRev} ready for review`,
    });
  }

  return JSON.stringify({
    ticketId: updatedTicket.id,
    ticketKey: updatedTicket.ticketKey,
    version: updatedTicket.currentMockupRev,
    featureSlug: snapshotResult.featureSlug,
    workingDirPath: snapshotResult.workingDirPath,
    versionDirPath: snapshotResult.versionDirPath,
    entryHtmlPath: snapshotResult.entryHtmlPath,
    message: `Submitted Mockup v${updatedTicket.currentMockupRev} for ${updatedTicket.ticketKey} (cloned to '${snapshotResult.versionDirPath}/index.html') and notified the Supervisor. End your turn and wait for human/Supervisor review before proceeding to Brief/Implementation.`,
  });
}

// Shared implementation for `slp_review_mockup` (Supervisor tool) and `reviewBoardMockupFromUiRpc` (Kanban UI button).
export async function executeMockupReview(
  ctx: PipelineContext,
  params: {
    repoPath: string;
    run?: Run;
    reviewerLabel: string;
    ticketIdOrKey?: string;
    decision: "approve" | "rework";
    version?: number;
    feedback?: string;
    elementComments?: readonly MockupElementCommentInput[];
    baseVersion?: number;
  },
): Promise<{ ticket: BoardTicket; notifiedAgentId: string | null }> {
  const existingTicket = params.ticketIdOrKey
    ? ctx.store.board.requireTicket(params.ticketIdOrKey, params.repoPath)
    : (() => {
        const repoTickets = ctx.store.board.listByRepo(params.repoPath);
        if (repoTickets.length === 1) return repoTickets[0];
        throw new ToolError("Specify ticketId (for example 'SLP-1') when reviewing a mockup.");
      })();

  const targetVersion = params.version ?? existingTicket.currentMockupRev;
  if (targetVersion < 1) {
    throw new ToolError(
      `Ticket '${existingTicket.ticketKey}' has no submitted mockup versions yet.`,
    );
  }

  const featureSlug =
    existingTicket.featureSlug ||
    deriveFeatureMockupSlug(existingTicket.title, existingTicket.ticketKey);
  const leadWorktreePath = resolveLeadWorktreePath(
    params.run,
    existingTicket.leadAgentId,
    existingTicket.activePipelineId,
  );

  if (params.decision === "rework") {
    // Ensure the current working mockup is safely archived into versions/v<currentMockupRev> before the Lead edits it for v<N+1>.
    try {
      await snapshotFeatureMockupVersion({
        repoPath: params.repoPath,
        leadWorktreePath,
        featureSlug,
        versionNumber: existingTicket.currentMockupRev,
      });
    } catch {
      // Ignore if the working directory was already snapshotted at submission time.
    }
    // If the human chose a specific baseVersion to branch the next mockup from, copy that version into the working directory.
    if (params.baseVersion && params.baseVersion >= 1) {
      await syncMockupVersionToWorkingDirectory({
        repoPath: params.repoPath,
        leadWorktreePath,
        featureSlug,
        versionNumber: params.baseVersion,
      });
    }
  } else {
    // Sync the approved version back into `.slp/mockups/<feature>/` so the working directory matches the approved snapshot.
    await syncMockupVersionToWorkingDirectory({
      repoPath: params.repoPath,
      leadWorktreePath,
      featureSlug,
      versionNumber: targetVersion,
    });
  }

  const updatedTicket = ctx.store.board.reviewMockupRevision({
    ticketIdOrKey: existingTicket.id,
    repoPath: params.repoPath,
    decision: params.decision,
    version: targetVersion,
    feedback: params.feedback,
    elementComments: params.elementComments,
  });

  let notifiedAgentId: string | null = null;
  const activeRun =
    params.run ??
    (updatedTicket.activeRunId ? ctx.store.find(updatedTicket.activeRunId) : undefined);

  if (activeRun) {
    const targetLeadId = updatedTicket.leadAgentId ?? activeRun.masterLeadAgentId;
    if (targetLeadId && activeRun.agents[targetLeadId] && !activeRun.agents[targetLeadId].archivedAt) {
      notifiedAgentId = targetLeadId;
      const elementCommentsBlock = formatMockupElementCommentsMarkdown(
        params.elementComments ?? [],
      );
      const leadReviewPrompt =
        params.decision === "approve"
          ? [
              `## Mockup Approved — Ticket \`${updatedTicket.ticketKey}\` (${updatedTicket.title} · v${targetVersion})`,
              params.feedback?.trim() ? `### Reviewer Notes\n${params.feedback.trim()}` : "",
              [
                "### Next Lead Actions",
                `1. Mockup **v${targetVersion}** (\`.slp/mockups/${featureSlug}/versions/v${targetVersion}/index.html\`) is now **APPROVED**.`,
                "2. Decompose the approved Product Spec + approved HTML Mockup into your technical **Brief** (`slp_board_update_brief` or `slp_approve_stage({ summary, brief })` if completing a `mockup` stage).",
                "3. Proceed to the `implement` stage so the developer builds the feature matching both the Spec and the approved Mockup.",
              ].join("\n"),
            ]
              .filter(Boolean)
              .join("\n\n")
          : [
              `## Mockup Rework Requested — Ticket \`${updatedTicket.ticketKey}\` (${updatedTicket.title} · v${targetVersion} -> v${updatedTicket.currentMockupRev + 1})`,
              `- **Archived Previous Version**: \`.slp/mockups/${featureSlug}/versions/v${targetVersion}/index.html\` (preserved for version comparison)`,
              `- **Working Directory to Edit**: \`.slp/mockups/${featureSlug}/index.html\``,
              params.feedback?.trim() ? `### Overall Review Feedback\n${params.feedback.trim()}` : "",
              elementCommentsBlock,
              [
                "### Required Lead Actions",
                `1. Previous version **v${targetVersion}** has been preserved in \`.slp/mockups/${featureSlug}/versions/v${targetVersion}/\`.`,
                `2. Update the working mockup inside \`.slp/mockups/${featureSlug}/index.html\` (using \`slp_stage_rework\` with your mockup peers or updating the mockup files) to address every feedback item and HTML element comment above.`,
                `3. Call \`slp_submit_mockup({ ticketId: "${updatedTicket.ticketKey}", summary: "..." })\` to snapshot and submit **v${updatedTicket.currentMockupRev + 1}**.`,
              ].join("\n"),
            ]
              .filter(Boolean)
              .join("\n\n");

      // Restore the Lead's stage-approval obligation once the mockup is approved during an active stage.
      const targetPipeline = updatedTicket.activePipelineId
        ? activeRun.pipelines[updatedTicket.activePipelineId]
        : undefined;
      const currentPipelineStage =
        targetPipeline?.stages[targetPipeline.currentStageIndex];
      const shouldAwaitStageApproval =
        params.decision === "approve" &&
        targetPipeline?.status === "running" &&
        currentPipelineStage?.status === "running";

      ctx.mailbox.enqueue(activeRun.id, targetLeadId, leadReviewPrompt, {
        taskId: updatedTicket.activePipelineId,
        awaitTool: shouldAwaitStageApproval ? "slp_approve_stage" : null,
        from: params.reviewerLabel,
        supersedeKey: `mockup-review:${updatedTicket.id}:${targetLeadId}`,
        summary: `${updatedTicket.ticketKey} Mockup v${targetVersion} ${params.decision}`,
      });
    }
  }

  return { ticket: updatedTicket, notifiedAgentId };
}

// Allows the Supervisor to relay the human's approval or rework request for a mockup version to the Feature Lead.
export async function reviewBoardMockup(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    decision: "approve" | "rework";
    version?: number;
    feedback?: string;
    elementComments?: MockupElementCommentInput[];
    baseVersion?: number;
  },
): Promise<string> {
  const run = caller.runId ? ctx.store.find(caller.runId) : undefined;
  const effectiveRepoPath = run?.repoPath ?? caller.repoPath ?? "";
  if (!effectiveRepoPath) {
    throw new ToolError("No project repository is associated with this session.");
  }

  let resolvedTicket: BoardTicket | undefined;
  if (input.ticketId?.trim()) {
    resolvedTicket = resolveTargetTicketForCaller(ctx, run, caller, input.ticketId);
  } else {
    resolvedTicket = resolveTargetTicketForCaller(ctx, run, caller);
  }

  const reviewOutcome = await executeMockupReview(ctx, {
    repoPath: effectiveRepoPath,
    run,
    reviewerLabel: `supervisor:${caller.agentId.slice(0, 8)}`,
    ticketIdOrKey: resolvedTicket.id,
    decision: input.decision,
    version: input.version,
    feedback: input.feedback,
    elementComments: input.elementComments,
    baseVersion: input.baseVersion,
  });

  return JSON.stringify({
    ticketKey: reviewOutcome.ticket.ticketKey,
    decision: input.decision,
    reviewedVersion: input.version ?? reviewOutcome.ticket.currentMockupRev,
    approvedMockupRev: reviewOutcome.ticket.approvedMockupRev,
    notifiedLeadId: reviewOutcome.notifiedAgentId,
    message:
      input.decision === "approve"
        ? `Approved Mockup v${input.version ?? reviewOutcome.ticket.currentMockupRev} on ${reviewOutcome.ticket.ticketKey} and notified Lead '${reviewOutcome.notifiedAgentId ?? "none"}' to decompose the Brief and start implementation.`
        : `Requested Mockup rework on ${reviewOutcome.ticket.ticketKey} (v${input.version ?? reviewOutcome.ticket.currentMockupRev} archived; next submission will create v${reviewOutcome.ticket.currentMockupRev + 1}) and notified Lead '${reviewOutcome.notifiedAgentId ?? "none"}'.`,
  });
}
