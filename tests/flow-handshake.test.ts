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
    await reportPeer(flow, runId, pipelineId, "developer", "Developer implementation is ready.");
    await approveCurrentStage(flow, runId, pipelineId);
    expect(flow.pipeline(runId, pipelineId)!.stages[0].status).toBe("completed");
    // Peers and Lead stay alive while the pipeline is 'completed' so the Lead can merge and consult peers on conflicts.
    expect(flow.gateway.archivedAgentIds).not.toContain(reviewerId);
    expect(flow.gateway.archivedAgentIds).not.toContain(coordinatorId);
    expect(flow.mailTo(runId, coordinatorId).at(-1)?.awaitTool).toBe("slp_finalize_pipeline");

    const finalization = await flow.callAs(coordinatorId, "slp_finalize_pipeline", {
      summary: "Stage changes verified and merged cleanly.",
    });
    expect(finalization.isError).toBe(false);
    expect(flow.gateway.archivedAgentIds).toContain(reviewerId);
    expect(flow.run(runId).agents[coordinatorId].awaitingTool).toBe("slp_report");
  });

  it("spawns N dedicated Leads in immediate worktrees on parallel slp_delegate, lets sibling Leads align contracts via slp_send_peer_message, and forks stage Peers directly from their owning Lead", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();

    // Supervisor analyzes the requirement and delegates two parallel features (`auth-api` and `checkout-ui`) with shared context.
    const delegateResponse = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Deliver both auth-api and checkout-ui with a consistent session token contract.",
      sharedContext: "Both features share the `X-Session-Token` header and `SessionPayload` response schema.",
      tasks: [
        {
          name: "auth-api",
          acceptanceCriteria: "Implement `/api/auth/session` returning `SessionPayload`.",
        },
        {
          name: "checkout-ui",
          acceptanceCriteria: "Consume `/api/auth/session` in the checkout header component.",
        },
      ],
    });
    expect(delegateResponse.isError).toBe(false);

    const planningRun = flow.run(runId);
    expect(planningRun.status).toBe("planning");
    const activeLeadRecords = Object.values(planningRun.agents).filter(
      (agentRecord) => agentRecord.role === "master_lead" && !agentRecord.archivedAt,
    );
    expect(activeLeadRecords).toHaveLength(2);

    const authLead = activeLeadRecords.find((agentRecord) => agentRecord.featureName === "auth-api")!;
    const checkoutLead = activeLeadRecords.find((agentRecord) => agentRecord.featureName === "checkout-ui")!;
    expect(authLead).toBeTruthy();
    expect(checkoutLead).toBeTruthy();
    // Each Lead is immediately placed in its own dedicated Git worktree at slp_delegate.
    expect(authLead.worktreePath).toBeTruthy();
    expect(checkoutLead.worktreePath).toBeTruthy();
    expect(authLead.worktreePath).not.toBe(checkoutLead.worktreePath);

    // Each Lead's delegation message includes the sibling Lead's agentId, feature name, branch, and acceptance criteria.
    const authDelegationText = flow.mailTo(runId, authLead.agentId).at(-1)?.text ?? "";
    const checkoutDelegationText = flow.mailTo(runId, checkoutLead.agentId).at(-1)?.text ?? "";
    expect(authDelegationText).toContain(checkoutLead.agentId);
    expect(authDelegationText).toContain("checkout-ui");
    expect(authDelegationText).toContain("X-Session-Token");
    expect(checkoutDelegationText).toContain(authLead.agentId);
    expect(checkoutDelegationText).toContain("auth-api");

    // During planning (before defining pipelines), Checkout Lead contacts Auth Lead directly via slp_send_peer_message to align the exact schema.
    const alignQuestion = await flow.callAs(checkoutLead.agentId, "slp_send_peer_message", {
      toAgentId: authLead.agentId,
      message: "Let's confirm: will `/api/auth/session` return `{ token: string, expiresAt: string }`?",
      waitForReply: true,
    });
    expect(alignQuestion.isError).toBe(false);
    expect(flow.run(runId).agents[checkoutLead.agentId].waitingForAgentId).toBe(authLead.agentId);

    const alignReply = await flow.callAs(authLead.agentId, "slp_send_peer_message", {
      toAgentId: checkoutLead.agentId,
      message: "Confirmed: `{ token: string, expiresAt: string }` with status 200.",
      waitForReply: false,
    });
    expect(alignReply.isError).toBe(false);
    expect(flow.run(runId).agents[checkoutLead.agentId].waitingForAgentId).toBeNull();
    expect(flow.mailTo(runId, checkoutLead.agentId).at(-1)?.text).toContain("Confirmed: `{ token: string, expiresAt: string }`");

    // Both Leads now define their pipelines in their own pre-created worktrees (without needing slp_create_worktree).
    const authDefineResponse = await flow.callAs(authLead.agentId, "slp_define_pipeline", {
      pipeline: {
        name: "auth-api",
        version: "1.0",
        description: "Auth API pipeline",
        stages: [
          {
            name: "implement-auth",
            goal: "Implement /api/auth/session with { token, expiresAt }.",
            peers: [{ role: "developer", task: "Build auth endpoint." }],
          },
        ],
      },
    });
    expect(authDefineResponse.isError).toBe(false);
    const authPipelineId = JSON.parse(authDefineResponse.text).pipelineId as string;

    // Checkout Lead defines its pipeline concurrently in its own worktree after aligning on the session payload contract.
    const checkoutDefineResponse = await flow.callAs(checkoutLead.agentId, "slp_define_pipeline", {
      pipeline: {
        name: "checkout-ui",
        version: "1.0",
        description: "Checkout UI pipeline",
        stages: [
          {
            name: "implement-checkout",
            goal: "Consume /api/auth/session in checkout header.",
            peers: [{ role: "developer", task: "Build checkout header." }],
          },
        ],
      },
    });
    expect(checkoutDefineResponse.isError).toBe(false);
    const checkoutPipelineId = JSON.parse(checkoutDefineResponse.text).pipelineId as string;

    await eventually(() => {
      const authPipeline = flow.pipeline(runId, authPipelineId);
      const checkoutPipeline = flow.pipeline(runId, checkoutPipelineId);
      if (authPipeline?.status !== "running" || checkoutPipeline?.status !== "running") {
        throw new Error("Parallel Lead pipelines are still starting");
      }
    });

    // Verify each pipeline uses its owning Lead's dedicated worktree and forks its stage Peers directly from that Lead's session.
    const authPipeline = flow.pipeline(runId, authPipelineId)!;
    const checkoutPipeline = flow.pipeline(runId, checkoutPipelineId)!;
    expect(authPipeline.worktree).toBe(authLead.worktreePath);
    expect(checkoutPipeline.worktree).toBe(checkoutLead.worktreePath);
    expect(authPipeline.leadAgentId).toBe(authLead.agentId);
    expect(checkoutPipeline.leadAgentId).toBe(checkoutLead.agentId);

    const authPeerId = authPipeline.stages[0].peerAgentIds[0];
    const checkoutPeerId = checkoutPipeline.stages[0].peerAgentIds[0];
    const authPeerSpec = flow.gateway.createdAgents.find(({ record }) => record.agentId === authPeerId)?.spec;
    const checkoutPeerSpec = flow.gateway.createdAgents.find(({ record }) => record.agentId === checkoutPeerId)?.spec;
    expect(authPeerSpec?.extraOptions).toEqual({
      extraArgs: { resume: `session-of-${authLead.agentId}`, "fork-session": null },
    });
    expect(checkoutPeerSpec?.extraOptions).toEqual({
      extraArgs: { resume: `session-of-${checkoutLead.agentId}`, "fork-session": null },
    });
  });

  it("falls back to global peer config when a .slp/peers model does not match Lead's provider so native session forking still succeeds", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    // Configure Lead on claude/claude-sonnet-4-6, Reviewer on a matching claude model, and Developer on a mismatched codex model.
    flow.store.mutate(runId, (mutableRun) => {
      mutableRun.promptConfig!.lead.model = "claude/claude-sonnet-4-6";
      const reviewerRole = mutableRun.promptConfig!.peers.find((peer) => peer.role === "reviewer")!;
      const developerRole = mutableRun.promptConfig!.peers.find((peer) => peer.role === "developer")!;
      reviewerRole.model = "claude-opus-4-6";
      developerRole.model = "codex/gpt-5.4";
    });
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
    });
    const leadId = flow.run(runId).masterLeadAgentId;
    const defineResponse = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
      pipeline: { ...TWO_PEER_PIPELINE, worktree: undefined },
    });
    const definedPipelineId = JSON.parse(defineResponse.text).pipelineId as string;

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

    // Reviewer's short model ID matches Lead's claude provider, whereas Developer's codex model falls back to global claude/sonnet.
    expect(reviewerCreatedSpec?.provider).toBe("claude/claude-opus-4-6");
    expect(developerCreatedSpec?.provider).toBe("claude/sonnet");
    expect(reviewerCreatedSpec?.extraOptions).toEqual({
      extraArgs: { resume: `session-of-${leadId}`, "fork-session": null },
    });
    expect(developerCreatedSpec?.extraOptions).toEqual({
      extraArgs: { resume: `session-of-${leadId}`, "fork-session": null },
    });
  });
});
