// Lifecycle hooks (events are best effort, so nothing here is load bearing for correctness):
// capture the SDK handle, answer permissions quickly, and nudge agents that forgot their tool.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { NUDGE_LIMIT } from "../../shared/roles";
import type { AgentRecord, Run } from "../../shared/state";
import type { PipelineContext } from "../pipeline/context";
import { pausePipelineForAgent } from "../pipeline/stage-context";
import { nudgeReminder } from "../prompts/messages";
import type { AgentLiveStatus } from "../runtime/agent-gateway";
import { handlePermissionRequest } from "./permission-handler";
import { stageMail } from "../pipeline/stage-mail";

// last time a turn started per agent; used to tell "the agent answered" from a stale turn end
const lastTurnStartedAt = new Map<string, string>();
// A missed event is recovered once per obligation; mailbox delivery changes awaitingSince and arms the next reminder.
const lastSweeperNudgeByAgent = new Map<string, string>();
const NUDGE_GRACE_PERIOD_MS = 10_000;
// A direct question must not leave its sender waiting forever when the recipient is idle or gone.
export const DIRECT_REPLY_TIMEOUT_MS = 120_000;

function agentOwnsCurrentStage(run: Run, agentRecord: AgentRecord): boolean {
  if (run.engineVersion !== "dynamic-stages-v1" || run.status !== "running"
    || !agentRecord.pipelineId || !agentRecord.stageId || agentRecord.archivedAt) return false;
  const pipeline = run.pipelines[agentRecord.pipelineId];
  const currentStage = pipeline?.stages[pipeline.currentStageIndex];
  return Boolean(pipeline?.status === "running"
    && currentStage?.id === agentRecord.stageId
    && currentStage.status === "running");
}

function stageObligationFor(agentRecord: AgentRecord): string | null {
  if (agentRecord.deferredTool) return agentRecord.deferredTool;
  if (agentRecord.role === "peer") return "slp_stage_report";
  if (agentRecord.role === "forked_lead") return "slp_approve_stage";
  return null;
}

function restoreExpiredDirectReply(ctx: PipelineContext, run: Run, agentId: string): boolean {
  const currentAgent = run.agents[agentId];
  if (!currentAgent?.waitingForAgentId || !currentAgent.awaitingSince
    || !agentOwnsCurrentStage(run, currentAgent)) return false;
  const startedAtMs = Date.parse(currentAgent.awaitingSince);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < DIRECT_REPLY_TIMEOUT_MS) return false;
  const recipientAgentId = currentAgent.waitingForAgentId;
  let queued = false;
  let restoredTool: string | null = null;
  ctx.store.mutate(run.id, (mutableRun) => {
    const mutableAgent = mutableRun.agents[agentId];
    if (!mutableAgent.waitingForAgentId || !mutableAgent.awaitingSince
      || !agentOwnsCurrentStage(mutableRun, mutableAgent)) return;
    const refreshedStartedAtMs = Date.parse(mutableAgent.awaitingSince);
    if (!Number.isFinite(refreshedStartedAtMs) || Date.now() - refreshedStartedAtMs < DIRECT_REPLY_TIMEOUT_MS) return;
    const stage = mutableRun.pipelines[mutableAgent.pipelineId!]?.stages.find((candidate) => candidate.id === mutableAgent.stageId);
    if (!stage) return;
    restoredTool = stageObligationFor(mutableAgent);
    if (!restoredTool) return;
    mutableAgent.waitingForAgentId = null;
    mutableAgent.deferredTool = null;
    mutableAgent.awaitingTool = null;
    mutableAgent.awaitingSince = null;
    mutableAgent.nudges = 0;
    mutableRun.mailbox.push(stageMail(agentId,
      `No reply was received from peer ${recipientAgentId} within ${DIRECT_REPLY_TIMEOUT_MS / 1000} seconds. Continue stage '${stage.name}' and call ${restoredTool}; use slp_escalate if the missing response blocks the goal.`,
      restoredTool));
    queued = true;
  });
  if (queued) {
    ctx.logEvent(run.id, {
      taskId: null,
      from: "pipeline",
      to: agentId,
      kind: "stage.direct_reply_timeout",
      summary: `No reply from ${recipientAgentId}; restored ${restoredTool}`,
      outcome: "queued",
    });
  }
  return queued;
}

