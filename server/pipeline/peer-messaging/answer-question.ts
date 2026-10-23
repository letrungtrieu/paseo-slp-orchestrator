// slp_answer: the recipient's reply. It unblocks the asker at once when the asker is still waiting, and is
// stored either way so a late answer to an expired question remains visible in the audit.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../../bus/http-mcp";
import type { PipelineContext } from "../context";
import { ToolError } from "../tool-error";
import { deliverAnswer } from "./question-delivery";
import { recordRouteHistory, resolvePeerRoute } from "./peer-route";

export function answerQuestion(ctx: PipelineContext, caller: BusCaller, input: { questionId: string; answer: string }): string {
  const run = ctx.store.require(caller.runId);
  const askedQuestion = ctx.store.questions.find(input.questionId);
  if (!askedQuestion || askedQuestion.runId !== run.id) throw new ToolError(`Unknown question '${input.questionId}'.`);
  if (askedQuestion.toAgentId !== caller.agentId) throw new ToolError("This question was addressed to another agent.");
  if (askedQuestion.status === "answered" || askedQuestion.status === "answered_late") {
    throw new ToolError("This question was already answered.");
  }
  const answeredAt = new Date().toISOString();
  const answeredQuestion = ctx.store.questions.recordAnswer(askedQuestion.questionId, input.answer, answeredAt);
  // History is best effort: the stage window that admitted the question may have closed by the time a late answer arrives.
  const answererRecord = run.agents[caller.agentId];
  try {
    const replyRoute = resolvePeerRoute(run, answererRecord, askedQuestion.fromAgentId);
    ctx.store.mutate(run.id, () => {
      recordRouteHistory(replyRoute, { id: randomUUID(), fromAgentId: caller.agentId, toAgentId: askedQuestion.fromAgentId, message: input.answer, createdAt: answeredAt });
    });
  } catch (routeError) {
    if (!(routeError instanceof ToolError)) throw routeError;
  }
  ctx.logEvent(run.id, {
    taskId: null, from: caller.agentId, to: askedQuestion.fromAgentId,
    kind: answeredQuestion.status === "answered_late" ? "question.answered_late" : "question.answered",
    summary: input.answer.slice(0, 240), outcome: "delivered",
  });
  deliverAnswer(ctx, answeredQuestion);
  return answeredQuestion.status === "answered_late"
    ? "Answer stored. The question had already expired, so the answer is forwarded to the asker as a late reply."
    : "Answer delivered. Continue your assignment.";
}
