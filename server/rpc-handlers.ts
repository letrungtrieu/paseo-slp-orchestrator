// RPC handlers behind the app UI. Failures throw so the UI's inline error display shows the reason
// (the client only surfaces thrown errors, not `ok: false` payloads).
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { DEFAULT_SLP_SETTINGS, type SlpSettingsSchema } from "../shared/settings";
import {
  abortRunRpc,
  approveBoardMockupRpc,
  approveGateRpc,
  approvePipelineGateRpc,
  approveMainRpc,
  dismissArchiveWarningRpc,
  getRunRpc,
  listBoardTicketsRpc,
  listPeerQuestionsRpc,
  listRunsRpc,
  readBoardMockupPreviewRpc,
  restoreRunRpc,
  resumeTaskRpc,
  saveBoardSpecFromUiRpc,
  sendBoardMockupFeedbackRpc,
  setRunModeRpc,
  spawnBoardProductAgentRpc,
  startRunRpc,
  tailLogRpc,
  initializeProjectPromptsRpc,
  initSlpManagerSkillRpc,
  type RunSummary,
} from "../shared/rpc";
import type { Run } from "../shared/state";
import { enrichTicketWithLiveAgents } from "./pipeline/board-tools";
import type { PipelineContext } from "./pipeline/context";
import { bundleMockupHtmlPreview } from "./pipeline/mockup-files";
import { approveBoardMockup, sendMockupFeedback } from "./pipeline/mockup-tools";
import { buildPeerQuestionViews, computePeerQuestionMetrics } from "./pipeline/peer-messaging/question-metrics";
import { abortRun, approveMain, approveRunGate, DEFAULT_PROVIDER, startRun } from "./pipeline/run-lifecycle";
import { archiveRunSafely, dismissArchiveWarning, restoreRun } from "./pipeline/run-restore";
import { spawnBoardProductAgent } from "./pipeline/product-agent";
import { liveRunForTicket, notifySupervisorOfSpecChange } from "./pipeline/ticket-change-notices";
import { approvePipelineGate } from "./pipeline/stage-control";
import { assertGitRepository } from "./git/git";
import { loadProjectPrompts } from "./project-prompts/load";
import { join } from "node:path";
import { productAgentDefaults, roleRunDefaults } from "./runtime/run-defaults";
import { ensureSlpManagerSkill } from "./skills/slp-manager-skill";

// Match a workspace directory (either main repoPath or an SLP Lead/Peer git worktree) to its owning Run and canonical repoPath.
function resolveRunAndCanonicalRepoPath(
  ctx: PipelineContext,
  rawRepoOrWorktreePath?: string | null,
  explicitRunId?: string | null,
): { matchedRun: Run | undefined; effectiveRepoPath: string } {
  const trimmedPath = rawRepoOrWorktreePath?.trim() || "";
  if (explicitRunId) {
    const explicitRun = ctx.store.find(explicitRunId);
    if (explicitRun) {
      return { matchedRun: explicitRun, effectiveRepoPath: explicitRun.repoPath || trimmedPath };
    }
  }
  const orderedRuns = [...ctx.store.list()].sort((firstRun, secondRun) =>
    secondRun.updatedAt.localeCompare(firstRun.updatedAt),
  );
  if (!trimmedPath) {
    const latestRun = orderedRuns.find((candidateRun) => candidateRun.status !== "aborted") ?? orderedRuns[0];
    return { matchedRun: latestRun, effectiveRepoPath: latestRun?.repoPath ?? "" };
  }
  const runMatchesWorkspacePath = (candidateRun: Run): boolean =>
    candidateRun.repoPath === trimmedPath ||
    candidateRun.devCwd === trimmedPath ||
    Object.values(candidateRun.pipelines ?? {}).some((pipeline) => pipeline.worktree === trimmedPath) ||
    Object.values(candidateRun.pipelineWorkspaces ?? {}).some((workspace) => workspace.cwd === trimmedPath) ||
    Object.values(candidateRun.agents ?? {}).some((agentRecord) => agentRecord.worktreePath === trimmedPath);

  const matchedRun =
    orderedRuns.find((candidateRun) => candidateRun.status !== "aborted" && runMatchesWorkspacePath(candidateRun)) ??
    orderedRuns.find(runMatchesWorkspacePath);
  return {
    matchedRun,
    effectiveRepoPath: matchedRun?.repoPath || trimmedPath,
  };
}

