import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, approveCurrentStage, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("peer evidence and stage decisions", () => {
  it("stores independent reports from every equal peer and wakes the coordinator once all peers have reported", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    await reportPeer(flow, runId, pipelineId, "reviewer", "Review found a retry boundary.");
    // Coordinator is not woken prematurely while the architect still owes slp_stage_report.
    expect(flow.mailTo(runId, coordinatorId).filter((message) => message.awaitTool === "slp_approve_stage")).toHaveLength(0);

    await reportPeer(flow, runId, pipelineId, "architect", "The proposed change preserves the boundary.");

    expect(currentStage(flow, runId, pipelineId).reports.map((report) => report.role)).toEqual(["reviewer", "architect"]);
    const approvalMessages = flow.mailTo(runId, coordinatorId).filter((message) => message.awaitTool === "slp_approve_stage");
    expect(approvalMessages).toHaveLength(1);
    expect(approvalMessages[0].text).toContain("Review found a retry boundary.");
    expect(approvalMessages[0].text).toContain("The proposed change preserves the boundary.");
    expect(currentStage(flow, runId, pipelineId).status).toBe("running");
  });

  it("keeps a blocked peer result in stage history and lets its coordinator escalate", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    const blocked = await flow.callAs(reviewerId, "slp_stage_report", {
      summary: "The current code cannot satisfy the goal.",
      findings: ["The existing import boundary is missing."],
      status: "blocked",
    });
    expect(blocked.isError).toBe(false);
    expect(currentStage(flow, runId, pipelineId).reports[0].status).toBe("blocked");

    const escalation = await flow.callAs(coordinatorId, "slp_escalate", { reason: "The stage goal requires a contract decision." });
    expect(escalation.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("paused");
    expect(flow.mailTo(runId, flow.run(runId).masterLeadAgentId).at(-1)?.text).toContain("contract decision");
  });

  it("does not let a peer approve a stage without the Forked Lead's decision", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const peerId = flow.agentId(runId, "architect", stage.id);

    const approval = await flow.callAs(peerId, "slp_approve_stage", { summary: "done" });
    expect(approval).toMatchObject({ isError: true });
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("running");
  });
});
