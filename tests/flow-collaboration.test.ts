import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, approveCurrentStage, askAndAnswer, currentStage, eventually, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("Lead-centred stage collaboration", () => {
  it("routes a peer's one-way notification to its Lead through the stage mailbox and records its history", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const leadId = flow.agentId(runId, "forked_lead", stage.id);

    const message = await flow.callAs(reviewerId, "slp_notify", {
      toAgentId: leadId,
      message: "The retry assumption needs a decision.",
    });
    expect(message.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.stages[0].messages.at(-1)).toMatchObject({
      fromAgentId: reviewerId,
      toAgentId: leadId,
      message: "The retry assumption needs a decision.",
    });
    const notificationMail = flow.mailTo(runId, leadId).at(-1);
    expect(notificationMail?.text).toContain("retry assumption");
    // A notification never creates an obligation or a ledger row: nothing waits on it.
    expect(notificationMail).toMatchObject({ awaitTool: null, questionId: null });
    expect(flow.store.questions.listForRun(runId, 10)).toEqual([]);
  });

  it("rejects peer messages to anyone but the Lead", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", firstStage.id);
    const architectId = flow.agentId(runId, "architect", firstStage.id);

    for (const forbiddenRecipientId of ["missing-agent", architectId]) {
      const invalidRecipient = await flow.callAs(reviewerId, "slp_notify", {
        toAgentId: forbiddenRecipientId,
        message: "Let us add a cache while we are here.",
      });
      expect(invalidRecipient).toMatchObject({ isError: true });
      expect(invalidRecipient.text).toContain("only contact their Lead");
    }
  });

  it("lets the Lead question the developer while the developer can only ask the Lead", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const firstStageReviewerId = flow.agentId(runId, "reviewer", firstStage.id);
    await approveCurrentStage(flow, runId, pipelineId, "Approach agreed.");

    // Advisors are retired once the brief is locked, so they cannot steer the build any more.
    await eventually(() => expect(flow.gateway.archivedAgentIds).toContain(firstStageReviewerId));
    const secondStage = currentStage(flow, runId, pipelineId);
    const developerId = flow.agentId(runId, "developer", secondStage.id);
    const leadId = flow.agentId(runId, "forked_lead", secondStage.id);
    const toRetiredAdvisor = await flow.callAs(developerId, "slp_ask", { toAgentId: firstStageReviewerId, question: "Why streaming?" });
    expect(toRetiredAdvisor.isError).toBe(true);

    // The Lead asks its developer a blocking question; the answer comes back as the result of the same call.
    const { askOutcome, questionId } = await askAndAnswer(
      flow,
      leadId,
      developerId,
      "What happens to a negative invoice amount?",
      "Rejected: input amount <= 0 -> { ok: false, code: 'NON_POSITIVE' }.",
    );
    expect(askOutcome.isError).toBe(false);
    expect(askOutcome.text).toContain("NON_POSITIVE");
    // The asker consumed the answer inside its call, so no duplicate answer mail is queued for it.
    expect(flow.mailTo(runId, leadId).some((queuedMail) => queuedMail.questionId === questionId)).toBe(false);
    expect(flow.store.questions.require(questionId)).toMatchObject({
      status: "answered", scope: "stage", fromAgentId: leadId, toAgentId: developerId,
    });
    expect(flow.store.questions.require(questionId).answerDeliveredAt).not.toBeNull();
  });
});
