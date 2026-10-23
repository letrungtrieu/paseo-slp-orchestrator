import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, approveCurrentStage, askAndAnswer, currentStage, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("direct stage collaboration", () => {
  it("routes a one-way notification through the stage mailbox and records its history", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const developerId = flow.agentId(runId, "developer", stage.id);

    const message = await flow.callAs(reviewerId, "slp_notify", {
      toAgentId: developerId,
      message: "Please challenge the retry assumption.",
    });
    expect(message.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.stages[0].messages.at(-1)).toMatchObject({
      fromAgentId: reviewerId,
      toAgentId: developerId,
      message: "Please challenge the retry assumption.",
    });
    const notificationMail = flow.mailTo(runId, developerId).at(-1);
    expect(notificationMail?.text).toContain("retry assumption");
    // A notification never creates an obligation or a ledger row: nothing waits on it.
    expect(notificationMail).toMatchObject({ awaitTool: null, questionId: null });
    expect(flow.store.questions.listForRun(runId, 10)).toEqual([]);
  });

  it("rejects direct messages to a peer outside the current stage", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", firstStage.id);

    const invalidRecipient = await flow.callAs(reviewerId, "slp_notify", {
      toAgentId: "missing-agent",
      message: "This recipient is not in my stage.",
    });
    expect(invalidRecipient).toMatchObject({ isError: true });
    expect(invalidRecipient.text).toContain("current stage");
  });

  it("keeps prior-stage peers alive for cross-stage consultation while blocking closed-stage peers from messaging each other", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const firstStageReviewerId = flow.agentId(runId, "reviewer", firstStage.id);
    const firstStageDeveloperId = flow.agentId(runId, "developer", firstStage.id);
    await approveCurrentStage(flow, runId, pipelineId, "Initial review accepted.");

    // Stage 1 peers remain alive while Stage 2 runs so Stage 2 peers can consult them.
    expect(flow.gateway.archivedAgentIds).not.toContain(firstStageReviewerId);
    expect(flow.gateway.archivedAgentIds).not.toContain(firstStageDeveloperId);

    // Closed-stage peers cannot chat amongst themselves behind the active stage's back.
    const staleIntraStageMessage = await flow.callAs(firstStageReviewerId, "slp_notify", {
      toAgentId: firstStageDeveloperId,
      message: "The previous cohort must not change the next stage.",
    });
    expect(staleIntraStageMessage).toMatchObject({ isError: true });

    // A Stage 2 peer asks a Stage 1 peer a blocking question; the answer comes back as the result of the same call.
    const secondStage = currentStage(flow, runId, pipelineId);
    const secondStageDeveloperId = flow.agentId(runId, "developer", secondStage.id);
    const { askOutcome, questionId } = await askAndAnswer(
      flow,
      secondStageDeveloperId,
      firstStageReviewerId,
      "What input boundary did you expect for negative invoice amounts?",
      "Logic rejects amount <= 0: input amount <= 0 -> output { ok: false, code: 'NON_POSITIVE' }.",
    );
    expect(askOutcome.isError).toBe(false);
    expect(askOutcome.text).toContain("NON_POSITIVE");
    // The asker consumed the answer inside its call, so no duplicate answer mail is queued for it.
    expect(flow.mailTo(runId, secondStageDeveloperId).some((queuedMail) => queuedMail.questionId === questionId)).toBe(false);
    expect(flow.store.questions.require(questionId)).toMatchObject({
      status: "answered", scope: "stage", fromAgentId: secondStageDeveloperId, toAgentId: firstStageReviewerId,
    });
    expect(flow.store.questions.require(questionId).answerDeliveredAt).not.toBeNull();
  });
});

