import { describe, expect, it } from "vitest";
import type { PipelineDefinition } from "../shared/pipeline";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, approveCurrentStage, commitPipelineWork, completePipeline, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("pipeline completion and integration", () => {
  it("creates a fresh peer cohort per stage and archives the previous cohort after approval", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const firstCohort = [...firstStage.peerAgentIds, firstStage.forkedLeadAgentId!];
    for (const assignment of firstStage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    const secondStage = currentStage(flow, runId, pipelineId);
    expect(secondStage.id).not.toBe(firstStage.id);
    expect(secondStage.peerAgentIds.some((agentId) => firstCohort.includes(agentId))).toBe(false);
    for (const agentId of firstCohort) expect(flow.gateway.archivedAgentIds).toContain(agentId);
    expect(secondStage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId].projectRole)).toEqual(["developer"]);
  });

  it("accepts and integrates a completed Lead-authored pipeline", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const definition: PipelineDefinition = { ...DEFAULT_PIPELINE, name: "integrated-pipeline" };
    const { runId, pipelineId } = await startedRunWithPipeline(flow, definition);
    commitPipelineWork(flow, runId, pipelineId);
    await completePipeline(flow, runId, pipelineId);

    const finalization = await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", {
      pipelineId,
      summary: "All declared stages were approved and integrated.",
    });
    expect(finalization.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)).toMatchObject({ status: "integrated", finalReport: "All declared stages were approved and integrated." });
    expect(flow.run(runId).agents[flow.run(runId).masterLeadAgentId].awaitingTool).toBe("slp_report");
    expect(flow.mailTo(runId, flow.run(runId).masterLeadAgentId)).toEqual([]);
  });

  it("rejects integration until every declared stage is approved", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const response = await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", {
      pipelineId,
      summary: "Too early",
    });

    expect(response).toMatchObject({ isError: true });
    expect(response.text).toContain("stage must be completed");
    expect(flow.pipeline(runId, pipelineId)!.status).not.toBe("integrated");
  });
});
