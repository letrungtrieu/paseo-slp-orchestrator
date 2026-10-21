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
  listRunsRpc,
  restoreRunRpc,
  resumeTaskRpc,
  setRunModeRpc,
  startRunRpc,
  tailLogRpc,
  initializeProjectPromptsRpc,
  initSlpManagerSkillRpc,
  type RunSummary,
} from "../shared/rpc";
import type { Run } from "../shared/state";
import type { PipelineContext } from "./pipeline/context";
import { abortRun, approveMain, approveRunGate, startRun } from "./pipeline/run-lifecycle";
import { archiveRunSafely, dismissArchiveWarning, restoreRun } from "./pipeline/run-restore";
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
      title: input.title,
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
}
