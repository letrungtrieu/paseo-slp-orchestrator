// Pre-pipeline peer_understand phase: spawns a pipeline's Forked Lead and Base Peer so Base Peer
// investigates the repository and aligns with Forked Lead before stage peers fork from Base Peer's session.
import { randomUUID } from "node:crypto";
import { BASE_PEER_ROLE_ID, PEER_UNDERSTAND_STAGE_ID } from "../../shared/pipeline";
import type { MailboxMessage } from "../../shared/state";
import { resolveAgentSettings } from "../project-prompts/agent-settings";
import { defaultProjectPrompts } from "../project-prompts/defaults";
import type { PipelineContext } from "./context";
import {
  basePeerUnderstandBriefing, buildPeerUnderstandStageView,
  coordinatorPeerUnderstandGoalBriefing, coordinatorPeerUnderstandReviewBriefing, peerUnderstandPromptContext,
} from "./stage-briefings";
import { requirePipeline } from "./stage-context";

export {
  basePeerUnderstandBriefing, buildPeerUnderstandStageView,
  coordinatorPeerUnderstandGoalBriefing, coordinatorPeerUnderstandReviewBriefing, peerUnderstandPromptContext,
};

// Resolves native session fork options from Master Lead into Forked Lead in the integration worktree.
export async function forkLeadSessionOptions(
  ctx: PipelineContext, runId: string,
): Promise<Record<string, unknown> | undefined> {
  const currentRun = ctx.store.require(runId);
  // Native providers flush their session on turn end; wait for Master Lead's pipeline-definition turn to settle first.
  const masterLeadTurn = await ctx.gateway.waitForIdle(currentRun.masterLeadAgentId, 120_000);
  const leadModelDefaults = {
    provider: currentRun.providers.lead,
    thinkingOptionId: currentRun.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: currentRun.providers.leadPermissionModeId ?? undefined,
  };
  // Compare Master Lead's provider against Forked Lead's resolved provider before requesting a native session fork.
  const masterLeadSettings = resolveAgentSettings(currentRun.promptConfig, "master_lead", undefined, leadModelDefaults);
  const forkedLeadSettings = resolveAgentSettings(currentRun.promptConfig, "forked_lead", undefined, leadModelDefaults);
  const masterLeadSessionId =
    masterLeadTurn.status === "idle" ? await ctx.gateway.sessionIdOf(currentRun.masterLeadAgentId) : null;
  const forkBinding = await ctx.forks.resolve(
    masterLeadSessionId ? { provider: masterLeadSettings.provider, providerSessionId: masterLeadSessionId } : null,
    forkedLeadSettings.provider,
  );
  ctx.store.mutate(runId, (mutableRun) => {
    // Degraded forks still receive the full pipeline specification and stage briefings through the mailbox.
    mutableRun.forkDegradedReason = forkBinding.mode === "stored-spec" ? forkBinding.reason : null;
  });
  return forkBinding.mode === "native" ? forkBinding.providerOptions : undefined;
}

