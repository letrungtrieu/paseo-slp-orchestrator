// Queue of prompts waiting for an agent to become idle. Sending to a running agent would
// interrupt its turn (Paseo cancels the active turn on a new prompt), so delivery waits.
import { randomUUID } from "node:crypto";
import type { MailboxMessage } from "../../shared/state";
import type { AgentGateway, AgentLiveStatus } from "./agent-gateway";
import type { RunStore } from "../store/run-store";

export interface EnqueueOptions {
  taskId: string | null;
  // bus tool the recipient owes after this message; null when no reply is expected
  awaitTool: string | null;
  // label of the sender for the audit log
  from: string;
  summary: string;
}

export type MailLogger = (
  runId: string,
  entry: { taskId: string | null; from: string; to: string; kind: string; summary: string; outcome: "queued" | "delivered" | "error" | "blocked"; reason?: string },
) => void;

export class Mailbox {
  // runs currently being flushed; prevents the sweeper and a turn-ended hook double-sending
  private readonly flushingRuns = new Set<string>();

  constructor(
    private readonly store: RunStore,
    private readonly gateway: AgentGateway,
    private readonly logMail: MailLogger,
  ) {}

  // Enqueue never sends: it is called from inside tool handlers, whose reply must return immediately, and the target is usually busy anyway.
  enqueue(runId: string, toAgentId: string, text: string, options: EnqueueOptions): void {
    const queuedMessage: MailboxMessage = {
      id: randomUUID(),
      toAgentId,
      text,
      taskId: options.taskId,
      awaitTool: options.awaitTool,
      createdAt: new Date().toISOString(),
    };
    // Persisted in the run so queued mail survives a plugin reload; the sweeper flushes it when the plugin comes back.
    this.store.mutate(runId, (run) => {
      run.mailbox.push(queuedMessage);
    });
    this.logMail(runId, {
      taskId: options.taskId,
      from: options.from,
      to: toAgentId,
      kind: "mail",
      summary: options.summary,
      outcome: "queued",
    });
  }

  // Delivers one combined prompt to every idle agent that has mail. Returns the delivery count.
  async flush(runId: string, liveStatuses: Map<string, AgentLiveStatus>): Promise<number> {
    if (this.flushingRuns.has(runId)) return 0;
    this.flushingRuns.add(runId);
    let deliveredCount = 0;
    try {
      // One prompt per recipient: several queued notices merged into a single turn cost one model call instead of cancelling each other.
      const queuedByRecipient = new Map<string, MailboxMessage[]>();
      for (const queuedMessage of this.store.require(runId).mailbox) {
        const recipientQueue = queuedByRecipient.get(queuedMessage.toAgentId) ?? [];
        recipientQueue.push(queuedMessage);
        queuedByRecipient.set(queuedMessage.toAgentId, recipientQueue);
      }
      for (const [recipientId, recipientMessages] of queuedByRecipient) {
        const recipientStatus = liveStatuses.get(recipientId);
        // 'closed' agents are persisted and resume on the next prompt; running ones must wait
        const canReceive =
          recipientStatus &&
          !recipientStatus.archived &&
          (recipientStatus.status === "idle" || recipientStatus.status === "closed") &&
          // A pending permission blocks delivery: a new prompt would cancel the turn that is waiting for the answer.
          recipientStatus.pendingPermissions.length === 0;
        if (!canReceive) continue;
        if (await this.deliver(runId, recipientId, recipientMessages)) deliveredCount += 1;
      }
    } finally {
      this.flushingRuns.delete(runId);
    }
    return deliveredCount;
  }

  private async deliver(runId: string, recipientId: string, messages: MailboxMessage[]): Promise<boolean> {
    const deliveredIds = new Set(messages.map((message) => message.id));
    // removed first so a slow send cannot be repeated by a concurrent sweep
    this.store.mutate(runId, (run) => {
      run.mailbox = run.mailbox.filter((message) => !deliveredIds.has(message.id));
    });
    // Joined in arrival order with a separator so the agent can still tell the messages apart.
    const combinedText = messages.map((message) => message.text).join("\n\n---\n\n");
    // The newest owed tool wins: it describes what the agent must do after reading all of the mail.
    const owedTool = [...messages].reverse().find((message) => message.awaitTool)?.awaitTool ?? null;
    try {
      // stamped before sending: the agent's turn_started event can arrive before send() resolves
      this.store.mutate(runId, (run) => {
        const recipientRecord = run.agents[recipientId];
        if (recipientRecord) {
          // plain information mail (no owed tool) must not erase an obligation still pending
          if (owedTool) {
            recipientRecord.awaitingTool = owedTool;
            recipientRecord.awaitingSince = new Date().toISOString();
            // Reset so nudges for a previous obligation do not count against the new one.
            recipientRecord.nudges = 0;
          }
        }
      });
      await this.gateway.prompt(recipientId, combinedText);
      this.logMail(runId, {
        taskId: messages[0].taskId,
        from: "mailbox",
        to: recipientId,
        kind: "mail",
        summary: `${messages.length} message(s) delivered`,
        outcome: "delivered",
      });
      return true;
    } catch (sendError) {
      // Re-queued at the front to keep ordering relative to mail enqueued while the send was in flight.
      // put the mail back so the next sweep retries instead of silently losing it
      this.store.mutate(runId, (run) => {
        run.mailbox.unshift(...messages);
      });
      this.logMail(runId, {
        taskId: messages[0].taskId,
        from: "mailbox",
        to: recipientId,
        kind: "mail",
        summary: "delivery failed, will retry",
        outcome: "error",
        reason: sendError instanceof Error ? sendError.message : String(sendError),
      });
      return false;
    }
  }
}
