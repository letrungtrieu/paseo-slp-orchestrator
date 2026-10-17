// Queue of prompts waiting for an agent to become idle. Sending to a running agent would
// interrupt its turn (Paseo cancels the active turn on a new prompt), so delivery waits.
import { randomUUID } from "node:crypto";
import type { MailboxMessage, Run } from "../../shared/state";
import type { AgentGateway, AgentLiveStatus } from "./agent-gateway";
import type { RunStore } from "../store/run-store";

export interface EnqueueOptions {
  taskId: string | null;
  // bus tool the recipient owes after this message; null when no reply is expected
  awaitTool: string | null;
  // Reminder mail continues the same obligation, so delivery must preserve its nudge count.
  isReminder?: boolean;
  // label of the sender for the audit log
  from: string;
  summary: string;
}

export type MailLogger = (
  runId: string,
  entry: { taskId: string | null; from: string; to: string; kind: string; summary: string; outcome: "queued" | "delivered" | "error" | "blocked"; reason?: string },
) => void;

function stageCanReceiveMail(run: Run, recipientId: string): boolean {
  // A queued prompt must never revive a completed, aborted or legacy engine after a reload.
  if (run.engineVersion !== "dynamic-stages-v1" || run.status === "completed" || run.status === "aborted") return false;
  const agentRecord = run.agents[recipientId];
  // Persisted archive state wins over a stale SDK directory entry after a restart.
  if (!agentRecord || agentRecord.archivedAt) return false;
  if (!agentRecord.pipelineId && !agentRecord.stageId) return true;
  if (!agentRecord.pipelineId || !agentRecord.stageId) return false;
  const pipeline = run.pipelines[agentRecord.pipelineId];
  const currentStage = pipeline?.stages[pipeline.currentStageIndex];
  // Closed or paused cohorts must not receive late reports or direct messages.
  return pipeline?.status === "running"
    && currentStage?.id === agentRecord.stageId
    && currentStage.status === "running";
}

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
      isReminder: options.isReminder ?? false,
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
        // Re-read before every recipient: a previous delivery can race an abort or stage closure.
        const recipientRun = this.store.require(runId);
        if (recipientRun.engineVersion !== "dynamic-stages-v1" || ["completed", "aborted"].includes(recipientRun.status)) break;
        const recipientStatus = liveStatuses.get(recipientId);
        if (!stageCanReceiveMail(recipientRun, recipientId)) continue;
        // 'closed' agents are persisted and resume on the next prompt; running ones must wait
        const canReceive =
          recipientStatus &&
          !recipientStatus.archived &&
          (recipientStatus.status === "idle" || recipientStatus.status === "closed") &&
          // A pending permission blocks delivery: a new prompt would cancel the turn that is waiting for the answer.
          recipientStatus.pendingPermissions.length === 0;
        if (!canReceive) continue;
        // Select only rows still queued immediately before delivery; stage closure may have removed
        // part of the original group while another recipient was being prompted.
        const latestRun = this.store.require(runId);
        if (latestRun.engineVersion !== "dynamic-stages-v1" || ["completed", "aborted"].includes(latestRun.status)) break;
        if (!stageCanReceiveMail(latestRun, recipientId)) continue;
        const queuedIds = new Set(recipientMessages.map((message) => message.id));
        const liveRecipientMessages = latestRun.mailbox.filter(
          (message) => message.toAgentId === recipientId && queuedIds.has(message.id),
        );
        if (liveRecipientMessages.length === 0) continue;
        if (await this.deliver(runId, recipientId, liveRecipientMessages)) deliveredCount += 1;
      }
    } finally {
      this.flushingRuns.delete(runId);
    }
    return deliveredCount;
  }

  private async deliver(runId: string, recipientId: string, messages: MailboxMessage[]): Promise<boolean> {
    const deliveredIds = new Set(messages.map((message) => message.id));
    // This guard is repeated inside the synchronous mutation so an abort cannot stamp a stale
    // owed-tool obligation after the outer flush's last read.
    const preflightRun = this.store.require(runId);
    if (!stageCanReceiveMail(preflightRun, recipientId)
      || !preflightRun.mailbox.some((message) => deliveredIds.has(message.id))) return false;
    // Joined in arrival order with a separator so the agent can still tell the messages apart.
    const combinedText = messages.map((message) => message.text).join("\n\n---\n\n");
    // The newest owed tool wins: it describes what the agent must do after reading all of the mail.
    const latestOwedMessage = [...messages].reverse().find((message) => message.awaitTool);
    const owedTool = latestOwedMessage?.awaitTool ?? null;
    try {
      // stamped before sending: the agent's turn_started event can arrive before send() resolves
      let stampedForCurrentRun = false;
      this.store.mutate(runId, (run) => {
        if (!stageCanReceiveMail(run, recipientId)
          || !run.mailbox.some((message) => deliveredIds.has(message.id))) return;
        const recipientRecord = run.agents[recipientId];
        if (recipientRecord) {
          // plain information mail (no owed tool) must not erase an obligation still pending
          if (owedTool) {
            recipientRecord.awaitingTool = owedTool;
            recipientRecord.awaitingSince = new Date().toISOString();
            // Only fresh assignment mail starts a new obligation; reminders retain the circuit-breaker count.
            if (!latestOwedMessage?.isReminder) recipientRecord.nudges = 0;
          }
          stampedForCurrentRun = true;
        }
      });
      if (!stampedForCurrentRun) return false;
      await this.gateway.prompt(recipientId, combinedText);
      // Remove only after Paseo accepts the prompt; a crash before this mutation leaves mail
      // queued for retry, which is safer than silently losing a stage assignment.
      this.store.mutate(runId, (run) => {
        run.mailbox = run.mailbox.filter((message) => !deliveredIds.has(message.id));
      });
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
      // The original rows remain queued, including messages added while the send was in flight.
      // Keeping one durable copy avoids duplicate rows when prompt acceptance races a failure.
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
