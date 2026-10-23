// Durable ask/answer ledger between agents. Every transition is a single small SQL statement, so a
// question never rewrites the Run payload and the audit survives plugin reloads untouched.
import type { DatabaseSync } from "node:sqlite";
import {
  PeerQuestionSchema,
  type PeerQuestion,
  type PeerQuestionExpireReason,
  type PeerRouteScope,
} from "../../shared/peer-questions";

export interface NewPeerQuestion {
  questionId: string;
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  scope: PeerRouteScope;
  pipelineId: string | null;
  question: string;
  createdAt: string;
}

function mapQuestionRow(questionRow: Record<string, unknown>): PeerQuestion {
  // Parsing every row means a corrupt or hand-edited ledger fails loudly instead of feeding agents bad state.
  return PeerQuestionSchema.parse({
    questionId: questionRow.question_id,
    runId: questionRow.run_id,
    fromAgentId: questionRow.from_agent_id,
    toAgentId: questionRow.to_agent_id,
    scope: questionRow.scope,
    pipelineId: questionRow.pipeline_id,
    status: questionRow.status,
    question: questionRow.question,
    answer: questionRow.answer,
    createdAt: questionRow.created_at,
    deliveredAt: questionRow.delivered_at,
    answeredAt: questionRow.answered_at,
    answerDeliveredAt: questionRow.answer_delivered_at,
    expiredAt: questionRow.expired_at,
    expireReason: questionRow.expire_reason,
    reminderCount: questionRow.reminder_count,
    lastRemindedAt: questionRow.last_reminded_at,
  });
}

export class QuestionStore {
  // The connection is resolved per call because RunStore opens it lazily and closes it on shutdown.
  constructor(private readonly connection: () => DatabaseSync) {}

  insert(newQuestion: NewPeerQuestion): PeerQuestion {
    this.connection().prepare(`
      INSERT INTO questions(question_id, run_id, from_agent_id, to_agent_id, scope, pipeline_id, status, question, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      newQuestion.questionId, newQuestion.runId, newQuestion.fromAgentId, newQuestion.toAgentId,
      newQuestion.scope, newQuestion.pipelineId, newQuestion.question, newQuestion.createdAt,
    );
    return this.require(newQuestion.questionId);
  }

  find(questionId: string): PeerQuestion | null {
    const questionRow = this.connection().prepare("SELECT * FROM questions WHERE question_id = ?").get(questionId);
    return questionRow ? mapQuestionRow(questionRow) : null;
  }

  require(questionId: string): PeerQuestion {
    const foundQuestion = this.find(questionId);
    if (!foundQuestion) throw new Error(`Unknown peer question: ${questionId}`);
    return foundQuestion;
  }

  // Oldest first so a recipient works through questions in the order they were asked.
  listPendingForRecipient(runId: string, recipientAgentId: string): PeerQuestion[] {
    return this.connection().prepare(
      "SELECT * FROM questions WHERE run_id = ? AND to_agent_id = ? AND status = 'pending' ORDER BY created_at, rowid",
    ).all(runId, recipientAgentId).map(mapQuestionRow);
  }

  // Undelivered pending questions are what a recipient sitting in its own blocking wait still has to read.
  listUndeliveredForRecipient(runId: string, recipientAgentId: string): PeerQuestion[] {
    return this.listPendingForRecipient(runId, recipientAgentId).filter((pendingQuestion) => !pendingQuestion.deliveredAt);
  }

  // An answer nobody has read yet: the asker's wait, or a mail reconciled by the sweeper, must still deliver it.
  listUnconsumedAnswers(runId: string, askerAgentId?: string): PeerQuestion[] {
    return this.connection().prepare(`
      SELECT * FROM questions
      WHERE run_id = ? AND status IN ('answered', 'answered_late') AND answer_delivered_at IS NULL
        AND (? IS NULL OR from_agent_id = ?)
      ORDER BY answered_at, rowid
    `).all(runId, askerAgentId ?? null, askerAgentId ?? null).map(mapQuestionRow);
  }

  countPendingFromAsker(runId: string, askerAgentId: string): number {
    const countRow = this.connection().prepare(
      "SELECT COUNT(*) AS open_count FROM questions WHERE run_id = ? AND from_agent_id = ? AND status = 'pending'",
    ).get(runId, askerAgentId);
    return Number(countRow?.open_count ?? 0);
  }

  listPending(runId: string): PeerQuestion[] {
    return this.connection().prepare(
      "SELECT * FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at, rowid",
    ).all(runId).map(mapQuestionRow);
  }

  // Newest first with a hard cap: an old run's whole history never has to enter memory for the audit view.
  listForRun(runId: string, limit: number): PeerQuestion[] {
    return this.connection().prepare(
      "SELECT * FROM questions WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(runId, Math.max(1, Math.min(2000, Math.trunc(limit)))).map(mapQuestionRow);
  }

  // Marks whichever side of the exchange a prompt just reached: the question for its recipient, and
  // the answer for its asker. Scoping by agent id keeps one id list safe to apply to either direction.
  markDeliveredTo(recipientAgentId: string, questionIds: string[], deliveredAt: string): void {
    const database = this.connection();
    for (const questionId of questionIds) {
      database.prepare(
        "UPDATE questions SET delivered_at = ? WHERE question_id = ? AND to_agent_id = ? AND delivered_at IS NULL",
      ).run(deliveredAt, questionId, recipientAgentId);
      database.prepare(`
        UPDATE questions SET answer_delivered_at = ?
        WHERE question_id = ? AND from_agent_id = ? AND answer_delivered_at IS NULL AND status IN ('answered', 'answered_late')
      `).run(deliveredAt, questionId, recipientAgentId);
    }
  }

  // An expired question can still be answered; that keeps the late reply in the audit as answered_late.
  recordAnswer(questionId: string, answerText: string, answeredAt: string): PeerQuestion {
    this.connection().prepare(`
      UPDATE questions
      SET answer = ?, answered_at = ?, status = CASE status WHEN 'expired' THEN 'answered_late' ELSE 'answered' END
      WHERE question_id = ? AND status IN ('pending', 'expired')
    `).run(answerText, answeredAt, questionId);
    return this.require(questionId);
  }

  markAnswerDelivered(questionId: string, deliveredAt: string): void {
    this.connection().prepare(
      "UPDATE questions SET answer_delivered_at = ? WHERE question_id = ? AND answer_delivered_at IS NULL",
    ).run(deliveredAt, questionId);
  }

  // Only a pending question can expire; the status guard stops a late sweep from clobbering an answer that just landed.
  expire(questionId: string, expiredAt: string, expireReason: PeerQuestionExpireReason): boolean {
    const updateOutcome = this.connection().prepare(`
      UPDATE questions SET status = 'expired', expired_at = ?, expire_reason = ?
      WHERE question_id = ? AND status = 'pending'
    `).run(expiredAt, expireReason, questionId);
    return Number(updateOutcome.changes) > 0;
  }

  recordReminder(questionId: string, remindedAt: string): void {
    this.connection().prepare(
      "UPDATE questions SET reminder_count = reminder_count + 1, last_reminded_at = ? WHERE question_id = ?",
    ).run(remindedAt, questionId);
  }
}
