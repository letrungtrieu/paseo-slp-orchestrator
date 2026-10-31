// Jira-style Kanban board MCP tool handlers for reading/updating Specs, mutable Brief bullets, Scores and Rework.
import type {
  BoardAgentActivity,
  BoardTicket,
  BriefItemInput,
  BriefItemStatus,
} from "../../shared/board";
import { pipelineBriefFromTicket } from "../../shared/board";
import type { ScorecardEntry } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import type { BusCaller } from "../bus/http-mcp";
import { computeUnifiedTextDiff } from "../store/diff";
import type { PipelineContext } from "./context";
import { bindProductAgentToTicket } from "./product-agent";
import { liveRunForTicket, notifySupervisorOfSpecChange } from "./ticket-change-notices";
import { ToolError } from "./tool-error";

// Attaches live agent activity (including Lead-initiated pause state) from the active run onto a Kanban ticket.
export function enrichTicketWithLiveAgents(run: Run | undefined, ticket: BoardTicket): BoardTicket {
  // Aborted or missing runs have no live sessions to project onto the Kanban card.
  if (!run || run.status === "aborted") {
    return { ...ticket, activeAgents: [] };
  }
  const matchingPipeline = ticket.activePipelineId ? run.pipelines[ticket.activePipelineId] : undefined;
  const currentStage = matchingPipeline?.stages[matchingPipeline.currentStageIndex];
  const activeAgentEntries: BoardAgentActivity[] = [];

  // Scan non-archived agents in the run and include the Supervisor, owning Lead, and stage Peers for this ticket.
  for (const agentRecord of Object.values(run.agents)) {
    if (agentRecord.archivedAt) continue;
    const isTicketSupervisor =
      agentRecord.role === "supervisor" && ticket.activeRunId === run.id;
    // Match both the feature Lead assigned at delegation and the pipeline's active stage Lead.
    const isTicketLead =
      agentRecord.agentId === ticket.leadAgentId
      || (matchingPipeline && agentRecord.agentId === matchingPipeline.leadAgentId);
    const isTicketPeer =
      Boolean(matchingPipeline && agentRecord.pipelineId === matchingPipeline.id);
    if (!isTicketSupervisor && !isTicketLead && !isTicketPeer) continue;

    // Expose pausedAt and awaitingTool so the Kanban UI can highlight paused peers and active tool obligations.
    activeAgentEntries.push({
      agentId: agentRecord.agentId,
      role: agentRecord.role,
      projectRole: agentRecord.projectRole,
      stageName: isTicketPeer ? (currentStage?.name ?? null) : null,
      pausedAt: agentRecord.pausedAt ?? null,
      pausedReason: agentRecord.pausedReason ?? null,
      awaitingTool: agentRecord.awaitingTool ?? null,
    });
  }
  return {
    ...ticket,
    activeAgents: activeAgentEntries,
  };
}

// Resolves the Kanban ticket targeted by an agent tool call, inferring it from the caller's pipeline or repository when ticketId is omitted.
export function resolveTargetTicketForCaller(
  ctx: PipelineContext,
  run: Run | undefined,
  caller: BusCaller,
  explicitTicketIdOrKey?: string,
  explicitPipelineId?: string,
): BoardTicket {
  const effectiveRepoPath = run?.repoPath ?? caller.repoPath ?? "";
  // Prefer an explicit ticket key (e.g. SLP-1) or UUID when the calling agent supplies one.
  if (explicitTicketIdOrKey?.trim()) {
    const foundByKey = ctx.store.board.find(explicitTicketIdOrKey, effectiveRepoPath || undefined);
    if (!foundByKey) throw new ToolError(`Kanban ticket '${explicitTicketIdOrKey}' was not found in this project.`);
    return foundByKey;
  }
  const callerRecord = run ? run.agents[caller.agentId] : undefined;
  const candidatePipelineId = explicitPipelineId?.trim() || callerRecord?.pipelineId || null;
  // Peers and stage Leads are bound to a pipelineId, which maps 1:1 to their feature ticket.
  if (candidatePipelineId) {
    const foundByPipeline = ctx.store.board.findByPipeline(candidatePipelineId);
    if (foundByPipeline) return foundByPipeline;
  }
  // Fall back to matching the Lead's assigned feature name or the single active ticket of the run.
  if (callerRecord?.featureName && effectiveRepoPath) {
    const foundByFeatureName = ctx.store.board
      .listByRepo(effectiveRepoPath)
      .find((ticket) => ticket.title.toLowerCase() === callerRecord.featureName!.toLowerCase());
    if (foundByFeatureName) return foundByFeatureName;
  }
  // Single-ticket runs and repositories resolve unambiguously without forcing the agent to pass ticketId.
  if (run) {
    const runTickets = ctx.store.board.listByRun(run.id);
    if (runTickets.length === 1) return runTickets[0];
  }
  if (effectiveRepoPath) {
    const repoTickets = ctx.store.board.listByRepo(effectiveRepoPath);
    if (repoTickets.length === 1) return repoTickets[0];
  }
  throw new ToolError("Provide ticketId (for example 'SLP-1') or call slp_board_list_tickets first.");
}

