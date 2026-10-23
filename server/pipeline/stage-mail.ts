// Construct durable mail without sending it so stage state and its notification can share one SQLite mutation.
import { randomUUID } from "node:crypto";
import type { MailboxMessage } from "../../shared/state";

export function stageMail(toAgentId: string, text: string, awaitTool: string | null = null): MailboxMessage {
  // Stage traffic has its own pipeline/stage identity in the payload; the retired task id is deliberately absent.
  return { id: randomUUID(), toAgentId, text, taskId: null, awaitTool, isReminder: false, questionId: null, createdAt: new Date().toISOString() };
}
