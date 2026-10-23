// Moves a question to its recipient and an answer back to its asker. A blocked agent is woken in-process;
// everyone else gets ordinary mailbox mail. The sweeper reuses these helpers to reconcile anything missed.
import type { PeerQuestion } from "../../../shared/peer-questions";
import type { Run } from "../../../shared/state";
import { answerText, questionPromptText } from "../../prompts/question-messages";
import type { PipelineContext } from "../context";

export function hasQueuedMail(run: Run, recipientAgentId: string, questionId: string): boolean {
  return run.mailbox.some((queuedMessage) => queuedMessage.toAgentId === recipientAgentId && queuedMessage.questionId === questionId);
}

// Once an agent has read a question or answer through its blocking call, the queued copy would be a duplicate prompt.
export function dropQueuedQuestionMail(ctx: PipelineContext, runId: string, recipientAgentId: string, questionIds: string[]): void {
  if (questionIds.length === 0) return;
  const run = ctx.store.require(runId);
  const hasDuplicate = run.mailbox.some(
    (queuedMessage) => queuedMessage.toAgentId === recipientAgentId && queuedMessage.questionId && questionIds.includes(queuedMessage.questionId),
  );
  if (!hasDuplicate) return;
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === recipientAgentId && queuedMessage.questionId && questionIds.includes(queuedMessage.questionId)),
    );
  });
}

export function queueQuestionMail(ctx: PipelineContext, question: PeerQuestion): void {
  const run = ctx.store.require(question.runId);
  ctx.mailbox.enqueue(run.id, question.toAgentId, questionPromptText(run, question), {
    taskId: null,
    // No owed tool: answering is not a stage obligation, and overwriting the recipient's own obligation would hide its real duty.
    awaitTool: null,
    from: question.fromAgentId,
    summary: `question ${question.questionId}: ${question.question.slice(0, 120)}`,
    questionId: question.questionId,
  });
}

export function queueAnswerMail(ctx: PipelineContext, question: PeerQuestion): void {
  const run = ctx.store.require(question.runId);
  ctx.mailbox.enqueue(run.id, question.fromAgentId, answerText(run, question), {
    taskId: null,
    awaitTool: null,
    from: question.toAgentId,
    summary: `answer ${question.questionId}: ${(question.answer ?? "").slice(0, 120)}`,
    questionId: question.questionId,
  });
}

// A recipient inside its own blocking call reads the question there; otherwise it arrives as a prompt when it is idle.
export function deliverQuestion(ctx: PipelineContext, question: PeerQuestion): void {
  if (ctx.questionWaits.isWaiting(question.toAgentId)) ctx.questionWaits.wakeAgent(question.toAgentId);
  else queueQuestionMail(ctx, question);
}

export function deliverAnswer(ctx: PipelineContext, question: PeerQuestion): void {
  if (ctx.questionWaits.isWaiting(question.fromAgentId)) ctx.questionWaits.wakeAgent(question.fromAgentId);
  else queueAnswerMail(ctx, question);
}
