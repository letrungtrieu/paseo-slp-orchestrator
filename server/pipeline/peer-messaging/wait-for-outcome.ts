// The blocking half of slp_ask and slp_await_answer: look at the ledger, and if nothing is ready sleep
// until woken or until the wait window closes. Looking first means a result that already exists is never slept on.
import type { PeerQuestion } from "../../../shared/peer-questions";
import { answerText, expiredText, incomingQuestionsSection, stillPendingText } from "../../prompts/question-messages";
import type { BusCaller } from "../../bus/http-mcp";
import type { PipelineContext } from "../context";
import { dropQueuedQuestionMail } from "./question-delivery";

const SECTION_SEPARATOR = "\n\n---\n\n";

// Reads everything the caller has waiting: answers to any of its questions, questions addressed to it,
// and the expiry of the question it is awaiting. Returns null when there is nothing to report yet.
function readReadyOutcome(ctx: PipelineContext, caller: BusCaller, awaitedQuestion: PeerQuestion): string | null {
  const run = ctx.store.require(caller.runId);
  const ledger = ctx.store.questions;
  const nowIso = new Date().toISOString();
  const reportSections: string[] = [];

  // Answers to every question the caller asked, not only the awaited one: a wake may carry any of them.
  const unreadAnswers = ledger.listUnconsumedAnswers(run.id, caller.agentId);
  for (const answeredQuestion of unreadAnswers) {
    ledger.markAnswerDelivered(answeredQuestion.questionId, nowIso);
    reportSections.push(answerText(run, answeredQuestion));
  }
  dropQueuedQuestionMail(ctx, run.id, caller.agentId, unreadAnswers.map((answeredQuestion) => answeredQuestion.questionId));

  const refreshedAwaitedQuestion = ledger.require(awaitedQuestion.questionId);
  if (refreshedAwaitedQuestion.status === "expired") reportSections.push(expiredText(refreshedAwaitedQuestion));

  // Questions for the caller are handed over here so a blocked agent can answer instead of both sides deadlocking.
  const incomingQuestions = ledger.listUndeliveredForRecipient(run.id, caller.agentId);
  if (incomingQuestions.length > 0) {
    ledger.markDeliveredTo(caller.agentId, incomingQuestions.map((incomingQuestion) => incomingQuestion.questionId), nowIso);
    dropQueuedQuestionMail(ctx, run.id, caller.agentId, incomingQuestions.map((incomingQuestion) => incomingQuestion.questionId));
    reportSections.push(incomingQuestionsSection(run, incomingQuestions));
    // The caller must know its own question is still open, or it would treat the interruption as the end of the exchange.
    if (refreshedAwaitedQuestion.status === "pending") reportSections.push(stillPendingText(refreshedAwaitedQuestion));
  }
  return reportSections.length > 0 ? reportSections.join(SECTION_SEPARATOR) : null;
}

export async function waitForQuestionOutcome(
  ctx: PipelineContext,
  caller: BusCaller,
  awaitedQuestion: PeerQuestion,
  abortSignal?: AbortSignal,
): Promise<string> {
  const windowDeadlineMs = Date.now() + ctx.questionTiming.waitWindowMs;
  for (;;) {
    const readyOutcome = readReadyOutcome(ctx, caller, awaitedQuestion);
    if (readyOutcome) return readyOutcome;
    const remainingWindowMs = windowDeadlineMs - Date.now();
    if (remainingWindowMs <= 0) break;
    // Inspect-then-wait runs without an await in between, so a wake-up cannot slip through the gap.
    const waitEnd = await ctx.questionWaits.wait(caller.agentId, awaitedQuestion.questionId, remainingWindowMs, abortSignal);
    if (waitEnd !== "wake") break;
  }
  // Window closed without a result: the question stays open in the ledger and the agent resumes with slp_await_answer.
  return stillPendingText(ctx.store.questions.require(awaitedQuestion.questionId));
}
