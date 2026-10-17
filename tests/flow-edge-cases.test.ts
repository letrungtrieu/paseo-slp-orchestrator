import { describe, expect, it } from "vitest";
import { recoverPipelines } from "../server/pipeline/stage-engine";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, currentStage, delegateToLead, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

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

  // Surviving peers in a multi-peer stage must keep their reports and not receive a duplicate stage briefing when a sibling dies.
  it("preserves healthy peer reports and remaps waitingForAgentId when a sibling peer or Forked Lead dies mid-stage", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    await flow.deliverMail(runId);
    const initialStage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", initialStage.id);
    const deadDeveloperId = flow.agentId(runId, "developer", initialStage.id);
    const originalCoordinatorId = initialStage.forkedLeadAgentId!;

    await reportPeer(flow, runId, pipelineId, "reviewer", "Reviewer completed analysis before developer crashed.");
    flow.store.mutate(runId, (run) => {
      run.agents[reviewerId].waitingForAgentId = deadDeveloperId;
    });
    await flow.gateway.archive(deadDeveloperId);
    flow.gateway.prompts.length = 0;

    await recoverPipelines(flow.ctx, runId);
    await flow.deliverMail(runId);

    const stageAfterPeerRevival = currentStage(flow, runId, pipelineId);
    const revivedDeveloperId = stageAfterPeerRevival.peerAgentIds[1];
    expect(revivedDeveloperId).not.toBe(deadDeveloperId);
    expect(stageAfterPeerRevival.peerAgentIds[0]).toBe(reviewerId);
    // The healthy reviewer was not re-prompted and its direct-reply wait now points to the replacement developer.
    expect(flow.gateway.promptsTo(reviewerId)).toEqual([]);
    expect(flow.gateway.promptsTo(revivedDeveloperId)).toHaveLength(1);
    expect(flow.run(runId).agents[reviewerId].waitingForAgentId).toBe(revivedDeveloperId);

    // Now simulate the Forked Lead dying after peer reports exist; the replacement coordinator must receive the saved reports.
    await flow.gateway.archive(originalCoordinatorId);
    flow.gateway.prompts.length = 0;
    await recoverPipelines(flow.ctx, runId);
    await flow.deliverMail(runId);

    const stageAfterCoordinatorRevival = currentStage(flow, runId, pipelineId);
    const revivedCoordinatorId = stageAfterCoordinatorRevival.forkedLeadAgentId!;
    expect(revivedCoordinatorId).not.toBe(originalCoordinatorId);
    expect(flow.gateway.promptsTo(revivedCoordinatorId).at(-1)).toContain("Reviewer completed analysis before developer crashed.");
    expect(flow.run(runId).agents[revivedCoordinatorId].awaitingTool).toBe("slp_approve_stage");
  });

  // The Supervisor and Master Lead can explicitly revive dead or stalled agents on demand via slp_revive_agent.
  it("allows Supervisor and Master Lead to revive dead Master Lead and stage participants via slp_revive_agent", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const originalMasterLeadId = flow.run(runId).masterLeadAgentId;
    const originalStagePeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];

    // Master Lead revives a wedged stage peer on demand.
    const stageReviveOutcome = await flow.callAs(originalMasterLeadId, "slp_revive_agent", {
      target: "agent",
      agentId: originalStagePeerId,
      reason: "peer stopped responding",
    });
    expect(stageReviveOutcome.isError).toBe(false);
    const replacementStagePeerId = currentStage(flow, runId, pipelineId).peerAgentIds[0];
    expect(replacementStagePeerId).not.toBe(originalStagePeerId);

    // Supervisor revives a dead Master Lead on demand.
    await flow.gateway.archive(originalMasterLeadId);
    const leadReviveOutcome = await flow.callAsRole(runId, "supervisor", null, "slp_revive_agent", {
      target: "master_lead",
      reason: "Master Lead process exited",
    });
    expect(leadReviveOutcome.isError).toBe(false);
    expect(flow.run(runId).masterLeadAgentId).not.toBe(originalMasterLeadId);
  });
});

