import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, approveCurrentStage, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("stage coordination", () => {
  it("keeps the stage goal and equal peer assignments visible to the Forked Lead", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);
    const briefing = flow.mailTo(runId, coordinatorId).at(-1)?.text ?? "";

    expect(briefing).toContain(stage.goal);
    expect(briefing).toContain("reviewer");
    expect(briefing).toContain("developer");
    expect(briefing).toContain("slp_approve_stage");
    expect(stage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId].role)).toEqual(["peer", "peer"]);
  });

  it("lets peers send direct messages and report evidence before the coordinator approves", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const developerId = flow.agentId(runId, "developer", stage.id);

    const message = await flow.callAs(reviewerId, "slp_send_peer_message", {
      toAgentId: developerId,
      message: "The import boundary needs an idempotency check.",
      waitForReply: true,
    });
    expect(message.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.stages[0].messages.at(-1)?.message).toContain("idempotency");
    expect(flow.mailTo(runId, developerId).at(-1)?.text).toContain("idempotency");

    await reportPeer(flow, runId, pipelineId, "reviewer", "Boundary and retry behavior reviewed.");
    expect(currentStage(flow, runId, pipelineId).reports).toHaveLength(1);
    expect(currentStage(flow, runId, pipelineId).status).toBe("running");
  });

  it("allows only the Forked Lead to request rework and close the stage", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    const peerApproval = await flow.callAs(reviewerId, "slp_approve_stage", { summary: "I approve the stage." });
    expect(peerApproval.isError).toBe(true);
    expect(peerApproval.text).toContain("not available");

    const rework = await flow.callAs(coordinatorId, "slp_stage_rework", {
      agentIds: [reviewerId],
      feedback: "Re-check the retry behavior against the shared stage goal.",
    });
    expect(rework.isError).toBe(false);
    expect(flow.mailTo(runId, reviewerId).at(-1)?.text).toContain("Re-check the retry behavior");

    await reportPeer(flow, runId, pipelineId, "reviewer", "Retry behavior is now covered.");
    await approveCurrentStage(flow, runId, pipelineId);
    expect(flow.pipeline(runId, pipelineId)!.stages[0].status).toBe("completed");
    expect(flow.gateway.archivedAgentIds).toContain(reviewerId);
    expect(flow.gateway.archivedAgentIds).toContain(coordinatorId);
  });
});
