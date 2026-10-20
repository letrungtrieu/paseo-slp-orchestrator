import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, definePipeline, delegateToLead, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("dynamic pipeline startup", () => {
  it("starts only the Supervisor in the base workspace on baseBranch, then lazily spawns Master Lead on delegation", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const run = flow.run(runId);

    expect(run.status).toBe("delegating");
    expect(run.tasks).toEqual({});
    // Only the Supervisor exists at startup; Master Lead is created lazily when the Supervisor delegates.
    expect(run.devWorkspaceId).toBe(run.supervisorWorkspaceId);
    expect(run.devCwd).toBe(flow.repoPath);
    expect(run.integrationBranch).toBe(run.baseBranch);
    expect(flow.paseo.createdWorkspaces).toHaveLength(0);
    expect(run.masterLeadAgentId).toBe("");
    expect(Object.values(run.agents).map((agent) => agent.role)).toEqual(["supervisor"]);

    await delegateToLead(flow, runId);
    const delegatedRun = flow.run(runId);
    expect(delegatedRun.status).toBe("planning");
    expect(delegatedRun.masterLeadAgentId).toBeTruthy();
    expect(Object.values(delegatedRun.agents).map((agent) => agent.role).sort()).toEqual(["master_lead", "supervisor"]);
    // Supervisor runs in the base workspace, while the Lead is immediately spawned inside its dedicated feature worktree.
    const supervisorSpec = flow.gateway.createdAgents.find(({ record }) => record.role === "supervisor")?.spec;
    const leadSpec = flow.gateway.createdAgents.find(({ record }) => record.role === "master_lead")?.spec;
    expect(supervisorSpec?.workspaceId).toBe(delegatedRun.supervisorWorkspaceId);
    expect(leadSpec?.workspaceId).not.toBe(delegatedRun.supervisorWorkspaceId);
    expect(delegatedRun.agents[delegatedRun.masterLeadAgentId].worktreePath).toBeTruthy();
    expect(flow.gateway.createdAgents.every(({ spec }) => spec.pipelineId == null && spec.stageId == null)).toBe(true);
    expect(flow.mailTo(runId, delegatedRun.masterLeadAgentId).at(-1)?.text).toContain("slp_define_pipeline");
  });

  it("accepts the Lead's complete JSON and reuses the Lead directly with equal peers in the pipeline worktree", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const run = flow.run(runId);
    const pipeline = flow.pipeline(runId, pipelineId)!;
    const stage = pipeline.stages[0];

    expect(pipeline.name).toBe(TWO_PEER_PIPELINE.name);
    expect(pipeline.description).toBe(TWO_PEER_PIPELINE.description);
    expect(stage.goal).toBe(TWO_PEER_PIPELINE.stages[0].goal);
    expect(stage.status).toBe("running");
    expect(stage.peerAgentIds).toHaveLength(2);
    expect(stage.forkedLeadAgentId).toBe(run.masterLeadAgentId);
    expect(pipeline.leadAgentId).toBe(run.masterLeadAgentId);
    expect(pipeline.workspaceId).not.toBe(run.supervisorWorkspaceId);
    for (const peerAgentId of stage.peerAgentIds) {
      const peerCreationSpec = flow.gateway.createdAgents.find(({ record }) => record.agentId === peerAgentId)?.spec;
      expect(peerCreationSpec?.workspaceId).toBe(pipeline.workspaceId);
    }
    expect(stage.peerAgentIds.map((agentId) => run.agents[agentId].projectRole)).toEqual(["reviewer", "developer"]);
    expect(stage.peerAgentIds.every((agentId) => run.agents[agentId].pipelineId === pipelineId)).toBe(true);
    expect(stage.peerAgentIds.every((agentId) => run.agents[agentId].stageId === stage.id)).toBe(true);
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