// Resolves native session fork options from the pipeline's Base Peer into a stage peer in the shared pipeline worktree.
export async function forkBasePeerSessionOptions(
  ctx: PipelineContext, runId: string, pipelineId: string, projectPeerRoleId: string,
): Promise<Record<string, unknown> | undefined> {
  const currentRun = ctx.store.require(runId);
  const targetPipeline = requirePipeline(currentRun, pipelineId);
  const peerModelDefaults = {
    provider: currentRun.providers.peer,
    thinkingOptionId: currentRun.providers.peerThinkingOptionId ?? undefined,
    permissionModeId: currentRun.providers.peerPermissionModeId ?? undefined,
  };
  // Stage peer resolution in resolveAgentSettings already enforces provider compatibility with Base Peer.
  const basePeerSettings = resolveAgentSettings(currentRun.promptConfig, "base_peer", undefined, peerModelDefaults);
  const stagePeerSettings = resolveAgentSettings(currentRun.promptConfig, "peer", projectPeerRoleId, peerModelDefaults);

  // Prefer the checkpointed session ID captured when peer_understand was approved; refresh live if missing.
  let basePeerSessionId = targetPipeline.peerUnderstand.basePeerSessionId;
  const basePeerAgentId = targetPipeline.peerUnderstand.basePeerAgentId;
  if (!basePeerSessionId && basePeerAgentId) {
    const basePeerTurn = await ctx.gateway.waitForIdle(basePeerAgentId, 60_000);
    if (basePeerTurn.status === "idle") {
      basePeerSessionId = await ctx.gateway.sessionIdOf(basePeerAgentId);
      if (basePeerSessionId) {
        // Persist the lazily fetched session ID so subsequent stage peers in this pipeline do not re-query Paseo.
        ctx.store.mutate(runId, (mutableRun) => {
          requirePipeline(mutableRun, pipelineId).peerUnderstand.basePeerSessionId = basePeerSessionId;
        });
      }
    }
  }

  // Request a native session fork from Base Peer's session into the stage peer's resolved provider.
  const forkBinding = await ctx.forks.resolve(
    basePeerSessionId ? { provider: basePeerSettings.provider, providerSessionId: basePeerSessionId } : null,
    stagePeerSettings.provider,
  );
  // Record a degraded reason only if a Base Peer existed and the provider could not natively fork its session.
  if (forkBinding.mode === "stored-spec" && basePeerAgentId) {
    ctx.store.mutate(runId, (mutableRun) => {
      mutableRun.forkDegradedReason ??= forkBinding.reason;
    });
  }
  return forkBinding.mode === "native" ? forkBinding.providerOptions : undefined;
}

// Guards asynchronous agent creation against race conditions where the pipeline paused or aborted mid-create.
async function keepCreatedPeerUnderstandAgent(
  ctx: PipelineContext, runId: string, pipelineId: string, agentId: string,
): Promise<void> {
  const currentRun = ctx.store.require(runId);
  const currentPipeline = requirePipeline(currentRun, pipelineId);
  if (
    currentRun.status === "running"
    && currentPipeline.status === "peer_understand"
    && currentPipeline.peerUnderstand.status === "starting"
  ) {
    return;
  }
  // Close late SDK creations immediately if the run or pipeline was paused or aborted while creation was in flight.
  await ctx.gateway.archive(agentId);
  throw new Error("peer_understand startup was cancelled.");
}

// Reconciles persisted peer_understand slots against live Paseo agent directory state before spawning replacements.
async function reconcilePeerUnderstandAgents(
  ctx: PipelineContext, runId: string, pipelineId: string,
): Promise<void> {
  const liveStatuses = await ctx.gateway.liveStatuses(runId);
  ctx.store.mutate(runId, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipelineId);
    const peerUnderstand = mutablePipeline.peerUnderstand;
    // Clear persisted coordinator or base_peer slots if their agent record was archived before reconciliation.
    if (peerUnderstand.forkedLeadAgentId && (!mutableRun.agents[peerUnderstand.forkedLeadAgentId] || mutableRun.agents[peerUnderstand.forkedLeadAgentId].archivedAt)) {
      peerUnderstand.forkedLeadAgentId = null;
    }
    if (peerUnderstand.basePeerAgentId && (!mutableRun.agents[peerUnderstand.basePeerAgentId] || mutableRun.agents[peerUnderstand.basePeerAgentId].archivedAt)) {
      peerUnderstand.basePeerAgentId = null;
    }

    // Re-attach surviving unarchived participants from SQLite so a daemon reload does not spawn duplicate sessions.
    const phaseParticipants = Object.values(mutableRun.agents).filter(
      (agentRecord) => agentRecord.pipelineId === pipelineId && agentRecord.stageId === PEER_UNDERSTAND_STAGE_ID && !agentRecord.archivedAt,
    );
    for (const participantRecord of phaseParticipants) {
      if (!liveStatuses.has(participantRecord.agentId)) {
        // Abort reconciliation when Paseo's directory has not returned a status for an expected participant yet.
        throw new Error(`Cannot confirm peer_understand participant '${participantRecord.agentId}'; retry recovery after the directory is available.`);
      }
      if (liveStatuses.get(participantRecord.agentId)?.archived) {
        // Retire participants archived externally in Paseo so startPeerUnderstandPhase spawns a clean replacement.
        participantRecord.archivedAt = new Date().toISOString();
        if (peerUnderstand.forkedLeadAgentId === participantRecord.agentId) peerUnderstand.forkedLeadAgentId = null;
        if (peerUnderstand.basePeerAgentId === participantRecord.agentId) peerUnderstand.basePeerAgentId = null;
        continue;
      }
      if (participantRecord.role === "forked_lead") peerUnderstand.forkedLeadAgentId = participantRecord.agentId;
      if (participantRecord.role === "base_peer") peerUnderstand.basePeerAgentId = participantRecord.agentId;
    }
  });
}

