// RPC handlers behind the app UI. Failures throw so the UI's inline error display shows the reason
// (the client only surfaces thrown errors, not `ok: false` payloads).
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  abortRunRpc,
  approveGateRpc,
  approveMainRpc,
  getRunRpc,
  listRunsRpc,
  resumeTaskRpc,
  setRunModeRpc,
  startRunRpc,
  tailLogRpc,
  type RunSummary,
} from "../shared/rpc";
import type { Run } from "../shared/state";
import type { PipelineContext } from "./pipeline/context";
import { abortRun, approveMain, approveRunGate, startRun } from "./pipeline/run-lifecycle";
import { resumeTask } from "./pipeline/task-pause";
import { tailCommLog } from "./store/comm-log";

function summarizeRun(run: Run): RunSummary {
  // Counts are derived on demand instead of stored, so the list can never disagree with the task table.
  const tasks = Object.values(run.tasks);
  return {
    id: run.id,
    title: run.title,
    repoPath: run.repoPath,
    status: run.status,
    mode: run.mode,
    taskCount: tasks.length,
    mergedTaskCount: tasks.filter((task) => task.phase === "merged").length,
    // A task gate and the run-level final gate are both something the human must click, so the badge counts them together.
    openGateCount: tasks.filter((task) => task.gate).length + (run.gate ? 1 : 0),
    supervisorAgentId: run.supervisorAgentId,
    supervisorWorkspaceId: run.supervisorWorkspaceId,
    updatedAt: run.updatedAt,
  };
}

export function registerRpcHandlers(server: PluginServerContext, ctx: PipelineContext): void {
  // Handlers receive the SDK instance, which the entry point never gets, so each one parks it in the holder for the sweeper and pipeline.
  server.handle(listRunsRpc, (_input, { paseo }) => {
    ctx.holder.capture(paseo);
    // Most recently touched run first, so the run the user is watching is on top.
    const newestFirst = [...ctx.store.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { runs: newestFirst.map(summarizeRun) };
  });

  server.handle(getRunRpc, ({ runId }) => ({ run: ctx.store.find(runId) ?? null }));

  server.handle(startRunRpc, async (input, { paseo }) => {
    ctx.holder.capture(paseo);
    // Awaited and returned so a failure while creating worktrees or agents reaches the UI's inline error.
    return startRun(ctx, {
      repoPath: input.repoPath,
      title: input.title,
      baseBranch: input.baseBranch,
      mode: input.mode,
      providers: { supervisor: input.supervisorProvider, lead: input.leadProvider, peer: input.peerProvider },
    });
  });

  // Mode is read at each gate decision, so switching it applies to the next hand-over without restarting agents.
  server.handle(setRunModeRpc, ({ runId, mode }) => {
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

  // Needs no SDK capture: resuming only mails the Implementer, which the sweeper delivers once the holder is ready.
  server.handle(resumeTaskRpc, ({ runId, taskId, guidance }) => {
    // Blank guidance is normalised to null so the resume message carries no empty decision block.
    resumeTask(ctx, runId, taskId, guidance?.trim() || null);
    return { ok: true, message: `Task ${taskId} resumed` };
  });

  server.handle(approveMainRpc, async ({ runId }, { paseo }) => {
    ctx.holder.capture(paseo);
    return { ok: true, message: await approveMain(ctx, runId) };
  });

  // Aborting archives agents through the SDK, so the holder must be populated first.
  server.handle(abortRunRpc, async ({ runId }, { paseo }) => {
    ctx.holder.capture(paseo);
    await abortRun(ctx, runId);
    return { ok: true };
  });

  // Reads the log file directly so history survives a daemon restart that cleared in-memory state.
  server.handle(tailLogRpc, async ({ runId, limit }) => {
    const run = ctx.store.find(runId);
    return { entries: run ? await tailCommLog(run.repoPath, runId, limit) : [] };
  });
}
