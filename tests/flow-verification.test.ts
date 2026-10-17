import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, approveCurrentStage, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("peer evidence and stage decisions", () => {
  it("stores independent reports from every equal peer and delivers them to the coordinator", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);

    await reportPeer(flow, runId, pipelineId, "reviewer", "Review found a retry boundary.");
    await reportPeer(flow, runId, pipelineId, "developer", "The proposed change preserves the boundary.");

    expect(currentStage(flow, runId, pipelineId).reports.map((report) => report.role)).toEqual(["reviewer", "developer"]);
    expect(flow.mailTo(runId, coordinatorId).filter((message) => message.awaitTool === "slp_approve_stage")).toHaveLength(2);
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
    const peerId = flow.agentId(runId, "developer", stage.id);

    const approval = await flow.callAs(peerId, "slp_approve_stage", { summary: "done" });
    expect(approval).toMatchObject({ isError: true });
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("running");
  });
});
