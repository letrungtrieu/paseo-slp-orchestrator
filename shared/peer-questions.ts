// Blocking agent-to-agent questions. They live in their own SQLite table (not in the Run payload)
// so every question and answer stays queryable for auditing how well agents communicate.
import { z } from "zod";

// answered_late = the answer arrived after the question had already expired; it is kept for the audit trail.
export const PeerQuestionStatusSchema = z.enum(["pending", "answered", "answered_late", "expired"]);
export type PeerQuestionStatus = z.infer<typeof PeerQuestionStatusSchema>;

// Which routing rule admitted the question, so the audit can compare cross-Lead, merge and in-stage traffic.
export const PeerRouteScopeSchema = z.enum(["cross_lead", "merge", "stage"]);
export type PeerRouteScope = z.infer<typeof PeerRouteScopeSchema>;

export const PeerQuestionExpireReasonSchema = z.enum(["timeout", "recipient_unavailable", "asker_unavailable"]);
export type PeerQuestionExpireReason = z.infer<typeof PeerQuestionExpireReasonSchema>;

export const PeerQuestionSchema = z.object({
  questionId: z.string(),
  runId: z.string(),
  fromAgentId: z.string(),
  toAgentId: z.string(),
  scope: PeerRouteScopeSchema,
  pipelineId: z.string().nullable(),
  status: PeerQuestionStatusSchema,
  question: z.string(),
  answer: z.string().nullable(),
  createdAt: z.string(),
  // The question reached the recipient (by prompt or inside the recipient's own blocking wait).
  deliveredAt: z.string().nullable(),
  answeredAt: z.string().nullable(),
  // The answer reached the asker; null means it was never consumed.
  answerDeliveredAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
  expireReason: PeerQuestionExpireReasonSchema.nullable(),
  reminderCount: z.number().int(),
  lastRemindedAt: z.string().nullable(),
});
export type PeerQuestion = z.infer<typeof PeerQuestionSchema>;

// A question row enriched with agent labels so the audit output is readable without joining run state by hand.
export const PeerQuestionViewSchema = PeerQuestionSchema.extend({
  fromLabel: z.string(),
  toLabel: z.string(),
  responseMs: z.number().nullable(),
});
export type PeerQuestionView = z.infer<typeof PeerQuestionViewSchema>;

export const PeerQuestionPairStatsSchema = z.object({
  fromLabel: z.string(),
  toLabel: z.string(),
  asked: z.number().int(),
  answered: z.number().int(),
  expired: z.number().int(),
  medianResponseMs: z.number().nullable(),
});

// Aggregate numbers that answer "is agent-to-agent communication paying off?".
export const PeerQuestionMetricsSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  answered: z.number().int(),
  answeredLate: z.number().int(),
  expired: z.number().int(),
  // answered / (answered + answeredLate + expired); null while nothing has been resolved yet.
  answerRate: z.number().nullable(),
  medianResponseMs: z.number().nullable(),
  p90ResponseMs: z.number().nullable(),
  medianDeliveryLagMs: z.number().nullable(),
  remindersSent: z.number().int(),
  byPair: z.array(PeerQuestionPairStatsSchema),
});
export type PeerQuestionMetrics = z.infer<typeof PeerQuestionMetricsSchema>;
