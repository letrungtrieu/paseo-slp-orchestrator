import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, delegateToLead, definePipeline, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("dynamic pipeline edge cases", () => {
  it("rejects malformed definitions before creating a worktree or agent cohort", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const response = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: {
      ...DEFAULT_PIPELINE,
      name: "invalid-pipeline",
      stages: [{ ...DEFAULT_PIPELINE.stages[0], peers: [] }],
    } });

    expect(response).toMatchObject({ isError: true });
    expect(response.text).toContain("at least one");
    expect(Object.keys(flow.run(runId).pipelines)).toHaveLength(0);
    expect(flow.gateway.createdAgents.filter(({ spec }) => spec.pipelineId).length).toBe(0);
  });

  it("uses the stored-spec stage briefing when the native Forked Lead adapter is unavailable", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", forker: "unwired" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);

    expect(flow.run(runId).forkDegradedReason).toBeTruthy();
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("running");
    expect(flow.pipeline(runId, pipelineId)!.stages[0].forkedLeadAgentId).toBeTruthy();
  });

  it("rejects duplicate stage names without persisting a partial pipeline", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const duplicate = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: {
      ...DEFAULT_PIPELINE,
      name: "duplicate-stage",
      stages: [DEFAULT_PIPELINE.stages[0], { ...DEFAULT_PIPELINE.stages[1], name: DEFAULT_PIPELINE.stages[0].name }],
    } });

    expect(duplicate).toMatchObject({ isError: true });
    expect(duplicate.text).toContain("duplicated");
    expect(Object.keys(flow.run(runId).pipelines)).toHaveLength(0);
  });
});