function summarizeRun(run: Run): RunSummary {
  // Counts are derived on demand so the list follows the dynamic pipeline state after each stage handoff.
  const tasks = Object.values(run.tasks);
  const pipelines = Object.values(run.pipelines ?? {});
  const hasDynamicPipelines = pipelines.length > 0;
  const pipelineGateCount = pipelines.filter((pipeline) => Boolean(pipeline.gate)).length;
  return {
    id: run.id,
    title: run.title,
    repoPath: run.repoPath,
    status: run.status,
    mode: run.mode,
    // Legacy field names stay on the wire so older clients can read new summaries without a schema fork.
    taskCount: hasDynamicPipelines ? pipelines.length : tasks.length,
    mergedTaskCount: hasDynamicPipelines
      ? pipelines.filter((pipeline) => pipeline.status === "integrated").length
      : tasks.filter((task) => task.phase === "merged").length,
    // Dynamic gates belong to a pipeline; old task/run gates remain visible for legacy snapshots.
    openGateCount: hasDynamicPipelines
      ? pipelineGateCount + (run.gate ? 1 : 0)
      : tasks.filter((task) => task.gate).length + (run.gate ? 1 : 0),
    supervisorAgentId: run.supervisorAgentId,
    supervisorWorkspaceId: run.supervisorWorkspaceId,
    archivedAt: run.archivedAt ?? null,
    archivedFromStatus: run.archivedFromStatus ?? null,
    archiveWarningPending: Boolean(run.archiveWarningPending),
    updatedAt: run.updatedAt,
  };
}

