// slp_notify: a one-way notification. Nothing waits on it and no reply is owed, so it only travels through the mailbox.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../../bus/http-mcp";
import { notificationText } from "../../prompts/question-messages";
import type { PipelineContext } from "../context";
import { ToolError } from "../tool-error";
import { recordRouteHistory, resolvePeerRoute } from "./peer-route";

export function notifyAgent(ctx: PipelineContext, caller: BusCaller, input: { toAgentId: string; message: string }): string {
  const run = ctx.store.require(caller.runId);
  const senderRecord = run.agents[caller.agentId];
  if (!senderRecord || senderRecord.archivedAt) throw new ToolError("This tool requires an active agent session.");
  const route = resolvePeerRoute(run, senderRecord, input.toAgentId);
  const createdAt = new Date().toISOString();
  // History and queued mail commit in one mutation so a reload can never keep one without the other.
  ctx.store.mutate(run.id, (mutableRun) => {
    recordRouteHistory(route, { id: randomUUID(), fromAgentId: caller.agentId, toAgentId: input.toAgentId, message: input.message, createdAt });
    mutableRun.mailbox.push({
      id: randomUUID(),
      toAgentId: input.toAgentId,
      text: notificationText(route.scopeLabel, route.senderDescription, input.message),
      taskId: null,
      awaitTool: null,
      isReminder: false,
      questionId: null,
      supersedeKey: null,
      createdAt,
    });
  });
  ctx.logEvent(run.id, {
    taskId: null, from: caller.agentId, to: input.toAgentId, kind: "stage.message",
    summary: input.message.slice(0, 240), outcome: "queued",
  });
  return "Notification queued. Continue your assignment; if you need an answer, use slp_ask instead.";
}
