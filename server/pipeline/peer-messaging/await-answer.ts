// slp_await_answer: resumes waiting for a question whose first wait window ran out (or whose connection was cut by a reload).
import type { BusCaller } from "../../bus/http-mcp";
import type { PipelineContext } from "../context";
import { ToolError } from "../tool-error";
import { waitForQuestionOutcome } from "./wait-for-outcome";

export async function awaitAnswer(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { questionId: string },
  abortSignal?: AbortSignal,
): Promise<string> {
  const awaitedQuestion = ctx.store.questions.find(input.questionId);
  // Another run's or another agent's question must look unknown, or the id would leak its text through the wait outcome.
  if (!awaitedQuestion || awaitedQuestion.runId !== caller.runId || awaitedQuestion.fromAgentId !== caller.agentId) {
    throw new ToolError(`Unknown question '${input.questionId}'. Only questions you asked can be awaited.`);
  }
  return waitForQuestionOutcome(ctx, caller, awaitedQuestion, abortSignal);
}
