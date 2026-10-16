// Background loop that keeps the pipeline moving even when lifecycle events are missed:
// answers pending permissions, delivers queued mail to idle agents and restarts stuck tasks.
import type { Run } from "../shared/state";
import { handlePermissionRequest } from "./hooks/permission-handler";
import type { PipelineContext } from "./pipeline/context";
import { isStartingTasks, queuedTasks, startQueuedTasks } from "./pipeline/task-start";

// 3 s keeps permission prompts and mail feeling immediate without hammering the daemon's agent directory.
const SWEEP_INTERVAL_MS = 3_000;
// Finished runs (completed, aborted) are skipped: nothing may be nudged, mailed or restarted for them.
const ACTIVE_RUN_STATUSES: ReadonlySet<Run["status"]> = new Set([
  "initializing",
  "delegating",
  "planning",
  "running",
  "reporting",
  "awaiting_user",
]);

async function sweepRun(ctx: PipelineContext, run: Run): Promise<void> {
  // The sweeper polls live status because events are best effort: a missed turn_ended or permission_requested would otherwise stall the run forever.
  const liveStatuses = await ctx.gateway.liveStatuses(run.id);
  for (const liveStatus of liveStatuses.values()) {
    // Answering here duplicates the event hook on purpose; handlePermissionRequest de-duplicates by request id.
    for (const pendingRequest of liveStatus.pendingPermissions) {
      await handlePermissionRequest(ctx, liveStatus.agentId, pendingRequest);
    }
  }
  // Mail flushes only to agents the poll shows idle, which is why replies from tools can return immediately and still be delivered safely.
  await ctx.mailbox.flush(run.id, liveStatuses);
  // after a plugin restart tasks can sit in "queued" with nobody forking them
  const stuckQueuedTasks = queuedTasks(run.tasks);
  // Only 'running': during delegating/planning the Master Lead's own call to slp_define_tasks starts tasks, and recovery must not race it.
  if (stuckQueuedTasks.length > 0 && !isStartingTasks(run.id) && run.status === "running") {
    void startQueuedTasks(ctx, run.id).catch((startError) => console.error("[slp] recovery start failed", startError));
  }
}

export function startSweeper(ctx: PipelineContext): () => void {
  let sweepInProgress = false;
  const timer = setInterval(async () => {
    // a slow sweep must not stack with the next tick
    // The holder is empty until a hook or RPC handler has captured the SDK, so early ticks are skipped rather than failing.
    if (sweepInProgress || !ctx.holder.isReady()) return;
    sweepInProgress = true;
    try {
      for (const run of ctx.store.list()) {
        if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
        // One broken run must not stop the sweep of the others, so its failure is logged and swallowed.
        await sweepRun(ctx, run).catch((sweepError) => console.error(`[slp] sweep of run ${run.id} failed`, sweepError));
      }
    } finally {
      sweepInProgress = false;
    }
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
