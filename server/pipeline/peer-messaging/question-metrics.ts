// Turns the raw question ledger into the numbers that show whether agent-to-agent communication helps:
// how often questions get answered, how long that takes, and which pairs of roles struggle.
import type { PeerQuestion, PeerQuestionMetrics, PeerQuestionView } from "../../../shared/peer-questions";
import type { Run } from "../../../shared/state";

// Role plus feature keeps two Leads of different features apart while still grouping all peers of one role.
function agentLabel(run: Run, agentId: string): string {
  const agentRecord = run.agents[agentId];
  if (!agentRecord) return agentId.slice(0, 8);
  const roleLabel = agentRecord.projectRole ?? agentRecord.role;
  return agentRecord.featureName ? `${roleLabel}/${agentRecord.featureName}` : roleLabel;
}

function durationMs(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const elapsedMs = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null;
}

// Nearest-rank percentile: simple, stable for the small samples a single run produces.
function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(fraction * sortedValues.length) - 1)];
}

function sortedNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null).sort((first, second) => first - second);
}

export function buildPeerQuestionViews(run: Run, questions: PeerQuestion[]): PeerQuestionView[] {
  return questions.map((question) => ({
    ...question,
    fromLabel: agentLabel(run, question.fromAgentId),
    toLabel: agentLabel(run, question.toAgentId),
    responseMs: durationMs(question.createdAt, question.answeredAt),
  }));
}

export function computePeerQuestionMetrics(questionViews: PeerQuestionView[]): PeerQuestionMetrics {
  const countWithStatus = (status: PeerQuestionView["status"]) => questionViews.filter((view) => view.status === status).length;
  const answered = countWithStatus("answered");
  const answeredLate = countWithStatus("answered_late");
  const expired = countWithStatus("expired");
  const resolvedCount = answered + answeredLate + expired;
  // Late answers count as answered: the exchange eventually worked, just too slowly.
  const responseTimes = sortedNumbers(questionViews.map((view) => view.responseMs));

  const pairBuckets = new Map<string, PeerQuestionView[]>();
  for (const questionView of questionViews) {
    const pairKey = `${questionView.fromLabel}\u0000${questionView.toLabel}`;
    pairBuckets.set(pairKey, [...(pairBuckets.get(pairKey) ?? []), questionView]);
  }
  const byPair = [...pairBuckets.values()].map((pairViews) => ({
    fromLabel: pairViews[0].fromLabel,
    toLabel: pairViews[0].toLabel,
    asked: pairViews.length,
    answered: pairViews.filter((view) => view.status === "answered" || view.status === "answered_late").length,
    expired: pairViews.filter((view) => view.status === "expired").length,
    medianResponseMs: percentile(sortedNumbers(pairViews.map((view) => view.responseMs)), 0.5),
  })).sort((first, second) => second.asked - first.asked);

  return {
    total: questionViews.length,
    pending: countWithStatus("pending"),
    answered,
    answeredLate,
    expired,
    answerRate: resolvedCount === 0 ? null : (answered + answeredLate) / resolvedCount,
    medianResponseMs: percentile(responseTimes, 0.5),
    p90ResponseMs: percentile(responseTimes, 0.9),
    medianDeliveryLagMs: percentile(sortedNumbers(questionViews.map((view) => durationMs(view.createdAt, view.deliveredAt))), 0.5),
    remindersSent: questionViews.reduce((reminderTotal, view) => reminderTotal + view.reminderCount, 0),
    byPair,
  };
}
