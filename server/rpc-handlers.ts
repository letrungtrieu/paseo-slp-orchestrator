// RPC handlers behind the app UI. Failures throw so the UI's inline error display shows the reason
// (the client only surfaces thrown errors, not `ok: false` payloads).
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { DEFAULT_SLP_SETTINGS, type SlpSettingsSchema } from "../shared/settings";
import {
  abortRunRpc,
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
  reviewBoardMockupFromUiRpc,
  saveBoardSpecFromUiRpc,
  setRunModeRpc,
  spawnBoardSpecAgentRpc,
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
import { executeMockupReview } from "./pipeline/mockup-tools";
import { buildPeerQuestionViews, computePeerQuestionMetrics } from "./pipeline/peer-messaging/question-metrics";
import { abortRun, approveMain, approveRunGate, DEFAULT_PROVIDER, startRun } from "./pipeline/run-lifecycle";
import { archiveRunSafely, dismissArchiveWarning, restoreRun } from "./pipeline/run-restore";
import { spawnBoardSpecAgent } from "./pipeline/spec-agent";
import { approvePipelineGate } from "./pipeline/stage-control";
import { assertGitRepository } from "./git/git";
import { loadProjectPrompts } from "./project-prompts/load";
import { join } from "node:path";
import { roleRunDefaults } from "./runtime/run-defaults";
import { ensureSlpManagerSkill } from "./skills/slp-manager-skill";

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
    const matchedRun = runId
      ? ctx.store.find(runId)
      : [...ctx.store.list()]
          .filter((candidateRun) => !repoPath || candidateRun.repoPath === repoPath)
          .sort((firstRun, secondRun) => secondRun.updatedAt.localeCompare(firstRun.updatedAt))[0];
    const effectiveRepoPath = repoPath?.trim() || matchedRun?.repoPath || "";
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
    const activeRun =
      (input.runId ? ctx.store.find(input.runId) : undefined) ??
      [...ctx.store.list()]
        .filter((candidateRun) => candidateRun.repoPath === input.repoPath && candidateRun.status !== "aborted")
        .sort((firstRun, secondRun) => secondRun.updatedAt.localeCompare(firstRun.updatedAt))[0];

    const savedTicket = ctx.store.board.saveSpec({
      repoPath: input.repoPath,
      ticketIdOrKey: input.ticketId,
      title: input.title,
      acceptanceCriteria: input.acceptanceCriteria,
      specContent: input.specContent,
      author: "human",
      summary: input.summary,
      activeRunId: activeRun?.id ?? null,
    });

    let notifiedSupervisor = false;
    if (activeRun && activeRun.supervisorAgentId && !activeRun.agents[activeRun.supervisorAgentId]?.archivedAt) {
      const latestSpecRevision = savedTicket.specRevisions.at(-1);
      const supervisorNotice = [
        `## Human Updated Spec on Kanban Board — Ticket \`${savedTicket.ticketKey}\` (${savedTicket.title})`,
        `- **New Spec Revision**: \`v${savedTicket.currentSpecRev}\``,
        `- **Summary**: ${latestSpecRevision?.summary ?? "Human edited Spec in Kanban View"}`,
        latestSpecRevision?.diff
          ? `### Spec Diff\n\`\`\`diff\n${latestSpecRevision.diff}\n\`\`\``
          : `### Updated Spec\n${savedTicket.specRevisions.at(-1)?.content ?? ""}`,
        [
          "### Required Supervisor Action",
          `1. Inspect the updated Spec and diff on ticket \`${savedTicket.ticketKey}\` using \`slp_board_get_ticket({ ticketId: "${savedTicket.ticketKey}" })\`.`,
          savedTicket.leadAgentId
            ? `2. Notify the assigned Lead (\`${savedTicket.leadAgentId}\`) via \`slp_board_notify_lead({ ticketId: "${savedTicket.ticketKey}", message: "..." })\` so the Lead pauses its stage peers (\`slp_pause_peers\`), updates the Brief bullets from the Spec diff (\`slp_board_update_brief\`), and resumes work.`
            : "2. If this feature is ready to run, delegate it with `slp_delegate` or inform the human in Vietnamese.",
        ].join("\n"),
      ].filter(Boolean).join("\n\n");

      ctx.store.mutate(activeRun.id, (mutableRun) => {
        mutableRun.productSpec = input.specContent.trim();
      });
      ctx.mailbox.enqueue(activeRun.id, activeRun.supervisorAgentId, supervisorNotice, {
        taskId: savedTicket.activePipelineId,
        awaitTool: null,
        from: "human",
        supersedeKey: `human-spec-edit:${savedTicket.id}`,
        summary: `Human edited Spec v${savedTicket.currentSpecRev} on ${savedTicket.ticketKey}`,
      });
      notifiedSupervisor = true;
      // Flush immediately when the Supervisor is idle so the human sees instant responsiveness.
      if (ctx.holder.isReady()) {
        await ctx.gateway
          .liveStatuses(activeRun.id)
          .then((liveStatuses) => ctx.mailbox.flush(activeRun.id, liveStatuses))
          .catch(() => undefined);
      }
    }

    return {
      ticket: enrichTicketWithLiveAgents(activeRun, savedTicket),
      notifiedSupervisor,
    };
  });

  // Spawns a standalone normal Paseo agent connected to the project's Kanban board for interactive Spec discussion.
  server.handle(spawnBoardSpecAgentRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const savedSettings = globalSettings ? await globalSettings.read() : null;
    if (savedSettings?.status === "invalid") throw new Error(savedSettings.error);
    const defaults = savedSettings?.status === "ready" ? savedSettings.values : DEFAULT_SLP_SETTINGS;
    const supervisorDefaults = roleRunDefaults(defaults.roles.supervisor);
    return spawnBoardSpecAgent(ctx, {
      repoPath: input.repoPath,
      ticketId: input.ticketId,
      provider: supervisorDefaults.provider ?? DEFAULT_PROVIDER,
      thinkingOptionId: supervisorDefaults.thinkingOptionId,
      permissionModeId: supervisorDefaults.permissionModeId,
    });
  });

  // Bundles a specific HTML/CSS/JS mockup version (with element-comment inspector bridge) for the Kanban Mockup Preview Studio.
  server.handle(readBoardMockupPreviewRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const targetTicket = ctx.store.board.requireTicket(input.ticketId, input.repoPath);
    const targetVersion = input.version ?? targetTicket.currentMockupRev;
    const matchedRevision = targetTicket.mockupRevisions.find(
      (candidateRev) => candidateRev.version === targetVersion,
    );
    if (!matchedRevision) {
      throw new Error(
        `Ticket '${targetTicket.ticketKey}' does not have mockup version v${targetVersion}.`,
      );
    }
    const { absoluteHtmlPath, bundledHtml } = await bundleMockupHtmlPreview(
      input.repoPath,
      matchedRevision.entryHtmlPath,
    );
    return {
      ticketId: targetTicket.id,
      version: matchedRevision.version,
      title: matchedRevision.title,
      featureSlug: matchedRevision.featureSlug,
      entryHtmlPath: matchedRevision.entryHtmlPath,
      absoluteHtmlPath,
      bundledHtml,
    };
  });

  // Handles human approval or rework requests (including HTML element comments) submitted from the Kanban Mockup Studio.
  server.handle(reviewBoardMockupFromUiRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    const activeRun =
      (input.runId ? ctx.store.find(input.runId) : undefined) ??
      [...ctx.store.list()]
        .filter((candidateRun) => candidateRun.repoPath === input.repoPath && candidateRun.status !== "aborted")
        .sort((firstRun, secondRun) => secondRun.updatedAt.localeCompare(firstRun.updatedAt))[0];

    const reviewOutcome = await executeMockupReview(ctx, {
      repoPath: input.repoPath,
      run: activeRun,
      reviewerLabel: "human",
      ticketIdOrKey: input.ticketId,
      decision: input.decision,
      version: input.version,
      feedback: input.feedback,
      elementComments: input.elementComments,
      baseVersion: input.baseVersion,
    });

    if (activeRun && reviewOutcome.notifiedAgentId && ctx.holder.isReady()) {
      await ctx.gateway
        .liveStatuses(activeRun.id)
        .then((liveStatuses) => ctx.mailbox.flush(activeRun.id, liveStatuses))
        .catch(() => undefined);
    }

    return {
      ticket: enrichTicketWithLiveAgents(activeRun, reviewOutcome.ticket),
      notifiedAgentId: reviewOutcome.notifiedAgentId,
    };
  });
}
