import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, definePipeline, delegateToLead, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("dynamic pipeline startup", () => {
  it("starts only orchestration roles, then delegates acceptance criteria to the Lead", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const run = flow.run(runId);

    expect(run.status).toBe("delegating");
    expect(run.tasks).toEqual({});
    expect(Object.values(run.agents).map((agent) => agent.role).sort()).toEqual(["master_lead", "supervisor"]);
    expect(flow.gateway.createdAgents.every(({ spec }) => spec.pipelineId == null && spec.stageId == null)).toBe(true);

    await delegateToLead(flow, runId);
    expect(flow.run(runId).status).toBe("planning");
    expect(flow.mailTo(runId, run.masterLeadAgentId).at(-1)?.text).toContain("slp_define_pipeline");
  });

  it("accepts the Lead's complete JSON and creates one Forked Lead plus equal peers", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const pipeline = flow.pipeline(runId, pipelineId)!;
    const stage = pipeline.stages[0];

    expect(pipeline.name).toBe(TWO_PEER_PIPELINE.name);
    expect(pipeline.description).toBe(TWO_PEER_PIPELINE.description);
    expect(stage.goal).toBe(TWO_PEER_PIPELINE.stages[0].goal);
    expect(stage.status).toBe("running");
    expect(stage.peerAgentIds).toHaveLength(2);
    expect(stage.forkedLeadAgentId).toBeTruthy();
    expect(stage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId].projectRole)).toEqual(["reviewer", "developer"]);
    expect(stage.peerAgentIds.every((agentId) => flow.run(runId).agents[agentId].pipelineId === pipelineId)).toBe(true);
    expect(stage.peerAgentIds.every((agentId) => flow.run(runId).agents[agentId].stageId === stage.id)).toBe(true);
  });

  it("rejects a second pipeline with the same name and version before allocating a cohort", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    // Creating the first pipeline through the normal worktree handoff ensures only duplicate
    // name/version validation is exercised on the second call.
    const { runId, pipelineId: firstId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const peerCountBefore = flow.gateway.createdAgents.filter(({ spec }) => spec.pipelineId === firstId).length;
    const duplicate = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: {
      ...DEFAULT_PIPELINE,
      worktree: flow.pipeline(runId, firstId)!.worktree,
    } });

    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain("already exists");
    expect(flow.gateway.createdAgents.filter(({ spec }) => spec.pipelineId === firstId)).toHaveLength(peerCountBefore);
  });
});