// Returns a compact summary of all tickets in the project repository for agent discovery.
export function listBoardTickets(ctx: PipelineContext, caller: BusCaller): string {
  const run = caller.runId ? ctx.store.find(caller.runId) : undefined;
  const effectiveRepoPath = run?.repoPath ?? caller.repoPath ?? "";
  if (!effectiveRepoPath) {
    throw new ToolError("No project repository is associated with this session.");
  }
  const projectTickets = ctx.store.board
    .listByRepo(effectiveRepoPath)
    .map((ticket) => enrichTicketWithLiveAgents(run, ticket));

  // Project only summary fields and bullet counts so listing many project tickets stays token-efficient.
  return JSON.stringify({
    repoPath: effectiveRepoPath,
    tickets: projectTickets.map((ticket) => {
      const inScopeItems = ticket.items.filter((bullet) => bullet.scope === "in");
      return {
        id: ticket.id,
        ticketKey: ticket.ticketKey,
        title: ticket.title,
        featureSlug: ticket.featureSlug,
        column: ticket.column,
        currentSpecRev: ticket.currentSpecRev,
        currentBriefRev: ticket.currentBriefRev,
        lastSyncedSpecRev: ticket.lastSyncedSpecRev,
        // True when the human or Supervisor edited the Spec after the current Brief revision was authored.
        hasUnappliedSpecDiff: ticket.currentSpecRev > ticket.lastSyncedSpecRev,
        activePipelineId: ticket.activePipelineId,
        leadAgentId: ticket.leadAgentId,
        mockup: ticket.mockup
          ? { file: ticket.mockup.file, status: ticket.mockup.status, approvedCommit: ticket.mockup.approvedCommit }
          : null,
        itemSummary: {
          totalInScope: inScopeItems.length,
          passed: inScopeItems.filter((bullet) => bullet.status === "pass").length,
          failed: inScopeItems.filter((bullet) => bullet.status === "fail" || bullet.status === "rework").length,
          implemented: inScopeItems.filter((bullet) => bullet.status === "implemented").length,
        },
        activeAgents: ticket.activeAgents,
        updatedAt: ticket.updatedAt,
      };
    }),
  });
}

// Returns the full Spec, Brief checklist, QA scores, and unified diffs for a single Kanban ticket.
export function getBoardTicket(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { ticketId?: string },
): string {
  const run = caller.runId ? ctx.store.find(caller.runId) : undefined;
  const resolvedTicket = enrichTicketWithLiveAgents(
    run,
    resolveTargetTicketForCaller(ctx, run, caller, input.ticketId),
  );
  const latestSpecRevision = resolvedTicket.specRevisions.at(-1) ?? null;
  const syncedSpecRevision = resolvedTicket.specRevisions.find(
    (specRevision) => specRevision.rev === resolvedTicket.lastSyncedSpecRev,
  ) ?? null;
  // Compute the exact cumulative diff between the Spec version the Brief is currently built on and the latest Spec.
  const unappliedSpecDiff =
    latestSpecRevision && resolvedTicket.currentSpecRev > resolvedTicket.lastSyncedSpecRev
      ? computeUnifiedTextDiff(
          syncedSpecRevision?.content ?? "",
          latestSpecRevision.content,
          syncedSpecRevision ? `spec-v${syncedSpecRevision.rev}` : "empty",
          `spec-v${latestSpecRevision.rev}`,
        )
      : "";
  const latestBriefRevision = resolvedTicket.briefRevisions.at(-1) ?? null;

  // Return both the latest snapshot and the revision histories so Leads can diff Spec and Brief changes.
  return JSON.stringify({
    id: resolvedTicket.id,
    ticketKey: resolvedTicket.ticketKey,
    title: resolvedTicket.title,
    featureSlug: resolvedTicket.featureSlug,
    column: resolvedTicket.column,
    acceptanceCriteria: resolvedTicket.acceptanceCriteria,
    currentSpecRev: resolvedTicket.currentSpecRev,
    currentBriefRev: resolvedTicket.currentBriefRev,
    lastSyncedSpecRev: resolvedTicket.lastSyncedSpecRev,
    hasUnappliedSpecDiff: resolvedTicket.currentSpecRev > resolvedTicket.lastSyncedSpecRev,
    currentSpec: latestSpecRevision?.content ?? "",
    latestSpecDiff: latestSpecRevision?.diff ?? "",
    unappliedSpecDiff,
    mockup: resolvedTicket.mockup,
    approach: resolvedTicket.approach,
    items: resolvedTicket.items,
    latestBriefReason: latestBriefRevision?.reason ?? "",
    latestBriefDiff: latestBriefRevision?.diff ?? "",
    specRevisions: resolvedTicket.specRevisions,
    briefRevisions: resolvedTicket.briefRevisions,
    activeAgents: resolvedTicket.activeAgents,
  });
}