function nudgeIfToolMissing(ctx: PipelineContext, agentId: string, outcomeKind: string, recoveredFromPoll = false): boolean {
  // Unknown, archived and legacy task agents are ignored; dynamic stages own their obligations.
  const lookup = ctx.store.findAgent(agentId);
  if (!lookup || outcomeKind !== "completed") return false;
  const { run, agentRecord } = lookup;
  if (!agentOwnsCurrentStage(run, agentRecord)) return false;
  // A queued assignment is still waiting for its first delivery; nudging the recipient now
  // would create an owed-tool clock before the model has seen the stage roster.
  if (run.mailbox.some((message) => message.toAgentId === agentId)) return false;
  const turnStartedAt = lastTurnStartedAt.get(agentId);
  const owesTool = agentRecord.awaitingTool && agentRecord.awaitingSince;
  const expectedStageTool = agentRecord.role === "peer"
    ? "slp_stage_report"
    : agentRecord.role === "forked_lead" ? "slp_approve_stage" : null;
  // A stale legacy obligation must never nudge a dynamic cohort for the wrong protocol step.
  if (expectedStageTool && agentRecord.awaitingTool !== expectedStageTool) return false;
  // a turn that began before the request was sent is not the agent's reply to it
  if (!owesTool || (!recoveredFromPoll && !turnStartedAt) || (!recoveredFromPoll && turnStartedAt! < (agentRecord.awaitingSince ?? ""))) return false;
  // After NUDGE_LIMIT reminders the owner Forked Lead decides whether the stage can continue.
  if (agentRecord.nudges >= NUDGE_LIMIT) {
    const reason = `${agentRecord.projectRole ?? agentRecord.role} did not call ${agentRecord.awaitingTool}`;
    ctx.logEvent(run.id, { taskId: null, from: agentId, to: "pipeline", kind: "nudge.exhausted", summary: reason, outcome: "error" });
    // The helper routes the pause to the owning Forked Lead and records the durable pipeline state.
    pausePipelineForAgent(ctx, agentId, reason);
    ctx.store.mutate(run.id, (mutableRun) => {
      const mutableRecord = mutableRun.agents[agentId];
      if (mutableRecord) {
        mutableRecord.awaitingTool = null;
        mutableRecord.awaitingSince = null;
      }
    });
    return true;
  }
  const owedTool = agentRecord.awaitingTool as string;
  ctx.store.mutate(run.id, (mutableRun) => {
    const mutableRecord = mutableRun.agents[agentId];
    if (mutableRecord) mutableRecord.nudges += 1;
  });
  // The reminder goes through the mailbox like any other mail, so it is only delivered once the agent is idle again.
  if (agentRecord.awaitingSince) lastSweeperNudgeByAgent.set(agentId, agentRecord.awaitingSince);
  ctx.mailbox.enqueue(run.id, agentId, nudgeReminder(owedTool), {
    taskId: null,
    awaitTool: owedTool,
    isReminder: true,
    from: "pipeline",
    summary: `nudge: ${owedTool}`,
  });
  return true;
}

export function sweepStageNudges(ctx: PipelineContext, runId: string, liveStatuses: Map<string, AgentLiveStatus>): void {
  const run = ctx.store.require(runId);
  // The directory poll is the recovery path for a dropped turn-ended event after reload.
  for (const [agentId, liveStatus] of liveStatuses) {
    if (liveStatus.archived || (liveStatus.status !== "idle" && liveStatus.status !== "closed")) continue;
    const lookup = ctx.store.findAgent(agentId);
    if (!lookup || lookup.run.id !== runId) continue;
    if (!agentOwnsCurrentStage(run, lookup.agentRecord)) continue;
    if (lookup.agentRecord.waitingForAgentId && lookup.agentRecord.awaitingSince) {
      // A direct reply timeout restores the stage obligation instead of pausing the whole pipeline.
      if (restoreExpiredDirectReply(ctx, run, agentId)) continue;
    }
    if (!lookup.agentRecord.awaitingTool || !lookup.agentRecord.awaitingSince) continue;
    // Initial/rework mail must be delivered before the sweeper starts counting a reply timeout.
    if (run.mailbox.some((message) => message.toAgentId === agentId)) continue;
    const obligationStartedAt = lookup.agentRecord.awaitingSince;
    // The SDK can report idle after accepting a prompt but before its turn-start event arrives;
    // leave a short recovery window so that transient startup latency is not treated as silence.
    const obligationAgeMs = Date.now() - Date.parse(obligationStartedAt);
    if (Number.isFinite(obligationAgeMs) && obligationAgeMs < NUDGE_GRACE_PERIOD_MS) continue;
    if (lastSweeperNudgeByAgent.get(agentId) === obligationStartedAt) continue;
    if (nudgeIfToolMissing(ctx, agentId, "completed", true)) {
      lastSweeperNudgeByAgent.set(agentId, obligationStartedAt);
    }
  }
}

export function registerLifecycleHooks(server: PluginServerContext, ctx: PipelineContext): () => void {
  const removers = [
    server.on("agent.turn_started", (event, hookContext) => {
      // Every hook captures the SDK handle: it is only handed to hooks and RPC handlers, never to the plugin entry.
      ctx.holder.capture(hookContext.paseo);
      lastTurnStartedAt.set(event.agent.id, new Date().toISOString());
    }),
    server.on("agent.turn_ended", (event, hookContext) => {
      ctx.holder.capture(hookContext.paseo);
      nudgeIfToolMissing(ctx, event.agent.id, event.outcome.kind);
    }),
    // Answered inside the event for low latency; the sweeper repeats this for events that were never delivered.
    server.on("agent.permission_requested", async (event, hookContext) => {
      ctx.holder.capture(hookContext.paseo);
      await handlePermissionRequest(ctx, event.agent.id, event.request);
    }),
  ];
  return () => removers.forEach((remove) => remove());
}