export function registerRpcHandlers(server: PluginServerContext, ctx: PipelineContext, globalSettings?: PluginSettings<typeof SlpSettingsSchema>): void {
  server.handle(initializeProjectPromptsRpc, async ({ repoPath }) => {
    // Initializing on project selection lets users edit workflows before creating any agent session.
    await assertGitRepository(repoPath);
    const configuration = await loadProjectPrompts(repoPath);
    // Avoid sending workflow bodies to a form that only displays discovery metadata.
    return { directory: join(repoPath, ".slp"), peers: configuration.peers.map(({ role, name, description, model, thinking, sourcePath }) =>
      ({ role, name, description, model, thinking, sourcePath })) };
  });

  server.handle(initSlpManagerSkillRpc, async ({ repoPath }, { paseo }) => {
    ctx.holder.capture(paseo);
    // Validate the selected project before writing project-scoped skill files into its root.
    await assertGitRepository(repoPath);
    return ensureSlpManagerSkill(repoPath);
  });
  // Handlers receive the SDK instance, which the entry point never gets, so each one parks it in the holder for the sweeper and pipeline.
  server.handle(listRunsRpc, (_input, { paseo }) => {
    ctx.holder.capture(paseo);
    // Most recently touched run first, so the run the user is watching is on top.
    const newestFirst = [...ctx.store.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { runs: newestFirst.map(summarizeRun) };
  });

  server.handle(getRunRpc, ({ runId }, { paseo }) => {
    // Capture the SDK handle on active-run polls so bus tools work immediately after a plugin reload.
    ctx.holder.capture(paseo);
    return { run: ctx.store.find(runId) ?? null };
  });

  server.handle(startRunRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    // CLI and reopened clients inherit the same role choices as the global settings surface.
    const savedSettings = globalSettings ? await globalSettings.read() : null;
    if (savedSettings?.status === "invalid") throw new Error(savedSettings.error);
    const defaults = savedSettings?.status === "ready" ? savedSettings.values : DEFAULT_SLP_SETTINGS;
    const supervisor = roleRunDefaults(defaults.roles.supervisor, input.supervisorProvider, input.supervisorThinkingOptionId, input.supervisorPermissionModeId);
    const lead = roleRunDefaults(defaults.roles.lead, input.leadProvider, input.leadThinkingOptionId, input.leadPermissionModeId);
    const peer = roleRunDefaults(defaults.roles.peer, input.peerProvider, input.peerThinkingOptionId, input.peerPermissionModeId);
    // Awaited and returned so a failure while creating worktrees or agents reaches the UI's inline error.
    return startRun(ctx, {
      repoPath: input.repoPath,
      name: input.name,
      baseBranch: input.baseBranch,
      mode: input.mode ?? defaults.mode,
      // Keep provider models and their thinking preferences together through the run boundary.
      providers: {
        supervisor: supervisor.provider,
        lead: lead.provider,
        peer: peer.provider,
        supervisorThinkingOptionId: supervisor.thinkingOptionId,
        leadThinkingOptionId: lead.thinkingOptionId,
        peerThinkingOptionId: peer.thinkingOptionId,
        supervisorPermissionModeId: supervisor.permissionModeId,
        leadPermissionModeId: lead.permissionModeId,
        peerPermissionModeId: peer.permissionModeId,
      },
      ticketId: input.ticketId,
      // Allow the Start SLP form checkbox to override whether this run creates git worktrees or stays on baseBranch.
      orchestration:
        input.spawnWorktrees !== undefined
          ? { ...defaults.orchestration, spawnWorktrees: input.spawnWorktrees }
          : defaults.orchestration,
    });
  });

  // Mode is read at each gate decision, so switching it applies to the next hand-over without restarting agents.
  server.handle(setRunModeRpc, ({ runId, mode }, { paseo }) => {
    ctx.holder.capture(paseo);
    ctx.store.mutate(runId, (run) => {
      run.mode = mode;
    });
    ctx.logEvent(runId, { taskId: null, from: "manager", to: "pipeline", kind: "run.mode_changed", summary: mode, outcome: "info" });
    return { ok: true };
  });

  server.handle(approveGateRpc, async ({ runId, taskId }, { paseo }) => {
    ctx.holder.capture(paseo);
    return { ok: true, message: await approveRunGate(ctx, runId, taskId ?? null) };
  });

  server.handle(approvePipelineGateRpc, async ({ runId, pipelineId }, { paseo }) => {
    // Gate approval may archive agents or open the next stage, so it needs the live Paseo holder.
    ctx.holder.capture(paseo);
    return { ok: true, message: await approvePipelineGate(ctx, runId, pipelineId) };
  });

  server.handle(resumeTaskRpc, () => {
    // New runs use stage approval and Lead-directed rework; silently routing this call to the retired task engine would mutate stale state.
    throw new Error("This run uses the retired task engine; start a new run");
  });

  server.handle(approveMainRpc, async ({ runId }, { paseo }) => {
    ctx.holder.capture(paseo);
    return { ok: true, message: await approveMain(ctx, runId) };
  });

  // Aborting or archiving closes agents through the SDK, so the holder must be populated first.
  server.handle(abortRunRpc, async ({ runId, archiveOnly }, { paseo }) => {
    ctx.holder.capture(paseo);
    if (archiveOnly) {
      await archiveRunSafely(ctx, runId);
    } else {
      await abortRun(ctx, runId);
    }
    return { ok: true };
  });

  // Restoring re-opens the run's workspaces and respawns its Supervisor, Leads, and active stage Peers.
  server.handle(restoreRunRpc, async ({ runId }, { paseo }) => {
    ctx.holder.capture(paseo);
    return restoreRun(ctx, runId);
  });

  server.handle(dismissArchiveWarningRpc, ({ runId }, { paseo }) => {
    ctx.holder.capture(paseo);
    dismissArchiveWarning(ctx, runId);
    return { ok: true };
  });

  // SQLite supplies a bounded tail without scanning the repository or loading its entire history.
  server.handle(tailLogRpc, async ({ runId, limit }, { paseo }) => {
    ctx.holder.capture(paseo);
    const run = ctx.store.find(runId);
    return { entries: run ? ctx.store.tailLog(runId, limit) : [] };
  });

  // Metrics cover every returned row, so the optional status filter narrows the table and the numbers together.
  server.handle(listPeerQuestionsRpc, async ({ runId, status, limit }, { paseo }) => {
    ctx.holder.capture(paseo);
    const run = ctx.store.find(runId);
    if (!run) return { questions: [], metrics: computePeerQuestionMetrics([]) };
    const ledgerQuestions = ctx.store.questions.listForRun(runId, limit).filter((question) => !status || question.status === status);
    const questionViews = buildPeerQuestionViews(run, ledgerQuestions);
    return { questions: questionViews, metrics: computePeerQuestionMetrics(questionViews) };
  });

  // Returns project-scoped Kanban tickets enriched with realtime agent activity from the active run.
  server.handle(listBoardTicketsRpc, ({ repoPath, runId }, { paseo }) => {
    ctx.holder.capture(paseo);
    const { matchedRun, effectiveRepoPath } = resolveRunAndCanonicalRepoPath(ctx, repoPath, runId);
    if (!effectiveRepoPath) return { repoPath: "", tickets: [] };
    const storedTickets = ctx.store.board.listByRepo(effectiveRepoPath);
    return {
      repoPath: effectiveRepoPath,
      tickets: storedTickets.map((ticket) => {
        const ticketRun = (ticket.activeRunId ? ctx.store.find(ticket.activeRunId) : undefined) ?? matchedRun;
        return enrichTicketWithLiveAgents(ticketRun, ticket);
      }),
    };
  });

  // Persists human Spec edits from the Kanban UI and notifies the Supervisor so it can coordinate with the Lead.
  server.handle(saveBoardSpecFromUiRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const { matchedRun, effectiveRepoPath } = resolveRunAndCanonicalRepoPath(
      ctx,
      input.repoPath,
      input.runId,
    );

    const savedTicket = ctx.store.board.saveSpec({
      repoPath: effectiveRepoPath || input.repoPath,
      ticketIdOrKey: input.ticketId,
      title: input.title,
      acceptanceCriteria: input.acceptanceCriteria,
      specContent: input.specContent,
      author: "human",
      summary: input.summary,
      // Left undefined without a Run so editing a card can never detach it from the Run delivering it.
      activeRunId: matchedRun?.id,
    });

    const activeRun = liveRunForTicket(ctx, savedTicket);
    if (activeRun) await notifySupervisorOfSpecChange(ctx, activeRun, savedTicket, "human");
    const notifiedSupervisor = Boolean(activeRun);

    return {
      ticket: enrichTicketWithLiveAgents(activeRun, savedTicket),
      notifiedSupervisor,
    };
  });

  // Product Agents have no role of their own in settings, so they follow the Supervisor's human-facing model choice.
  const openProductAgent = async (repoPath: string, ticketId?: string) => {
    const savedSettings = globalSettings ? await globalSettings.read() : null;
    if (savedSettings?.status === "invalid") throw new Error(savedSettings.error);
    const defaults = savedSettings?.status === "ready" ? savedSettings.values : DEFAULT_SLP_SETTINGS;
    const productDefaults = productAgentDefaults(defaults.roles);
    return spawnBoardProductAgent(ctx, {
      repoPath,
      ticketId,
      provider: productDefaults.provider ?? DEFAULT_PROVIDER,
      thinkingOptionId: productDefaults.thinkingOptionId,
      permissionModeId: productDefaults.permissionModeId,
    });
  };

  // Spawns a standalone Product Agent connected to the project's Kanban board for shaping a mockup and Spec.
  server.handle(spawnBoardProductAgentRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const { effectiveRepoPath } = resolveRunAndCanonicalRepoPath(ctx, input.repoPath, input.runId);
    return openProductAgent(effectiveRepoPath || input.repoPath, input.ticketId);
  });

  // Bundles a ticket's mockup file (with element-comment inspector bridge) for the Kanban Mockup Preview Studio.
  server.handle(readBoardMockupPreviewRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const { effectiveRepoPath } = resolveRunAndCanonicalRepoPath(ctx, input.repoPath);
    const targetTicket = ctx.store.board.requireTicket(
      input.ticketId,
      effectiveRepoPath || input.repoPath,
    );
    if (!targetTicket.mockup) {
      throw new Error(`Ticket '${targetTicket.ticketKey}' has no mockup yet.`);
    }
    const { absoluteHtmlPath, bundledHtml } = await bundleMockupHtmlPreview(
      targetTicket.repoPath || effectiveRepoPath || input.repoPath,
      targetTicket.mockup.file,
    );
    return {
      ticketId: targetTicket.id,
      title: targetTicket.title,
      file: targetTicket.mockup.file,
      absoluteHtmlPath,
      bundledHtml,
    };
  });

  // Saves the human's Studio notes and hands them to the Product Agent so the mockup can be revised right away.
  server.handle(sendBoardMockupFeedbackRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const { effectiveRepoPath } = resolveRunAndCanonicalRepoPath(ctx, input.repoPath);
    const repoPath = effectiveRepoPath || input.repoPath;
    const feedbackOutcome = await sendMockupFeedback(ctx, {
      repoPath,
      ticketIdOrKey: input.ticketId,
      feedback: input.feedback,
      elementComments: input.elementComments,
      openProductAgent: async (targetTicket) =>
        (await openProductAgent(repoPath, targetTicket.id)).agentId,
    });
    return {
      ticket: enrichTicketWithLiveAgents(liveRunForTicket(ctx, feedbackOutcome.ticket), feedbackOutcome.ticket),
      productAgentId: feedbackOutcome.productAgentId,
    };
  });

  // Approves a mockup at the current commit from the Kanban UI; the gate that it is committed lives in the pipeline.
  server.handle(approveBoardMockupRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const { effectiveRepoPath } = resolveRunAndCanonicalRepoPath(ctx, input.repoPath);
    const approvalRepoPath = effectiveRepoPath || input.repoPath;
    const approvedTicket = await approveBoardMockup(ctx, {
      repoPath: approvalRepoPath,
      ticketIdOrKey: input.ticketId,
      openProductAgent: async (targetTicket) => (await openProductAgent(approvalRepoPath, targetTicket.id)).agentId,
    });
    return { ticket: enrichTicketWithLiveAgents(liveRunForTicket(ctx, approvedTicket), approvedTicket) };
  });
}