// Advances the pre-stage peer_understand phase, returning true when peer_understand is completed and Stage 1 may proceed.
export async function advancePeerUnderstandPhase(
  ctx: PipelineContext, runId: string, pipelineId: string,
): Promise<boolean> {
  const initialRun = ctx.store.require(runId);
  const initialPipeline = requirePipeline(initialRun, pipelineId);
  if (initialPipeline.peerUnderstand.status === "completed") return true;

  if (initialPipeline.peerUnderstand.status === "running") {
    const liveStatuses = await ctx.gateway.liveStatuses(runId);
    const refreshedPipeline = requirePipeline(ctx.store.require(runId), pipelineId);
    const activePhaseIds = [
      refreshedPipeline.peerUnderstand.forkedLeadAgentId,
      refreshedPipeline.peerUnderstand.basePeerAgentId,
    ].filter((agentId): agentId is string => Boolean(agentId));
    // Re-enter starting if either Forked Lead or Base Peer vanished or was archived while peer_understand was running.
    if (
      refreshedPipeline.peerUnderstand.status === "running"
      && activePhaseIds.some((agentId) => !liveStatuses.has(agentId) || liveStatuses.get(agentId)?.archived)
    ) {
      ctx.store.mutate(runId, (mutableRun) => {
        requirePipeline(mutableRun, pipelineId).peerUnderstand.status = "starting";
      });
    }
  }

  const currentPipeline = requirePipeline(ctx.store.require(runId), pipelineId);
  // Respect pipeline pauses (e.g., Master Lead escalation) until slp_resume_pipeline explicitly reopens it.
  if (currentPipeline.status === "paused") return false;
  if (currentPipeline.peerUnderstand.status === "completing") {
    await finishPeerUnderstandPhase(ctx, runId, pipelineId);
  }
  const afterFinishPipeline = requirePipeline(ctx.store.require(runId), pipelineId);
  if (afterFinishPipeline.peerUnderstand.status === "completed") return true;
  // Start or recover the Forked Lead + Base Peer discovery cohort when peer_understand is pending or starting.
  if (["pending", "starting"].includes(afterFinishPipeline.peerUnderstand.status)) {
    await startPeerUnderstandPhase(ctx, runId, pipelineId);
  }
  return false;
}

