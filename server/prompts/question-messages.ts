// Text agents read when they send, receive or wait for a question. Kept in one place because the same
// wording reaches an agent through two routes: a mailbox prompt, or the result of its own blocking tool call.
import type { PeerQuestion, PeerRouteScope } from "../../shared/peer-questions";
import type { Run } from "../../shared/state";

const SCOPE_LABELS: Readonly<Record<PeerRouteScope, string>> = {
  cross_lead: "Cross-Lead",
  merge: "Merge/conflict",
  stage: "Stage",
};

// Merge conflicts need the author's intent; the other scopes mostly need the exact contract.
const SCOPE_ANSWER_GUIDANCE: Readonly<Record<PeerRouteScope, string>> = {
  cross_lead: "Give concrete API contracts, schemas or routes so your parallel features integrate seamlessly.",
  merge: "Explain why your code was written this way and how the conflict should be resolved.",
  stage: "Answer from what you have actually built or verified; say so if you are unsure.",
};

const METRICS_GUIDANCE = "Back the answer with concrete metrics: the exact logic, the expected inputs, and the expected outputs or observable outcome.";

// Roles are persisted per agent, so the text can name the other side without being handed a route.
export function describeAgent(run: Run, agentId: string): string {
  const agentRecord = run.agents[agentId];
  if (!agentRecord) return `agent ${agentId}`;
  const roleLabel = agentRecord.projectRole ?? agentRecord.role;
  const featureLabel = agentRecord.featureName ? `, feature '${agentRecord.featureName}'` : "";
  return `${roleLabel} (${agentId}${featureLabel})`;
}

export function notificationText(scopeLabel: string, senderDescription: string, message: string): string {
  return `${scopeLabel} notification from ${senderDescription}:\n${message}\nThis is information only; no reply is expected. Keep your current assignment in view.`;
}

// The recipient is told the asker is blocked, because that is what makes answering promptly worth interrupting its own work.
export function questionPromptText(run: Run, askedQuestion: PeerQuestion): string {
  return [
    `${SCOPE_LABELS[askedQuestion.scope]} question ${askedQuestion.questionId} from ${describeAgent(run, askedQuestion.fromAgentId)}:`,
    askedQuestion.question,
    `They are blocked until you answer. Reply with slp_answer({ questionId: "${askedQuestion.questionId}", answer: "..." }). ${SCOPE_ANSWER_GUIDANCE[askedQuestion.scope]} ${METRICS_GUIDANCE}`,
    "Answering does not replace your own workflow tool; continue your assignment afterwards.",
  ].join("\n");
}

export function incomingQuestionsSection(run: Run, incomingQuestions: PeerQuestion[]): string {
  const questionBlocks = incomingQuestions.map((incomingQuestion) => questionPromptText(run, incomingQuestion));
  return `While you were waiting, ${incomingQuestions.length} question(s) arrived for you:\n\n${questionBlocks.join("\n\n")}`;
}

export function answerText(run: Run, answeredQuestion: PeerQuestion): string {
  const lateNote = answeredQuestion.status === "answered_late"
    ? "This answer arrived after your question expired; adjust any assumption you made in the meantime.\n"
    : "";
  return `${lateNote}Answer from ${describeAgent(run, answeredQuestion.toAgentId)} to your question ${answeredQuestion.questionId}:\n${answeredQuestion.answer ?? ""}`;
}

export function stillPendingText(askedQuestion: PeerQuestion): string {
  return [
    `Question ${askedQuestion.questionId} has no answer yet; ${askedQuestion.toAgentId} may be busy.`,
    `Call slp_await_answer({ questionId: "${askedQuestion.questionId}" }) to keep waiting. Do other independent work first if you have any.`,
  ].join("\n");
}

export function expiredText(expiredQuestion: PeerQuestion): string {
  const reasonText = expiredQuestion.expireReason === "recipient_unavailable"
    ? "the recipient is no longer available"
    : "no answer arrived in time";
  return [
    `Question ${expiredQuestion.questionId} expired: ${reasonText}.`,
    "Make the most reasonable assumption, state that assumption explicitly in your next report or message, and continue. Use slp_escalate only if you are truly blocked.",
    "If the recipient answers later, the answer is forwarded to you.",
  ].join("\n");
}

export function questionReminderText(run: Run, pendingQuestion: PeerQuestion): string {
  return `Reminder: ${describeAgent(run, pendingQuestion.fromAgentId)} is still blocked on question ${pendingQuestion.questionId}. Answer it with slp_answer.\n${pendingQuestion.question}`;
}
