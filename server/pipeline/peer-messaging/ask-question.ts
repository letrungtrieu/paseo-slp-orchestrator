// slp_ask: a blocking question. The call returns the answer itself, so the asker's context gains exactly one
// question/answer pair instead of a separate turn that has to be correlated with mail.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../../bus/http-mcp";
import type { PipelineContext } from "../context";
import { ToolError } from "../tool-error";
import { deliverQuestion } from "./question-delivery";
import { recordRouteHistory, resolvePeerRoute } from "./peer-route";
import { waitForQuestionOutcome } from "./wait-for-outcome";

export async function askQuestion(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { toAgentId: string; question: string },
  abortSignal?: AbortSignal,
): Promise<string> {
  const run = ctx.store.require(caller.runId);
  const askerRecord = run.agents[caller.agentId];
  if (!askerRecord || askerRecord.archivedAt) throw new ToolError("This tool requires an active agent session.");
  // The same gate as notifications decides who may be asked, so questions cannot reach across pipelines notifications could not.
  const route = resolvePeerRoute(run, askerRecord, input.toAgentId);
  const openQuestionCount = ctx.store.questions.countPendingFromAsker(run.id, caller.agentId);
  if (openQuestionCount >= ctx.questionTiming.maxOpenQuestionsPerAsker) {
    throw new ToolError(`You already have ${openQuestionCount} unanswered questions. Collect them with slp_await_answer before asking more.`);
  }
  const createdAt = new Date().toISOString();
  const askedQuestion = ctx.store.questions.insert({
    questionId: randomUUID(),
    runId: run.id,
    fromAgentId: caller.agentId,
    toAgentId: input.toAgentId,
    scope: route.scope,
    pipelineId: route.pipelineId,
    question: input.question,
    createdAt,
  });
  // The stage history keeps the human-readable conversation next to the peer reports.
  ctx.store.mutate(run.id, () => {
    recordRouteHistory(route, { id: randomUUID(), fromAgentId: caller.agentId, toAgentId: input.toAgentId, message: input.question, createdAt });
  });
  ctx.logEvent(run.id, {
    taskId: null, from: caller.agentId, to: input.toAgentId, kind: "question.asked",
    summary: input.question.slice(0, 240), outcome: "queued",
  });
  deliverQuestion(ctx, askedQuestion);
  return waitForQuestionOutcome(ctx, caller, askedQuestion, abortSignal);
}