// Spawns or recovers the Forked Lead and Base Peer cohort and queues the initial discovery or review briefing.
async function startPeerUnderstandPhase(
  ctx: PipelineContext, runId: string, pipelineId: string,
): Promise<void> {
  const initialRun = ctx.store.require(runId);
  const initialPipeline = requirePipeline(initialRun, pipelineId);
  if (!initialPipeline.workspaceId) throw new Error("Pipeline has no registered worktree workspace.");

  const wasPhaseAlreadyStarted = Boolean(initialPipeline.peerUnderstand.startedAt);
  const previousCoordinatorId = initialPipeline.peerUnderstand.forkedLeadAgentId;
  const previousBasePeerId = initialPipeline.peerUnderstand.basePeerAgentId;

  // Mark the pipeline and peerUnderstand phase as starting before awaiting any asynchronous SDK calls.
  ctx.store.mutate(runId, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipelineId);
    mutablePipeline.status = "peer_understand";
    mutablePipeline.peerUnderstand.status = "starting";
  });

  await reconcilePeerUnderstandAgents(ctx, runId, pipelineId);

  let coordinatorCreated = false;
  let basePeerCreated = false;

  // Spawn the pipeline's Forked Lead first so Base Peer can link to it as parentAgentId and message it immediately.
  if (!requirePipeline(ctx.store.require(runId), pipelineId).peerUnderstand.forkedLeadAgentId) {
    const leadForkExtraOptions = await forkLeadSessionOptions(ctx, runId);
    const latestRun = ctx.store.require(runId);
    const latestPipeline = requirePipeline(latestRun, pipelineId);
    const createdCoordinator = await ctx.gateway.createAgent({
      runId, role: "forked_lead", taskId: null, pipelineId, stageId: PEER_UNDERSTAND_STAGE_ID,
      provider: latestRun.providers.lead,
      thinkingOptionId: latestRun.providers.leadThinkingOptionId ?? undefined,
      permissionModeId: latestRun.providers.leadPermissionModeId ?? undefined,
      // Forked Lead lives in the integration worktree so Claude session forks resolve from Master Lead's cwd.
      workspaceId: latestRun.devWorkspaceId, parentAgentId: latestRun.masterLeadAgentId,
      title: `[Lead] [${latestPipeline.name} · ${PEER_UNDERSTAND_STAGE_ID}]`, awaitTool: null,
      stageContext: peerUnderstandPromptContext(
        latestPipeline,
        "Collaborate with Base Peer during peer_understand and approve once Base Peer thoroughly understands the task.",
      ),
      extraOptions: leadForkExtraOptions,
    });
    await keepCreatedPeerUnderstandAgent(ctx, runId, pipelineId, createdCoordinator.agentId);
    ctx.store.mutate(runId, (mutableRun) => {
      requirePipeline(mutableRun, pipelineId).peerUnderstand.forkedLeadAgentId = createdCoordinator.agentId;
    });
    coordinatorCreated = true;
  }

  // Spawn the read-only Base Peer inside the pipeline worktree so its session can later be forked by stage peers.
  if (!requirePipeline(ctx.store.require(runId), pipelineId).peerUnderstand.basePeerAgentId) {
    const latestRun = ctx.store.require(runId);
    const latestPipeline = requirePipeline(latestRun, pipelineId);
    const basePeerDefinition = latestRun.promptConfig?.basePeer ?? defaultProjectPrompts().basePeer!;
    const createdBasePeer = await ctx.gateway.createAgent({
      runId, role: "base_peer", projectRole: BASE_PEER_ROLE_ID, taskId: null,
      pipelineId, stageId: PEER_UNDERSTAND_STAGE_ID, stagePeerId: "base",
      provider: latestRun.providers.peer,
      thinkingOptionId: latestRun.providers.peerThinkingOptionId ?? undefined,
      permissionModeId: latestRun.providers.peerPermissionModeId ?? undefined,
      // Base Peer lives in the pipeline's dedicated worktree so every subsequent stage peer can fork its session in the same cwd.
      workspaceId: latestPipeline.workspaceId!,
      parentAgentId: latestPipeline.peerUnderstand.forkedLeadAgentId ?? undefined,
      peerWorktreePath: latestPipeline.worktree, writeScope: [],
      title: `[${basePeerDefinition.name}] [${latestPipeline.name} · ${PEER_UNDERSTAND_STAGE_ID}]`, awaitTool: null,
      stageContext: peerUnderstandPromptContext(latestPipeline, latestPipeline.description),
    });
    await keepCreatedPeerUnderstandAgent(ctx, runId, pipelineId, createdBasePeer.agentId);
    ctx.store.mutate(runId, (mutableRun) => {
      requirePipeline(mutableRun, pipelineId).peerUnderstand.basePeerAgentId = createdBasePeer.agentId;
    });
    basePeerCreated = true;
  }

  const activatedAt = new Date().toISOString();
  // Helper to construct a durable mailbox entry with an expected tool obligation for either Base Peer or Forked Lead.
  const buildQueuedMail = (toAgentId: string, text: string, awaitTool: string | null): MailboxMessage => ({
    id: randomUUID(), toAgentId, text, taskId: null, awaitTool, isReminder: false, createdAt: activatedAt,
  });

  ctx.store.mutate(runId, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipelineId);
    const peerUnderstand = mutablePipeline.peerUnderstand;
    if (
      mutablePipeline.status !== "peer_understand" || peerUnderstand.status !== "starting"
      || !peerUnderstand.forkedLeadAgentId || !peerUnderstand.basePeerAgentId
    ) {
      throw new Error("peer_understand startup is no longer active.");
    }

    // Redirect any pending conversation waits or parent pointers that referenced a replaced Forked Lead or Base Peer.
    const replacementByDeadId = new Map<string, string>();
    if (previousCoordinatorId && previousCoordinatorId !== peerUnderstand.forkedLeadAgentId) {
      replacementByDeadId.set(previousCoordinatorId, peerUnderstand.forkedLeadAgentId);
    }
    if (previousBasePeerId && previousBasePeerId !== peerUnderstand.basePeerAgentId) {
      replacementByDeadId.set(previousBasePeerId, peerUnderstand.basePeerAgentId);
    }
    if (replacementByDeadId.size > 0) {
      mutableRun.mailbox = mutableRun.mailbox.filter((queuedMessage) => !replacementByDeadId.has(queuedMessage.toAgentId));
      for (const agentRecord of Object.values(mutableRun.agents)) {
        if (agentRecord.waitingForAgentId && replacementByDeadId.has(agentRecord.waitingForAgentId)) {
          agentRecord.waitingForAgentId = replacementByDeadId.get(agentRecord.waitingForAgentId) ?? null;
        }
        if (agentRecord.parentAgentId && replacementByDeadId.has(agentRecord.parentAgentId)) {
          agentRecord.parentAgentId = replacementByDeadId.get(agentRecord.parentAgentId) ?? agentRecord.parentAgentId;
        }
      }
    }

    // Ensure Base Peer is parented under the active Forked Lead so hierarchy cleanup and UI trees stay consistent.
    const basePeerRecord = mutableRun.agents[peerUnderstand.basePeerAgentId];
    if (basePeerRecord) {
      basePeerRecord.parentAgentId = peerUnderstand.forkedLeadAgentId;
    }

    mutablePipeline.status = "peer_understand";
    mutablePipeline.updatedAt = activatedAt;
    peerUnderstand.status = "running";
    peerUnderstand.startedAt ??= activatedAt;

    // When no stages and no investigationGoal exist yet, Forked Lead creates the investigation goal first via slp_send_peer_message;
    // otherwise Base Peer receives the discovery briefing directly or Forked Lead reviews submitted reports.
    const needsForkedLeadInvestigationGoal =
      mutablePipeline.stages.length === 0
      && !peerUnderstand.investigationGoal
      && peerUnderstand.reports.length === 0;
    if (needsForkedLeadInvestigationGoal && (!wasPhaseAlreadyStarted || coordinatorCreated)) {
      mutableRun.mailbox.push(
        buildQueuedMail(
          peerUnderstand.forkedLeadAgentId,
          coordinatorPeerUnderstandGoalBriefing(mutableRun, mutablePipeline),
          "slp_send_peer_message",
        ),
      );
    } else if (!wasPhaseAlreadyStarted || basePeerCreated) {
      mutableRun.mailbox.push(
        buildQueuedMail(peerUnderstand.basePeerAgentId, basePeerUnderstandBriefing(mutableRun, mutablePipeline), "slp_stage_report"),
      );
    } else if (coordinatorCreated && peerUnderstand.reports.length > 0) {
      const reviewAwaitTool = mutablePipeline.stages.length === 0 ? "slp_define_pipeline" : "slp_approve_stage";
      mutableRun.mailbox.push(
        buildQueuedMail(peerUnderstand.forkedLeadAgentId, coordinatorPeerUnderstandReviewBriefing(mutableRun, mutablePipeline), reviewAwaitTool),
      );
    }
  });

  const startedPipeline = requirePipeline(ctx.store.require(runId), pipelineId);
  // Emit a single stage.started event the first time peer_understand enters running state.
  if (!wasPhaseAlreadyStarted && startedPipeline.peerUnderstand.forkedLeadAgentId) {
    ctx.logEvent(runId, {
      taskId: null, from: "pipeline", to: startedPipeline.peerUnderstand.forkedLeadAgentId,
      kind: "stage.started", summary: `${startedPipeline.name}/${PEER_UNDERSTAND_STAGE_ID}: base_peer discovery`, outcome: "queued",
    });
  }
}

