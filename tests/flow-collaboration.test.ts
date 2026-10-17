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

  it("removes an archived stage cohort before the next cohort can communicate", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", firstStage.id);
    const developerId = flow.agentId(runId, "developer", firstStage.id);
    await approveCurrentStage(flow, runId, pipelineId, "Initial review accepted.");

    expect(flow.gateway.archivedAgentIds).toContain(reviewerId);
    expect(flow.gateway.archivedAgentIds).toContain(developerId);
    const staleMessage = await flow.callAs(reviewerId, "slp_send_peer_message", {
      toAgentId: developerId,
      message: "The previous cohort must not change the next stage.",
    });
    expect(staleMessage).toMatchObject({ isError: true });
  });
});
