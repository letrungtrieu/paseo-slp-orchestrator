// Reconciles the question ledger with reality on every sweeper tick. Waking a blocked agent is only a latency
// optimisation; this pass is what guarantees that no question or answer is lost to a timeout, a reload or a dropped connection.
import type { PeerQuestion, PeerQuestionExpireReason } from "../../../shared/peer-questions";
import type { AgentLiveStatus } from "../../runtime/agent-gateway";
import { expiredText, questionReminderText } from "../../prompts/question-messages";
import type { PipelineContext } from "../context";
import { hasQueuedMail, queueAnswerMail, queueQuestionMail } from "./question-delivery";

function isAgentUnavailable(ctx: PipelineContext, runId: string, agentId: string): boolean {
  const agentRecord = ctx.store.require(runId).agents[agentId];
  return !agentRecord || Boolean(agentRecord.archivedAt);
}

function expireReasonFor(ctx: PipelineContext, pendingQuestion: PeerQuestion, nowMs: number): PeerQuestionExpireReason | null {
  // A dead asker no longer needs an answer, and a dead recipient will never give one: neither should wait out the full lifetime.
  if (isAgentUnavailable(ctx, pendingQuestion.runId, pendingQuestion.fromAgentId)) return "asker_unavailable";
  if (isAgentUnavailable(ctx, pendingQuestion.runId, pendingQuestion.toAgentId)) return "recipient_unavailable";
  return nowMs - Date.parse(pendingQuestion.createdAt) >= ctx.questionTiming.questionTtlMs ? "timeout" : null;
}

function expireQuestion(ctx: PipelineContext, pendingQuestion: PeerQuestion, expireReason: PeerQuestionExpireReason): void {
  const expiredAt = new Date().toISOString();
  // The ledger refuses to expire a question that was answered a moment ago, so a lost race changes nothing.
  if (!ctx.store.questions.expire(pendingQuestion.questionId, expiredAt, expireReason)) return;
  const runId = pendingQuestion.runId;
  // An undelivered question must not reach its recipient after the asker has already been told to move on.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.questionId === pendingQuestion.questionId && queuedMessage.toAgentId === pendingQuestion.toAgentId),
    );
  });
  ctx.logEvent(runId, {
    taskId: null, from: "pipeline", to: pendingQuestion.fromAgentId, kind: "question.expired",
    summary: `${pendingQuestion.questionId}: ${expireReason}`, outcome: "error", reason: expireReason,
  });
  if (expireReason === "asker_unavailable") return;
  const expiredQuestion = ctx.store.questions.require(pendingQuestion.questionId);
  // A blocked asker reads the expiry from its own call; anyone else is told by mail.
  if (ctx.questionWaits.isWaitingOn(expiredQuestion.fromAgentId, expiredQuestion.questionId)) {
    ctx.questionWaits.wakeAgent(expiredQuestion.fromAgentId);
    return;
  }
  ctx.mailbox.enqueue(runId, expiredQuestion.fromAgentId, expiredText(expiredQuestion), {
    taskId: null, awaitTool: null, from: "pipeline", summary: `question ${expiredQuestion.questionId} expired`,
  });
}

function remindRecipientIfIdle(
  ctx: PipelineContext,
  deliveredQuestion: PeerQuestion,
  liveStatuses: Map<string, AgentLiveStatus>,
  nowMs: number,
): void {
  const { reminderAfterMs, maxReminders } = ctx.questionTiming;
  if (!deliveredQuestion.deliveredAt || deliveredQuestion.reminderCount >= maxReminders) return;
  // Reminders only make sense for a recipient that ended its turn without answering; a running agent may still be on it.
  if (liveStatuses.get(deliveredQuestion.toAgentId)?.status !== "idle") return;
  const lastContactMs = Date.parse(deliveredQuestion.lastRemindedAt ?? deliveredQuestion.deliveredAt);
  if (nowMs - lastContactMs < reminderAfterMs) return;
  const run = ctx.store.require(deliveredQuestion.runId);
  if (hasQueuedMail(run, deliveredQuestion.toAgentId, deliveredQuestion.questionId)) return;
  ctx.mailbox.enqueue(run.id, deliveredQuestion.toAgentId, questionReminderText(run, deliveredQuestion), {
    taskId: null, awaitTool: null, isReminder: true, from: "pipeline",
    summary: `reminder for question ${deliveredQuestion.questionId}`, questionId: deliveredQuestion.questionId,
  });
  ctx.store.questions.recordReminder(deliveredQuestion.questionId, new Date(nowMs).toISOString());
}

export function sweepPeerQuestions(ctx: PipelineContext, runId: string, liveStatuses: Map<string, AgentLiveStatus>): void {
  const nowMs = Date.now();
  const ledger = ctx.store.questions;
  for (const pendingQuestion of ledger.listPending(runId)) {
    const expireReason = expireReasonFor(ctx, pendingQuestion, nowMs);
    if (expireReason) {
      expireQuestion(ctx, pendingQuestion, expireReason);
      continue;
    }
    const run = ctx.store.require(runId);
    if (!pendingQuestion.deliveredAt) {
      // Never reached the recipient (the wake-up was lost, or the plugin reloaded): queue it as ordinary mail.
      if (!ctx.questionWaits.isWaiting(pendingQuestion.toAgentId) && !hasQueuedMail(run, pendingQuestion.toAgentId, pendingQuestion.questionId)) {
        queueQuestionMail(ctx, pendingQuestion);
      }
      continue;
    }
    remindRecipientIfIdle(ctx, pendingQuestion, liveStatuses, nowMs);
  }
  for (const unreadAnswer of ledger.listUnconsumedAnswers(runId)) {
    const run = ctx.store.require(runId);
    // The asker is gone or still blocked in a call that will read the answer itself.
    if (isAgentUnavailable(ctx, runId, unreadAnswer.fromAgentId) || ctx.questionWaits.isWaiting(unreadAnswer.fromAgentId)) continue;
    if (!hasQueuedMail(run, unreadAnswer.fromAgentId, unreadAnswer.questionId)) queueAnswerMail(ctx, unreadAnswer);
  }
}