// Allows the Supervisor or a standalone Product Agent to create or update the Product Spec on the Kanban board.
export async function saveBoardSpec(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    title?: string;
    acceptanceCriteria?: string;
    spec: string;
    summary?: string;
  },
): Promise<string> {
  const run = caller.runId ? ctx.store.find(caller.runId) : undefined;
  const effectiveRepoPath = run?.repoPath ?? caller.repoPath ?? "";
  if (!effectiveRepoPath) {
    throw new ToolError("No project repository is associated with this session.");
  }
  const firstMeaningfulSpecLine = input.spec
    .split(/\r?\n/)
    .map((rawLine) => rawLine.replace(/^[#*\-\d.)\s]+/, "").trim())
    .find((cleanedLine) => cleanedLine.length > 0);
  const derivedSpecTitle = firstMeaningfulSpecLine
    ? firstMeaningfulSpecLine.slice(0, 80)
    : "Product Spec";
  // Persist the authored Spec revision and compute its unified diff against any prior version.
  const savedTicket = ctx.store.board.saveSpec({
    repoPath: effectiveRepoPath,
    ticketIdOrKey: input.ticketId,
    // An existing card keeps its title: a Spec's first line is often a heading such as "Goals", not the feature name.
    title: input.title ?? (input.ticketId ? undefined : run?.title ?? derivedSpecTitle),
    acceptanceCriteria: input.acceptanceCriteria ?? run?.criteria ?? "",
    specContent: input.spec,
    author: "supervisor",
    summary: input.summary,
    // Left undefined outside a Run so a Product Agent edit cannot detach the ticket from the Run delivering it.
    activeRunId: run?.id,
  });
  // Keep run.productSpec updated when called from an active SLP run.
  if (run) {
    ctx.store.mutate(run.id, (mutableRun) => {
      mutableRun.productSpec = input.spec.trim();
    });
    ctx.logEvent(run.id, {
      taskId: savedTicket.activePipelineId,
      from: caller.agentId,
      to: "board",
      kind: "board.spec_saved",
      summary: `${savedTicket.ticketKey} Spec v${savedTicket.currentSpecRev}`,
      outcome: "delivered",
    });
  } else {
    bindProductAgentToTicket(caller.agentId, savedTicket.id);
    // The Product Agent has no route to a Lead, so the engine tells the Supervisor of any Run already delivering this ticket.
    const boundRun = liveRunForTicket(ctx, savedTicket);
    if (boundRun) await notifySupervisorOfSpecChange(ctx, boundRun, savedTicket, "product-agent");
  }
  const latestSpecRevision = savedTicket.specRevisions.at(-1);
  return JSON.stringify({
    ticketId: savedTicket.id,
    ticketKey: savedTicket.ticketKey,
    currentSpecRev: savedTicket.currentSpecRev,
    diff: latestSpecRevision?.diff ?? "",
    leadAgentId: savedTicket.leadAgentId,
    message: run && savedTicket.leadAgentId
      ? `Saved Spec v${savedTicket.currentSpecRev} on ${savedTicket.ticketKey}. Call slp_board_notify_lead to inform Lead '${savedTicket.leadAgentId}' so it can pause its peers and update the Brief from the Spec diff.`
      : `Saved Spec v${savedTicket.currentSpecRev} on ${savedTicket.ticketKey}.`,
  });
}

// Routes a Spec update notification and unified diff from the Supervisor to the owning Lead.
export function notifyLeadAboutSpec(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    toAgentId?: string;
    message: string;
  },
): string {
  const run = ctx.store.require(caller.runId);
  const resolvedTicket = resolveTargetTicketForCaller(ctx, run, caller, input.ticketId);
  // Route to the explicitly named Lead, the ticket's assigned Lead, or the run's primary Master Lead.
  const targetLeadId =
    input.toAgentId?.trim()
    || resolvedTicket.leadAgentId
    || run.masterLeadAgentId;
  if (!targetLeadId || !run.agents[targetLeadId] || run.agents[targetLeadId].archivedAt) {
    throw new ToolError("No active Lead agent is assigned to receive this Spec update yet.");
  }
  const latestSpecRevision = resolvedTicket.specRevisions.at(-1);
  const syncedSpecRevision = resolvedTicket.specRevisions.find(
    (specRevision) => specRevision.rev === resolvedTicket.lastSyncedSpecRev,
  );
  // Include the unified diff between the Brief's synced Spec version and the latest Spec version in the Lead's mail.
  const specDiffText = latestSpecRevision
    ? computeUnifiedTextDiff(
        syncedSpecRevision?.content ?? "",
        latestSpecRevision.content,
        syncedSpecRevision ? `spec-v${syncedSpecRevision.rev}` : "empty",
        `spec-v${latestSpecRevision.rev}`,
      )
    : "";

  const notificationPrompt = [
    `## Spec Update Notification from Supervisor — Ticket \`${resolvedTicket.ticketKey}\` (Spec v${resolvedTicket.currentSpecRev})`,
    `### Supervisor Message\n${input.message.trim()}`,
    specDiffText ? `### Spec Diff (v${resolvedTicket.lastSyncedSpecRev} -> v${resolvedTicket.currentSpecRev})\n\`\`\`diff\n${specDiffText}\n\`\`\`` : "",
    [
      "### Recommended Lead Actions",
      "1. If stage peers are currently working on outdated assumptions, call `slp_pause_peers` immediately to stop their turn.",
      `2. Inspect \`slp_board_get_ticket({ ticketId: "${resolvedTicket.ticketKey}" })\` and call \`slp_board_update_brief\` to update the Brief bullets based on the Spec diff.`,
      "3. Call `slp_resume_peers` (or `slp_stage_rework`) so your peers continue with the updated Brief.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");

  // Enqueue with a supersedeKey per ticket+Lead so rapid successive Spec edits replace unread notices.
  ctx.mailbox.enqueue(run.id, targetLeadId, notificationPrompt, {
    taskId: resolvedTicket.activePipelineId,
    awaitTool: null,
    from: `supervisor:${caller.agentId.slice(0, 8)}`,
    supersedeKey: `spec-update:${resolvedTicket.id}:${targetLeadId}`,
    summary: `Spec v${resolvedTicket.currentSpecRev} update for ${resolvedTicket.ticketKey}`,
  });

  return JSON.stringify({
    ticketKey: resolvedTicket.ticketKey,
    notifiedLeadId: targetLeadId,
    specRev: resolvedTicket.currentSpecRev,
    message: `Queued Spec v${resolvedTicket.currentSpecRev} update notice for Lead '${targetLeadId}'. End your turn.`,
  });
}

// Allows the Lead to create or revise the Brief bullet items when planning, syncing with Spec diffs, or resolving conflicts.
export function updateBoardBrief(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    pipelineId?: string;
    reason: string;
    approach: string;
    items: BriefItemInput[];
  },
): string {
  const run = ctx.store.require(caller.runId);
  const callerRecord = run.agents[caller.agentId];
  // Resolve the Lead's active pipeline so the updated Brief stays linked to the right stage cohort.
  const resolvedPipelineId =
    input.pipelineId?.trim()
    || callerRecord?.pipelineId
    || Object.values(run.pipelines).find((pipeline) => pipeline.leadAgentId === caller.agentId)?.id
    || null;

  let targetTicket: BoardTicket | null = null;
  try {
    targetTicket = resolveTargetTicketForCaller(ctx, run, caller, input.ticketId, resolvedPipelineId ?? undefined);
  } catch {
    // Auto-create the ticket when a Lead updates a Brief before any ticket row was initialized.
    const fallbackPipeline = resolvedPipelineId ? run.pipelines[resolvedPipelineId] : undefined;
    targetTicket = ctx.store.board.saveSpec({
      repoPath: run.repoPath,
      title: fallbackPipeline?.name ?? callerRecord?.featureName ?? run.title,
      acceptanceCriteria: callerRecord?.featureCriteria ?? run.criteria ?? "",
      specContent: callerRecord?.featureSpec ?? run.productSpec ?? run.criteria ?? run.title,
      author: "supervisor",
      summary: "Auto-created from Lead brief update",
      activeRunId: run.id,
      activePipelineId: resolvedPipelineId,
      leadAgentId: caller.agentId,
    });
  }

  // Save the new Brief revision, computing the unified Brief diff and preserving scores on unchanged bullets.
  const updatedTicket = ctx.store.board.saveBrief({
    ticketId: targetTicket.id,
    authorAgentId: caller.agentId,
    reason: input.reason,
    approach: input.approach,
    items: input.items,
    activePipelineId: resolvedPipelineId ?? targetTicket.activePipelineId,
    leadAgentId: caller.agentId,
  });

  // Synchronize the updated Brief back onto the pipeline state so stage briefings and QA grading use the new revision.
  const targetPipelineId = updatedTicket.activePipelineId;
  if (targetPipelineId && run.pipelines[targetPipelineId]) {
    const synchronizedPipelineBrief = pipelineBriefFromTicket(updatedTicket.approach, updatedTicket.items);
    ctx.store.mutate(run.id, (mutableRun) => {
      const mutablePipeline = mutableRun.pipelines[targetPipelineId];
      if (!mutablePipeline) return;
      mutablePipeline.brief = synchronizedPipelineBrief;
      mutablePipeline.briefLockedAt = updatedTicket.updatedAt;
      mutablePipeline.updatedAt = updatedTicket.updatedAt;
    });
  }

  const latestBriefRevision = updatedTicket.briefRevisions.at(-1);
  // Log the Brief update with the Lead's reason so technical pivots during conflict resolution are auditable.
  ctx.logEvent(run.id, {
    taskId: targetPipelineId,
    from: caller.agentId,
    to: "board",
    kind: "board.brief_updated",
    summary: `${updatedTicket.ticketKey} Brief v${updatedTicket.currentBriefRev}: ${input.reason}`,
    outcome: "delivered",
  });

  return JSON.stringify({
    ticketId: updatedTicket.id,
    ticketKey: updatedTicket.ticketKey,
    currentBriefRev: updatedTicket.currentBriefRev,
    syncedSpecRev: updatedTicket.lastSyncedSpecRev,
    diff: latestBriefRevision?.diff ?? "",
    items: updatedTicket.items,
    message: `Updated ${updatedTicket.ticketKey} to Brief v${updatedTicket.currentBriefRev}. If you paused stage peers earlier, call slp_resume_peers to resume them with the new Brief diff.`,
  });
}

// Allows a peer or Lead to update the implementation progress status of a single Brief bullet item.
export function updateBoardBriefItem(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    itemId: string;
    status: BriefItemStatus;
    note?: string;
  },
): string {
  const run = ctx.store.require(caller.runId);
  const targetTicket = resolveTargetTicketForCaller(ctx, run, caller, input.ticketId);
  // Persist the bullet status change and return the updated bullet snapshot to the caller.
  const updatedTicket = ctx.store.board.updateItemProgress({
    ticketIdOrKey: targetTicket.id,
    repoPath: run.repoPath,
    itemId: input.itemId,
    status: input.status,
    note: input.note,
  });
  return JSON.stringify({
    ticketKey: updatedTicket.ticketKey,
    column: updatedTicket.column,
    item: updatedTicket.items.find((bullet) => bullet.id === input.itemId) ?? null,
  });
}

// Records QA scorecard pass/fail/blocked verdicts against Brief bullets on the Kanban ticket.
export function scoreBoardBriefItems(
  ctx: PipelineContext,
  caller: BusCaller,
  input: {
    ticketId?: string;
    scorecard: ScorecardEntry[];
  },
): string {
  const run = ctx.store.require(caller.runId);
  const targetTicket = resolveTargetTicketForCaller(ctx, run, caller, input.ticketId);
  // Apply the scorecard entries to the ticket's bullets and automatically update the ticket column.
  const updatedTicket = ctx.store.board.scoreItems({
    ticketIdOrKey: targetTicket.id,
    repoPath: run.repoPath,
    gradedBy: caller.agentId,
    scorecard: input.scorecard,
  });
  ctx.logEvent(run.id, {
    taskId: updatedTicket.activePipelineId,
    from: caller.agentId,
    to: "board",
    kind: "board.items_scored",
    summary: `${updatedTicket.ticketKey} -> ${updatedTicket.column} (${input.scorecard.length} item(s) graded)`,
    outcome: "delivered",
  });
  return JSON.stringify({
    ticketKey: updatedTicket.ticketKey,
    column: updatedTicket.column,
    items: updatedTicket.items,
  });
}