// Checkpoints Base Peer's provider session ID once Forked Lead approves peer_understand and transitions the pipeline to Stage 1.
async function finishPeerUnderstandPhase(
  ctx: PipelineContext, runId: string, pipelineId: string,
): Promise<void> {
  const initialRun = ctx.store.require(runId);
  const initialPipeline = requirePipeline(initialRun, pipelineId);
  const peerUnderstand = initialPipeline.peerUnderstand;
  if (!peerUnderstand.result) {
    throw new Error("peer_understand cannot complete without its Forked Lead approval.");
  }

  // Wait for both Forked Lead and Base Peer turns to settle so Base Peer's session is flushed before stage peers fork it.
  if (peerUnderstand.forkedLeadAgentId && !initialRun.agents[peerUnderstand.forkedLeadAgentId]?.archivedAt) {
    await ctx.gateway.waitForIdle(peerUnderstand.forkedLeadAgentId, 60_000);
  }
  let capturedBasePeerSessionId: string | null = peerUnderstand.basePeerSessionId;
  if (peerUnderstand.basePeerAgentId && !initialRun.agents[peerUnderstand.basePeerAgentId]?.archivedAt) {
    const basePeerTurn = await ctx.gateway.waitForIdle(peerUnderstand.basePeerAgentId, 60_000);
    if (basePeerTurn.status === "idle") {
      capturedBasePeerSessionId = await ctx.gateway.sessionIdOf(peerUnderstand.basePeerAgentId);
    }
  }

  const latestRun = ctx.store.require(runId);
  const latestPipeline = requirePipeline(latestRun, pipelineId);
  // Abort transition if the run or pipeline changed state while waiting for turns to become idle.
  if (
    latestRun.status !== "running"
    || latestPipeline.status !== "peer_understand"
    || latestPipeline.peerUnderstand.status !== "completing"
  ) {
    return;
  }

  const completedAt = new Date().toISOString();
  ctx.store.mutate(runId, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipelineId);
    // Checkpoint Base Peer's session ID and return the pipeline to 'queued' so Stage 1 starts immediately.
    mutablePipeline.peerUnderstand.status = "completed";
    mutablePipeline.peerUnderstand.completedAt = completedAt;
    mutablePipeline.peerUnderstand.basePeerSessionId = capturedBasePeerSessionId;
    mutablePipeline.status = "queued";
    mutablePipeline.updatedAt = completedAt;

    // Clear any leftover peer_understand obligations and unread mail before Stage 1 starts.
    for (const pipelineAgent of Object.values(mutableRun.agents)) {
      if (pipelineAgent.pipelineId !== pipelineId) continue;
      pipelineAgent.awaitingTool = null;
      pipelineAgent.awaitingSince = null;
      pipelineAgent.nudges = 0;
      pipelineAgent.waitingForAgentId = null;
      pipelineAgent.deferredTool = null;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => mutableRun.agents[queuedMessage.toAgentId]?.pipelineId !== pipelineId,
    );
  });
}
