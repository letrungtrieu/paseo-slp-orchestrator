import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, approveCurrentStage, currentStage, delegateToLead, eventually, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

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
    // Peers and Forked Lead stay alive while the pipeline is 'completed' so the Forked Lead can merge and consult peers on conflicts.
    expect(flow.gateway.archivedAgentIds).not.toContain(reviewerId);
    expect(flow.gateway.archivedAgentIds).not.toContain(coordinatorId);
    expect(flow.mailTo(runId, coordinatorId).at(-1)?.awaitTool).toBe("slp_finalize_pipeline");

    const finalization = await flow.callAs(coordinatorId, "slp_finalize_pipeline", {
      summary: "Stage changes verified and merged cleanly.",
    });
    expect(finalization.isError).toBe(false);
    expect(flow.gateway.archivedAgentIds).toContain(reviewerId);
    expect(flow.gateway.archivedAgentIds).toContain(coordinatorId);
  });

  it("runs peer_understand before stage 1, lets base_peer and forked_lead align via messages and rework, and forks every stage peer from base_peer", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE, { stopAtPeerUnderstand: true });

    const understandPipeline = flow.pipeline(runId, pipelineId)!;
    expect(understandPipeline.status).toBe("peer_understand");
    expect(understandPipeline.peerUnderstand.status).toBe("running");

    const basePeerId = understandPipeline.peerUnderstand.basePeerAgentId!;
    const forkedLeadId = understandPipeline.peerUnderstand.forkedLeadAgentId!;
    expect(basePeerId).toBeTruthy();
    expect(forkedLeadId).toBeTruthy();
    expect(flow.run(runId).agents[basePeerId]?.role).toBe("base_peer");
    expect(flow.run(runId).agents[basePeerId]?.projectRole).toBe("base-peer");

    // Base Peer asks Forked Lead a clarifying question during peer_understand and Forked Lead replies.
    const questionResponse = await flow.callAs(basePeerId, "slp_send_peer_message", {
      toAgentId: forkedLeadId,
      message: "Should billing import reject duplicate invoice IDs or upsert them?",
      waitForReply: true,
    });
    expect(questionResponse.isError).toBe(false);
    expect(flow.run(runId).agents[basePeerId]?.waitingForAgentId).toBe(forkedLeadId);

    const leadReplyResponse = await flow.callAs(forkedLeadId, "slp_send_peer_message", {
      toAgentId: basePeerId,
      message: "Upsert duplicate invoice IDs idempotently and return the updated count.",
      waitForReply: false,
    });
    expect(leadReplyResponse.isError).toBe(false);
    expect(flow.run(runId).agents[basePeerId]?.waitingForAgentId).toBeNull();
    expect(flow.pipeline(runId, pipelineId)!.peerUnderstand.messages).toHaveLength(2);

    // Base Peer submits its initial understanding report; Forked Lead requests one rework pass before approving.
    const firstUnderstandReport = await flow.callAs(basePeerId, "slp_stage_report", {
      summary: "Mapped billing import module and upsert contract.",
      findings: ["src/billing.ts handles batch parsing"],
      status: "completed",
    });
    expect(firstUnderstandReport.isError).toBe(false);

    const understandRework = await flow.callAs(forkedLeadId, "slp_stage_rework", {
      agentIds: [basePeerId],
      feedback: "Include the exact input/output types for the idempotent upsert in your report.",
    });
    expect(understandRework.isError).toBe(false);
    expect(flow.mailTo(runId, basePeerId).at(-1)?.awaitTool).toBe("slp_stage_report");

    const secondUnderstandReport = await flow.callAs(basePeerId, "slp_stage_report", {
      summary: "Mapped billing import with input InvoiceBatch -> output UpsertMetrics { inserted, updated }.",
      findings: ["Input: InvoiceBatch", "Output: UpsertMetrics { inserted, updated }"],
      status: "completed",
    });
    expect(secondUnderstandReport.isError).toBe(false);

    const approveUnderstand = await flow.callAs(forkedLeadId, "slp_approve_stage", {
      summary: "Base Peer fully understands the root problem and expected input/output contract.",
    });
    expect(approveUnderstand.isError).toBe(false);

    await eventually(() => {
      const activePipeline = flow.pipeline(runId, pipelineId);
      if (activePipeline?.status !== "running" || activePipeline.stages[0]?.status !== "running") {
        throw new Error("Stage 1 has not started after peer_understand approval");
      }
    });

    const postUnderstandPipeline = flow.pipeline(runId, pipelineId)!;
    const expectedBasePeerSessionId = `session-of-${basePeerId}`;
    expect(postUnderstandPipeline.peerUnderstand.status).toBe("completed");
    expect(postUnderstandPipeline.peerUnderstand.basePeerSessionId).toBe(expectedBasePeerSessionId);

    // Every Stage 1 peer is forked from Base Peer's provider session in the shared pipeline worktree.
    const stage1 = currentStage(flow, runId, pipelineId);
    expect(stage1.forkedLeadAgentId).toBe(forkedLeadId);
    for (const stage1PeerId of stage1.peerAgentIds) {
      const createdStage1Spec = flow.gateway.createdAgents.find(
        (createdEntry) => createdEntry.record.agentId === stage1PeerId,
      )?.spec;
      expect(createdStage1Spec?.extraOptions).toEqual({
        extraArgs: { resume: expectedBasePeerSessionId, "fork-session": null },
      });
      const peerBriefingText = flow.mailTo(runId, stage1PeerId).at(-1)?.text ?? "";
      expect(peerBriefingText).toContain("Base Peer Understanding (peer_understand)");
      expect(peerBriefingText).toContain("UpsertMetrics");
    }

    // Advance to Stage 2 and verify Stage 2 peers also fork from Base Peer's session without repeating discovery.
    for (const assignment of stage1.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    const stage2 = currentStage(flow, runId, pipelineId);
    for (const stage2PeerId of stage2.peerAgentIds) {
      const createdStage2Spec = flow.gateway.createdAgents.find(
        (createdEntry) => createdEntry.record.agentId === stage2PeerId,
      )?.spec;
      expect(createdStage2Spec?.extraOptions).toEqual({
        extraArgs: { resume: expectedBasePeerSessionId, "fork-session": null },
      });
    }
  });

  it("lets Forked Lead create the investigation goal first, confirm mutual understanding with Base Peer, and only then create the pipeline stages", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);

    // Master Lead creates a task shell without pre-defining stages so Forked Lead and Base Peer investigate first.
    const defineShellResponse = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
      pipeline: {
        name: "deferred-stage-pipeline",
        version: "1.0",
        description: "Investigate invoice reconciliation and build the required stages after mutual confirmation.",
      },
    });
    expect(defineShellResponse.isError).toBe(false);
    const pipelineId = JSON.parse(defineShellResponse.text).pipelineId as string;

    await eventually(() => {
      const activePipeline = flow.pipeline(runId, pipelineId);
      if (
        activePipeline?.status !== "peer_understand"
        || activePipeline.peerUnderstand.status !== "running"
        || !activePipeline.peerUnderstand.forkedLeadAgentId
        || !activePipeline.peerUnderstand.basePeerAgentId
      ) {
        throw new Error("peer_understand cohort is still starting");
      }
    });

    const initialPipeline = flow.pipeline(runId, pipelineId)!;
    const forkedLeadId = initialPipeline.peerUnderstand.forkedLeadAgentId!;
    const basePeerId = initialPipeline.peerUnderstand.basePeerAgentId!;
    expect(initialPipeline.stages).toHaveLength(0);
    expect(initialPipeline.peerUnderstand.investigationGoal).toBeNull();
    // Forked Lead is prompted first to formulate the investigation goal and send it to Base Peer.
    expect(flow.mailTo(runId, forkedLeadId).at(-1)?.awaitTool).toBe("slp_send_peer_message");
    expect(flow.mailTo(runId, forkedLeadId).at(-1)?.text).toContain("Step 1: Set the Investigation Goal for Base Peer");

    // Forked Lead cannot create pipeline stages before Base Peer has investigated and confirmed mutual understanding.
    const prematureStageCreate = await flow.callAs(forkedLeadId, "slp_define_pipeline", {
      pipelineId,
      stages: DEFAULT_PIPELINE.stages,
    });
    expect(prematureStageCreate.isError).toBe(true);
    expect(prematureStageCreate.text).toContain("Confirm mutual understanding with Base Peer first");

    // Step 1: Forked Lead creates the investigation goal and sends it to Base Peer via slp_send_peer_message.
    const investigationGoalText =
      "Inspect src/reconcile.ts, map the duplicate-invoice edge cases, and propose the exact input/output contract.";
    const sendGoalResponse = await flow.callAs(forkedLeadId, "slp_send_peer_message", {
      toAgentId: basePeerId,
      message: investigationGoalText,
      waitForReply: true,
    });
    expect(sendGoalResponse.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.peerUnderstand.investigationGoal).toBe(investigationGoalText);
    expect(flow.mailTo(runId, basePeerId).at(-1)?.awaitTool).toBe("slp_stage_report");
    expect(flow.mailTo(runId, basePeerId).at(-1)?.text).toContain(investigationGoalText);

    // Step 2: Base Peer investigates and submits slp_stage_report confirming mutual understanding with Forked Lead.
    const basePeerReportResponse = await flow.callAs(basePeerId, "slp_stage_report", {
      summary: "Confirmed reconciliation contract: ReconcileInput -> ReconcileResult { matched, unmatched }.",
      findings: ["src/reconcile.ts requires idempotent matching", "Contract: ReconcileInput -> ReconcileResult"],
      status: "completed",
    });
    expect(basePeerReportResponse.isError).toBe(false);
    expect(flow.mailTo(runId, forkedLeadId).at(-1)?.awaitTool).toBe("slp_define_pipeline");

    // Step 3: Only after mutual understanding is confirmed does Forked Lead create the pipeline stages.
    const createStagesResponse = await flow.callAs(forkedLeadId, "slp_define_pipeline", {
      pipelineId,
      summary: "Mutual understanding confirmed with Base Peer; creating coding and QA stages.",
      stages: [
        {
          name: "implement-reconcile",
          goal: "Implement ReconcileInput -> ReconcileResult according to the confirmed Base Peer blueprint.",
          peers: [{ role: "developer", task: "Implement src/reconcile.ts and unit tests." }],
        },
        {
          name: "verify-reconcile",
          goal: "Verify the reconciliation metrics and edge cases.",
          peers: [{ role: "qa_engineer", task: "Run reconciliation tests and verify metrics." }],
        },
      ],
    });
    expect(createStagesResponse.isError).toBe(false);

    await eventually(() => {
      const runningPipeline = flow.pipeline(runId, pipelineId);
      if (runningPipeline?.status !== "running" || runningPipeline.stages[0]?.status !== "running") {
        throw new Error("Stage 1 has not started after Forked Lead created pipeline stages");
      }
    });

    const activePipeline = flow.pipeline(runId, pipelineId)!;
    expect(activePipeline.stages).toHaveLength(2);
    expect(activePipeline.peerUnderstand.status).toBe("completed");
    expect(activePipeline.peerUnderstand.basePeerSessionId).toBe(`session-of-${basePeerId}`);
    const stage1PeerId = activePipeline.stages[0].peerAgentIds[0];
    const stage1PeerBriefing = flow.mailTo(runId, stage1PeerId).at(-1)?.text ?? "";
    expect(stage1PeerBriefing).toContain("Forked Lead Investigation Goal");
    expect(stage1PeerBriefing).toContain(investigationGoalText);
    expect(stage1PeerBriefing).toContain("ReconcileResult");
  });

  it("falls back to global peer config when a .slp/peers model does not match base_peer's provider so native session forking still succeeds", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    // Configure Base Peer on claude/claude-sonnet-4-6, Reviewer on a matching claude model, and Developer on a mismatched codex model.
    flow.store.mutate(runId, (mutableRun) => {
      mutableRun.promptConfig!.basePeer!.model = "claude/claude-sonnet-4-6";
      const reviewerRole = mutableRun.promptConfig!.peers.find((peer) => peer.role === "reviewer")!;
      const developerRole = mutableRun.promptConfig!.peers.find((peer) => peer.role === "developer")!;
      reviewerRole.model = "claude-opus-4-6";
      developerRole.model = "codex/gpt-5.4";
    });
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
    });
    const workspaceResponse = await flow.callAsRole(runId, "master_lead", null, "slp_create_worktree", {
      name: TWO_PEER_PIPELINE.name,
    });
    const createdWorkspace = JSON.parse(workspaceResponse.text) as { cwd: string };
    const defineResponse = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
      pipeline: { ...TWO_PEER_PIPELINE, worktree: createdWorkspace.cwd },
    });
    const definedPipelineId = JSON.parse(defineResponse.text).pipelineId as string;

    await eventually(() => {
      const activePipeline = flow.pipeline(runId, definedPipelineId);
      if (activePipeline?.status !== "peer_understand" || activePipeline.peerUnderstand.status !== "running") {
        throw new Error("peer_understand is still starting");
      }
    });
    const basePeerId = flow.pipeline(runId, definedPipelineId)!.peerUnderstand.basePeerAgentId!;
    const coordinatorId = flow.pipeline(runId, definedPipelineId)!.peerUnderstand.forkedLeadAgentId!;
    await flow.callAs(basePeerId, "slp_stage_report", {
      summary: "Base Peer mapped the repository on claude/claude-sonnet-4-6.",
      findings: ["Base Peer provider is claude"],
      status: "completed",
    });
    await flow.callAs(coordinatorId, "slp_approve_stage", {
      summary: "Approved Base Peer understanding.",
    });
    await eventually(() => {
      if (flow.pipeline(runId, definedPipelineId)?.status !== "running") {
        throw new Error("Stage 1 is still starting");
      }
    });

    const stage1 = currentStage(flow, runId, definedPipelineId);
    const reviewerPeerId = stage1.peerAgentIds[0];
    const developerPeerId = stage1.peerAgentIds[1];
    const reviewerCreatedSpec = flow.gateway.createdAgents.find(({ record }) => record.agentId === reviewerPeerId)?.spec;
    const developerCreatedSpec = flow.gateway.createdAgents.find(({ record }) => record.agentId === developerPeerId)?.spec;

    // Reviewer's short model ID matches Base Peer's claude provider, whereas Developer's codex model falls back to global claude/sonnet.
    expect(reviewerCreatedSpec?.provider).toBe("claude/claude-opus-4-6");
    expect(developerCreatedSpec?.provider).toBe("claude/sonnet");
    expect(reviewerCreatedSpec?.extraOptions).toEqual({
      extraArgs: { resume: `session-of-${basePeerId}`, "fork-session": null },
    });
    expect(developerCreatedSpec?.extraOptions).toEqual({
      extraArgs: { resume: `session-of-${basePeerId}`, "fork-session": null },
    });
  });
});
