import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, approveCurrentStage, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("stage coordination", () => {
  it("keeps the Forked Lead idle at stage start and delivers the full stage goal and roster once peers report", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    // Forked Lead stays idle without an empty startup turn while peers work.
    expect(flow.mailTo(runId, coordinatorId)).toEqual([]);
    expect(stage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId].role)).toEqual(["peer", "peer"]);

    await reportPeer(flow, runId, pipelineId, "reviewer", "Boundary review finished.");
    await reportPeer(flow, runId, pipelineId, "developer", "Implementation plan ready.");

    const reviewBriefing = flow.mailTo(runId, coordinatorId).at(-1)?.text ?? "";
    expect(reviewBriefing).toContain(stage.goal);
    expect(reviewBriefing).toContain("reviewer");
    expect(reviewBriefing).toContain("developer");
    expect(reviewBriefing).toContain("slp_approve_stage");
  });

  it("lets peers send direct messages and releases a waiting peer when the recipient submits slp_stage_report", async () => {
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
    expect(flow.run(runId).agents[reviewerId].waitingForAgentId).toBe(developerId);

    // When developer submits its stage report instead of sending a direct reply, reviewer's wait is released immediately.
    await reportPeer(flow, runId, pipelineId, "developer", "Idempotency check added and verified.");
    expect(flow.run(runId).agents[reviewerId].waitingForAgentId).toBeNull();
    expect(flow.mailTo(runId, reviewerId).at(-1)?.awaitTool).toBe("slp_stage_report");

    await reportPeer(flow, runId, pipelineId, "reviewer", "Boundary and retry behavior reviewed.");
    expect(currentStage(flow, runId, pipelineId).reports).toHaveLength(2);
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
