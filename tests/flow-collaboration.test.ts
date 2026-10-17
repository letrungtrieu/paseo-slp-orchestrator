import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, approveCurrentStage, currentStage, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("direct stage collaboration", () => {
  it("routes a direct peer message through the stage mailbox and records its history", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const developerId = flow.agentId(runId, "developer", stage.id);

    const message = await flow.callAs(reviewerId, "slp_send_peer_message", {
      toAgentId: developerId,
      message: "Please challenge the retry assumption.",
      waitForReply: false,
    });
    expect(message.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.stages[0].messages.at(-1)).toMatchObject({
      fromAgentId: reviewerId,
      toAgentId: developerId,
      message: "Please challenge the retry assumption.",
    });
    expect(flow.mailTo(runId, developerId).at(-1)?.text).toContain("retry assumption");
  });

  it("rejects direct messages to a peer outside the current stage", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", firstStage.id);

    const invalidRecipient = await flow.callAs(reviewerId, "slp_send_peer_message", {
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
    const staleIntraStageMessage = await flow.callAs(firstStageReviewerId, "slp_send_peer_message", {
      toAgentId: firstStageDeveloperId,
      message: "The previous cohort must not change the next stage.",
    });
    expect(staleIntraStageMessage).toMatchObject({ isError: true });

    // A Stage 2 peer can ask a Stage 1 peer a question with waitForReply: true and receive a direct reply.
    const secondStage = currentStage(flow, runId, pipelineId);
    const secondStageDeveloperId = flow.agentId(runId, "developer", secondStage.id);
    const crossStageQuestion = await flow.callAs(secondStageDeveloperId, "slp_send_peer_message", {
      toAgentId: firstStageReviewerId,
      message: "What input boundary did you expect for negative invoice amounts?",
      waitForReply: true,
    });
    expect(crossStageQuestion.isError).toBe(false);
    expect(flow.run(runId).agents[secondStageDeveloperId].waitingForAgentId).toBe(firstStageReviewerId);
    expect(flow.mailTo(runId, firstStageReviewerId).at(-1)?.text).toContain("Cross-stage question");

    const crossStageReply = await flow.callAs(firstStageReviewerId, "slp_send_peer_message", {
      toAgentId: secondStageDeveloperId,
      message: "Logic rejects amount <= 0: input amount <= 0 -> output { ok: false, code: 'NON_POSITIVE' }.",
      waitForReply: false,
    });
    expect(crossStageReply.isError).toBe(false);
    expect(flow.run(runId).agents[secondStageDeveloperId].waitingForAgentId).toBeNull();
    expect(flow.mailTo(runId, secondStageDeveloperId).at(-1)?.awaitTool).toBe("slp_stage_report");
  });
});

