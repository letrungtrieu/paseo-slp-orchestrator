// Lifecycle hooks (events are best effort, so nothing here is load bearing for correctness):
// capture the SDK handle, answer permissions quickly, and nudge agents that forgot their tool.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { NUDGE_LIMIT } from "../../shared/roles";
import type { PipelineContext } from "../pipeline/context";
import { pauseForEscalation } from "../pipeline/task-pause";
import { nudgeReminder } from "../prompts/messages";
import { handlePermissionRequest } from "./permission-handler";

// last time a turn started per agent; used to tell "the agent answered" from a stale turn end
const lastTurnStartedAt = new Map<string, string>();

function nudgeIfToolMissing(ctx: PipelineContext, agentId: string, outcomeKind: string): void {
  // Unknown agents (not ours) are ignored; only a 'completed' turn counts, an errored or cancelled one is handled by the sweeper.
  const lookup = ctx.store.findAgent(agentId);
  if (!lookup || outcomeKind !== "completed") return;
  const { run, agentRecord } = lookup;
  const turnStartedAt = lastTurnStartedAt.get(agentId);
  const owesTool = agentRecord.awaitingTool && agentRecord.awaitingSince;
  // a turn that began before the request was sent is not the agent's reply to it
  if (!owesTool || !turnStartedAt || turnStartedAt < (agentRecord.awaitingSince ?? "")) return;
  // After NUDGE_LIMIT reminders the agent is considered stuck: pausing hands the decision to the Master Lead instead of nagging forever.
  if (agentRecord.nudges >= NUDGE_LIMIT) {
    ctx.logEvent(run.id, { taskId: agentRecord.taskId, from: agentId, to: "pipeline", kind: "nudge.exhausted", summary: `${agentRecord.role} never called ${agentRecord.awaitingTool}`, outcome: "error" });
    if (agentRecord.taskId) pauseForEscalation(ctx, run.id, agentRecord.taskId, `${agentRecord.role} did not call ${agentRecord.awaitingTool}`);
    // The debt is cleared so the sweeper does not escalate the same missing tool a second time.
    ctx.store.mutate(run.id, (mutableRun) => {
      const mutableRecord = mutableRun.agents[agentId];
      if (mutableRecord) mutableRecord.awaitingTool = null;
    });
    return;
  }
  const owedTool = agentRecord.awaitingTool as string;
  ctx.store.mutate(run.id, (mutableRun) => {
    const mutableRecord = mutableRun.agents[agentId];
    if (mutableRecord) mutableRecord.nudges += 1;
  });
  // The reminder goes through the mailbox like any other mail, so it is only delivered once the agent is idle again.
  ctx.mailbox.enqueue(run.id, agentId, nudgeReminder(owedTool), {
    taskId: agentRecord.taskId,
    awaitTool: owedTool,
    from: "pipeline",
    summary: `nudge: ${owedTool}`,
  });
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
