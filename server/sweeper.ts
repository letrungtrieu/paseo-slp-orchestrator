// Background loop that keeps dynamic stages moving even when lifecycle events are missed:
// answers permissions, delivers queued mail and resumes persisted pipeline stages.
import type { Run } from "../shared/state";
import { isPipelineLeadRole } from "../shared/roles";
import { handlePermissionRequest } from "./hooks/permission-handler";
import { sweepStageNudges } from "./hooks/lifecycle-hooks";
import { collectDescendantAgentIds, handleAgentArchived, handleSupervisorArchived } from "./pipeline/agent-hierarchy";
import { recoverMasterLead } from "./pipeline/agent-revival";
import type { PipelineContext } from "./pipeline/context";
import { sweepPeerShellWatchdog } from "./pipeline/shell-watchdog";
import { recoverPipelines } from "./pipeline/stage-engine";

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
  // Legacy runs retain their historical agent configuration; prompting them after reload would
  // send dynamic tools to agents that were never created with the new protocol.
  if (run.engineVersion !== "dynamic-stages-v1") return;
  // The sweeper polls live status because events are best effort: a missed turn_ended or permission_requested would otherwise stall the run forever.
  const liveStatuses = await ctx.gateway.liveStatuses(run.id);
  // Refresh after the SDK poll: abort/approval can commit while liveStatuses is awaiting Paseo.
  const currentRun = ctx.store.require(run.id);
  if (currentRun.engineVersion !== "dynamic-stages-v1" || ["completed", "aborted"].includes(currentRun.status)) return;
  const supervisorRecord = currentRun.agents[currentRun.supervisorAgentId];
  // If the Supervisor was archived while an event was missed, retire every dependent Lead and Peer instead of reviving them.
  if (supervisorRecord && (supervisorRecord.archivedAt || liveStatuses.get(supervisorRecord.agentId)?.archived)) {
    await handleSupervisorArchived(ctx, currentRun.id, supervisorRecord.archivedAt ?? undefined);
    return;
  }
  // If a Lead was archived while an event was missed, recursively archive its child leads and peers.
  const archivedParentLeadRecords = Object.values(currentRun.agents).filter(
    (agentRecord) =>
      isPipelineLeadRole(agentRecord.role)
      && (Boolean(agentRecord.archivedAt) || Boolean(liveStatuses.get(agentRecord.agentId)?.archived))
      && collectDescendantAgentIds(currentRun, agentRecord.agentId).length > 0,
  );
  for (const archivedParentLead of archivedParentLeadRecords) {
    await handleAgentArchived(
      ctx,
      currentRun.id,
      archivedParentLead.agentId,
      archivedParentLead.archivedAt ?? undefined,
    );
  }
  if (archivedParentLeadRecords.length > 0) {
    const refreshedAfterCascade = ctx.store.require(currentRun.id);
    for (const [agentId, agentRecord] of Object.entries(refreshedAfterCascade.agents)) {
      if (!agentRecord.archivedAt) continue;
      const existingLiveStatus = liveStatuses.get(agentId);
      if (existingLiveStatus && !existingLiveStatus.archived) {
        liveStatuses.set(agentId, { ...existingLiveStatus, archived: true });
      }
    }
  }
  for (const liveStatus of liveStatuses.values()) {
    // Answering here duplicates the event hook on purpose; handlePermissionRequest de-duplicates by request id.
    for (const pendingRequest of liveStatus.pendingPermissions) {
      await handlePermissionRequest(ctx, liveStatus.agentId, pendingRequest);
    }
  }
  // Permission responses can await Paseo long enough for the run to be aborted, so re-check
  // before nudging or handing queued prompts to a stage cohort.
  const activeRun = ctx.store.require(run.id);
  if (activeRun.engineVersion !== "dynamic-stages-v1" || ["completed", "aborted"].includes(activeRun.status)) return;
  const hasDynamicPipeline = Object.keys(activeRun.pipelines).length > 0;
  // Active stage participants, a planning/running Master Lead, and a reporting Supervisor can owe workflow tools.
  if (hasDynamicPipeline || ["planning", "running", "reporting"].includes(activeRun.status)) {
    sweepStageNudges(ctx, activeRun.id, liveStatuses);
  }
  if (hasDynamicPipeline) {
    // Inspect running peer shell outputs before mailbox flush so any newly queued Forked Lead alert delivers on this tick.
    await sweepPeerShellWatchdog(ctx, activeRun, liveStatuses);
  }
  // Respawn a vanished or archived Master Lead before flushing so its transferred or inferred mail delivers immediately.
  await recoverMasterLead(ctx, activeRun.id, liveStatuses);
  // Mail flushes only to agents the poll shows idle/closed/error, which is why replies from tools can return immediately and still be delivered safely.
  await ctx.mailbox.flush(activeRun.id, liveStatuses);
  // A delivery failure confirming a missing recipient marks it archived; re-run Master Lead recovery if that happened.
  if (ctx.store.require(activeRun.id).agents[ctx.store.require(activeRun.id).masterLeadAgentId]?.archivedAt) {
    await recoverMasterLead(ctx, activeRun.id, liveStatuses);
    await ctx.mailbox.flush(activeRun.id, liveStatuses);
  }
  // A dynamic run with no pipeline yet still needs mailbox delivery for its initial delegation.
  if (hasDynamicPipeline) {
    const queuedBeforeRecovery = ctx.store.require(activeRun.id).mailbox.length;
    await recoverPipelines(ctx, activeRun.id);
    if (ctx.store.require(activeRun.id).mailbox.length > queuedBeforeRecovery) {
      await ctx.mailbox.flush(activeRun.id, await ctx.gateway.liveStatuses(activeRun.id));
    }
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
        if (run.engineVersion !== "dynamic-stages-v1") continue;
        // One broken run must not stop the sweep of the others, so its failure is logged and swallowed.
        await sweepRun(ctx, run).catch((sweepError) => console.error(`[slp] sweep of run ${run.id} failed`, sweepError));
      }
    } finally {
      sweepInProgress = false;
    }
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
