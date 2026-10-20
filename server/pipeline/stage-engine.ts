// Sequential stages are data authored by Lead; the scheduler only manages cohorts, approval and durable handover.
import { randomUUID } from "node:crypto";
import type { PipelineState, StageState } from "../../shared/pipeline";
import type { MailboxMessage } from "../../shared/state";
import { peerRole } from "../project-prompts/defaults";
import type { PipelineContext } from "./context";
import {
  advancePeerUnderstandPhase,
  forkBasePeerSessionOptions,
  forkLeadSessionOptions,
} from "./peer-understand";
import {
  coordinatorRevivalBriefing,
  peerRosterUpdateNotice,
  peerStageBriefing,
  pipelineFinalizationBriefing,
  stagePromptContext,
} from "./stage-briefings";
import { pausePipeline, requirePipeline } from "./stage-context";
import { stageMail } from "./stage-mail";

// Recovery ticks and an approval tool may arrive together; only one may create or retire a cohort.
const advancingPipelines = new Set<string>();

interface StageActivationChanges {
  wasStageAlreadyStarted: boolean;
  coordinatorCreated: boolean;
  createdPeerIndices: ReadonlySet<number>;
  previousCoordinatorId: string | null;
  previousPeerAgentIds: readonly string[];
}

function currentAssignment(ctx: PipelineContext, runId: string, pipelineId: string) {
  const run = ctx.store.require(runId);
  const pipeline = requirePipeline(run, pipelineId);
  const stage = pipeline.stages[pipeline.currentStageIndex];
  if (run.status !== "running" || !stage || !["queued", "starting", "running"].includes(pipeline.status)) {
    throw new Error("Pipeline execution was stopped.");
  }
  // Nested state can be replaced by a rolled-back concurrent mutation, so async boundaries always resolve it again.
  return { run, pipeline, stage };
}

async function keepCreatedAgent(ctx: PipelineContext, runId: string, pipelineId: string, stageId: string, agentId: string): Promise<void> {
  const run = ctx.store.require(runId);
  const pipeline = requirePipeline(run, pipelineId);
  if (run.status === "running" && pipeline.stages[pipeline.currentStageIndex]?.id === stageId && pipeline.status === "starting") return;
  // An abort can finish while the SDK creation request is still in flight; close that late arrival immediately.
  await ctx.gateway.archive(agentId);
  throw new Error("Stage creation was cancelled.");
}

export async function recoverPipelines(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  if (run.status !== "running") return;
  await Promise.all(Object.values(run.pipelines).map((pipeline) => advancePipeline(ctx, runId, pipeline.id)));
}

async function advancePipeline(ctx: PipelineContext, runId: string, pipelineId: string): Promise<void> {
  const operationKey = `${runId}:${pipelineId}`;
  if (advancingPipelines.has(operationKey)) return;
  advancingPipelines.add(operationKey);
  try {
    const initialRun = ctx.store.require(runId);
    const pipeline = requirePipeline(initialRun, pipelineId);
    if (pipeline.status === "completed" && !pipeline.gate && initialRun.status === "running") {
      const finalCoordinatorId = pipeline.stages.at(-1)?.forkedLeadAgentId ?? null;
      const liveStatuses = await ctx.gateway.liveStatuses(runId);
      const isFinalCoordinatorDead = !finalCoordinatorId
        || Boolean(ctx.store.require(runId).agents[finalCoordinatorId]?.archivedAt)
        || Boolean(liveStatuses.get(finalCoordinatorId)?.archived);
      // If a completed pipeline's Forked Lead was archived before merging, hand its slp_finalize_pipeline duty to Master Lead.
      if (isFinalCoordinatorDead) {
        ctx.store.mutate(runId, (mutableRun) => {
          const mutablePipeline = requirePipeline(mutableRun, pipelineId);
          if (mutablePipeline.status !== "completed" || mutablePipeline.gate) return;
          if (finalCoordinatorId && mutableRun.agents[finalCoordinatorId]) {
            mutableRun.agents[finalCoordinatorId].archivedAt ??= new Date().toISOString();
          }
          mutableRun.mailbox = mutableRun.mailbox.filter(
            (queuedMessage) => !(queuedMessage.toAgentId === finalCoordinatorId && queuedMessage.awaitTool === "slp_finalize_pipeline"),
          );
          const masterLeadId = mutableRun.masterLeadAgentId;
          const masterLeadRecord = mutableRun.agents[masterLeadId];
          const masterLeadAlreadyFinalizing = masterLeadRecord?.awaitingTool === "slp_finalize_pipeline"
            || mutableRun.mailbox.some((queuedMessage) => queuedMessage.toAgentId === masterLeadId && queuedMessage.awaitTool === "slp_finalize_pipeline");
          if (masterLeadId && !masterLeadAlreadyFinalizing) {
            mutableRun.mailbox.push(
              stageMail(masterLeadId, pipelineFinalizationBriefing(mutableRun, mutablePipeline), "slp_finalize_pipeline"),
            );
          }
        });
      }
      return;
    }
    if (["paused", "completed", "integrated", "failed"].includes(pipeline.status)) return;
    // Complete the pre-stage peer_understand phase before opening Stage 1 so stage peers can fork from Base Peer.
    const isPeerUnderstandCompleted = await advancePeerUnderstandPhase(ctx, runId, pipelineId);
    if (!isPeerUnderstandCompleted) return;
    const postUnderstandPipeline = requirePipeline(ctx.store.require(runId), pipelineId);
    if (["paused", "completed", "integrated", "failed"].includes(postUnderstandPipeline.status)) return;
    const stage = postUnderstandPipeline.stages[postUnderstandPipeline.currentStageIndex];
    if (!stage) throw new Error("Pipeline has no current stage.");
    if (stage.status === "running") {
      const live = await ctx.gateway.liveStatuses(runId);
      const current = currentAssignment(ctx, runId, pipelineId);
      const participants = [...current.stage.peerAgentIds, current.stage.forkedLeadAgentId].filter((agentId): agentId is string => Boolean(agentId));
      // Restart recovery may find a vanished SDK session; repair its roster within this stage rather than inventing a phase.
      if (current.stage.status === "running" && participants.some((agentId) => !live.has(agentId) || live.get(agentId)?.archived)) {
        ctx.store.mutate(runId, (mutableRun) => {
          const currentPipeline = requirePipeline(mutableRun, pipelineId);
          currentPipeline.stages[currentPipeline.currentStageIndex].status = "starting";
        });
      }
    }
    const current = currentAssignment(ctx, runId, pipelineId);
    if (current.pipeline.status === "paused") return;
    if (current.stage.status === "completing") await finishStage(ctx, runId, pipelineId);
    const refreshedPipeline = requirePipeline(ctx.store.require(runId), pipelineId);
    const nextStage = refreshedPipeline.stages[refreshedPipeline.currentStageIndex];
    if (nextStage && ["pending", "starting"].includes(nextStage.status) && !["paused", "completed", "integrated"].includes(refreshedPipeline.status)) {
      await startStage(ctx, runId, pipelineId);
    }
  } catch (stageError) {
    // Keep partially created identities and completion decisions so a resume retries the exact unfinished boundary.
    const reason = stageError instanceof Error ? stageError.message : String(stageError);
    const currentRun = ctx.store.require(runId);
    if (currentRun.status === "running" && requirePipeline(currentRun, pipelineId).status !== "paused") {
      pausePipeline(ctx, runId, pipelineId, reason);
    }
  } finally {
    advancingPipelines.delete(operationKey);
  }
}

async function startStage(ctx: PipelineContext, runId: string, pipelineId: string): Promise<void> {
  const { run, pipeline, stage } = currentAssignment(ctx, runId, pipelineId);
  if (!pipeline.workspaceId) throw new Error("Pipeline has no registered worktree workspace.");
  // Capture pre-reconciliation roster state so mid-stage revival only briefs newly spawned replacements.
  const wasStageAlreadyStarted = Boolean(stage.startedAt);
  const previousCoordinatorId = stage.forkedLeadAgentId;
  const previousPeerAgentIds = [...stage.peerAgentIds];
  ctx.store.mutate(runId, (mutableRun) => {
    const currentPipeline = mutableRun.pipelines[pipelineId];
    currentPipeline.status = "starting";
    currentPipeline.stages[currentPipeline.currentStageIndex].status = "starting";
  });
  await reconcileStageAgents(ctx, runId, pipeline, stage);
  let coordinatorCreated = false;
  const createdPeerIndices = new Set<number>();
  if (!currentAssignment(ctx, runId, pipelineId).stage.forkedLeadAgentId) {
    const extraOptions = await forkLeadSessionOptions(ctx, runId);
    const current = currentAssignment(ctx, runId, pipelineId);
    const coordinator = await ctx.gateway.createAgent({
      runId, role: "forked_lead", taskId: null, pipelineId, stageId: stage.id,
      provider: run.providers.lead, thinkingOptionId: run.providers.leadThinkingOptionId ?? undefined,
      permissionModeId: run.providers.leadPermissionModeId ?? undefined,
      // Claude session forks resolve from the source cwd; peers themselves live in the handed-over worktree.
      workspaceId: run.devWorkspaceId, parentAgentId: run.masterLeadAgentId,
      title: `[Lead] [${pipeline.name} · ${stage.name}]`, awaitTool: null,
      stageContext: stagePromptContext(current.pipeline, current.stage, "Coordinate this stage and approve only when its goal is met."),
      extraOptions,
    });
    await keepCreatedAgent(ctx, runId, pipelineId, stage.id, coordinator.agentId);
    ctx.store.mutate(runId, (mutableRun) => {
      const mutablePipeline = mutableRun.pipelines[pipelineId];
      mutablePipeline.stages[mutablePipeline.currentStageIndex].forkedLeadAgentId = coordinator.agentId;
    });
    coordinatorCreated = true;
  }
  for (const [peerIndex, assignment] of stage.peers.entries()) {
    const current = currentAssignment(ctx, runId, pipelineId);
    if (current.stage.peerAgentIds[peerIndex]) continue;
    const definition = peerRole(run.promptConfig, assignment.role);
    // Fork every stage peer from the pipeline's Base Peer session so it inherits the peer_understand context.
    const peerForkExtraOptions = await forkBasePeerSessionOptions(ctx, runId, pipelineId, definition.role);
    const refreshedCurrent = currentAssignment(ctx, runId, pipelineId);
    const createdPeer = await ctx.gateway.createAgent({
      runId, role: "peer", projectRole: definition.role, taskId: null, pipelineId, stageId: stage.id, stagePeerId: String(peerIndex),
      provider: run.providers.peer, thinkingOptionId: run.providers.peerThinkingOptionId ?? undefined,
      permissionModeId: run.providers.peerPermissionModeId ?? undefined,
      workspaceId: pipeline.workspaceId, parentAgentId: refreshedCurrent.stage.forkedLeadAgentId ?? undefined,
      peerWorktreePath: pipeline.worktree, writeScope: ["**"],
      title: `[${definition.name}] [${pipeline.name} · ${stage.name}]`, awaitTool: null,
      stageContext: stagePromptContext(refreshedCurrent.pipeline, refreshedCurrent.stage, assignment.task),
      extraOptions: peerForkExtraOptions,
    });
    await keepCreatedAgent(ctx, runId, pipelineId, stage.id, createdPeer.agentId);
    // Persist each identity before creating the next so recovery never allocates the whole cohort again.
    ctx.store.mutate(runId, (mutableRun) => {
      const mutablePipeline = mutableRun.pipelines[pipelineId];
      mutablePipeline.stages[mutablePipeline.currentStageIndex].peerAgentIds[peerIndex] = createdPeer.agentId;
    });
    createdPeerIndices.add(peerIndex);
  }
  activateStage(ctx, runId, pipelineId, {
    wasStageAlreadyStarted,
    coordinatorCreated,
    createdPeerIndices,
    previousCoordinatorId,
    previousPeerAgentIds,
  });
}

async function reconcileStageAgents(ctx: PipelineContext, runId: string, pipeline: PipelineState, stage: StageState): Promise<void> {
  const live = await ctx.gateway.liveStatuses(runId);
  const current = currentAssignment(ctx, runId, pipeline.id);
  if (current.stage.id !== stage.id) throw new Error("Stage assignment changed during recovery.");
  ctx.store.mutate(runId, (run) => {
    const currentPipeline = requirePipeline(run, pipeline.id);
    const currentStage = currentPipeline.stages[currentPipeline.currentStageIndex];
    // Clear any roster slot whose persisted agent record was already archived before this reconciliation pass.
    if (currentStage.forkedLeadAgentId && (!run.agents[currentStage.forkedLeadAgentId] || run.agents[currentStage.forkedLeadAgentId].archivedAt)) {
      currentStage.forkedLeadAgentId = null;
    }
    currentStage.peerAgentIds = currentStage.peerAgentIds.map((peerAgentId) =>
      peerAgentId && run.agents[peerAgentId] && !run.agents[peerAgentId].archivedAt ? peerAgentId : "",
    );
    // A crash between SDK creation and roster persistence may leave a valid identity outside the roster.
    const participants = Object.values(run.agents).filter((agent) => agent.pipelineId === pipeline.id && agent.stageId === stage.id && !agent.archivedAt);
    for (const agent of participants) {
      // An incomplete directory read is uncertainty, not proof that the SDK session was archived.
      if (!live.has(agent.agentId)) throw new Error(`Cannot confirm stage participant '${agent.agentId}'; retry recovery after the directory is available.`);
      if (live.get(agent.agentId)?.archived) {
        agent.archivedAt = new Date().toISOString();
        if (currentStage.forkedLeadAgentId === agent.agentId) currentStage.forkedLeadAgentId = null;
        const peerIndex = currentStage.peerAgentIds.indexOf(agent.agentId);
        if (peerIndex >= 0) currentStage.peerAgentIds[peerIndex] = "";
        continue;
      }
      if (agent.role === "forked_lead") currentStage.forkedLeadAgentId = agent.agentId;
      if (agent.role === "peer" && agent.stagePeerId !== null) currentStage.peerAgentIds[Number(agent.stagePeerId)] = agent.agentId;
    }
    if (!currentStage.forkedLeadAgentId) {
      // Reuse the pipeline's existing Forked Lead across stages so one Forked Lead owns its assigned task from start to merge.
      const existingPipelineCoordinator = Object.values(run.agents).find(
        (agent) => agent.pipelineId === pipeline.id && agent.role === "forked_lead" && !agent.archivedAt,
      );
      if (existingPipelineCoordinator) {
        if (!live.has(existingPipelineCoordinator.agentId)) {
          throw new Error(`Cannot confirm stage participant '${existingPipelineCoordinator.agentId}'; retry recovery after the directory is available.`);
        }
        if (live.get(existingPipelineCoordinator.agentId)?.archived) {
          existingPipelineCoordinator.archivedAt = new Date().toISOString();
        } else {
          existingPipelineCoordinator.stageId = currentStage.id;
          currentStage.forkedLeadAgentId = existingPipelineCoordinator.agentId;
        }
      }
    }
    // Sparse arrays are transient during recovery and must not reach a persisted Zod array.
    currentStage.peerAgentIds = currentStage.peers.map((_, peerIndex) => currentStage.peerAgentIds[peerIndex] ?? "");
  });
}

function activateStage(ctx: PipelineContext, runId: string, pipelineId: string, activationChanges: StageActivationChanges): void {
  const { run, pipeline, stage } = currentAssignment(ctx, runId, pipelineId);
  // Activation follows asynchronous SDK requests; an intervening abort or pause must never reopen the cohort.
  if (pipeline.status !== "starting" || stage.status !== "starting") throw new Error("Stage startup is no longer active.");
  if (!stage.forkedLeadAgentId) throw new Error("Stage coordinator is missing.");
  if (stage.peerAgentIds.length !== stage.peers.length || stage.peerAgentIds.some((agentId) => !agentId)) {
    throw new Error("Stage peer roster is incomplete.");
  }
  const createdAt = new Date().toISOString();
  const promptMessage = (toAgentId: string, text: string, awaitTool: string | null): MailboxMessage => ({
    id: randomUUID(), toAgentId, text, taskId: null, awaitTool, isReminder: false, createdAt,
  });
  // Map dead identities to their newly spawned replacements so pending waits and stale mail can be reconciled.
  const replacementByDeadAgentId = new Map<string, string>();
  if (activationChanges.previousCoordinatorId && activationChanges.previousCoordinatorId !== stage.forkedLeadAgentId) {
    replacementByDeadAgentId.set(activationChanges.previousCoordinatorId, stage.forkedLeadAgentId);
  }
  for (const peerIndex of activationChanges.createdPeerIndices) {
    const previousPeerAgentId = activationChanges.previousPeerAgentIds[peerIndex];
    if (previousPeerAgentId && previousPeerAgentId !== stage.peerAgentIds[peerIndex]) {
      replacementByDeadAgentId.set(previousPeerAgentId, stage.peerAgentIds[peerIndex]);
    }
  }
  const messages: MailboxMessage[] = [];
  if (!activationChanges.wasStageAlreadyStarted) {
    // Keep the Forked Lead idle until peers submit stage reports or send a direct question, saving an empty startup turn.
    messages.push(
      ...stage.peerAgentIds.map((agentId, peerIndex) =>
        promptMessage(agentId, peerStageBriefing(run, pipeline, stage, peerIndex), "slp_stage_report"),
      ),
    );
  } else {
    // Mid-stage revival only briefs newly respawned agents so healthy peers are not forced to restart their work.
    if (activationChanges.coordinatorCreated && stage.reports.length > 0) {
      messages.push(promptMessage(stage.forkedLeadAgentId, coordinatorRevivalBriefing(run, pipeline, stage), "slp_approve_stage"));
    } else if (!activationChanges.coordinatorCreated && activationChanges.createdPeerIndices.size > 0) {
      messages.push(promptMessage(stage.forkedLeadAgentId, peerRosterUpdateNotice(stage, activationChanges.createdPeerIndices), null));
    }
    for (const peerIndex of activationChanges.createdPeerIndices) {
      const replacementPeerId = stage.peerAgentIds[peerIndex];
      messages.push(promptMessage(replacementPeerId, peerStageBriefing(run, pipeline, stage, peerIndex), "slp_stage_report"));
    }
  }
  ctx.store.mutate(runId, (mutableRun) => {
    const currentPipeline = mutableRun.pipelines[pipelineId];
    const currentStage = currentPipeline.stages[currentPipeline.currentStageIndex];
    if (replacementByDeadAgentId.size > 0) {
      // Drop unread mail addressed to dead stage sessions because their replacements receive a full stage briefing.
      mutableRun.mailbox = mutableRun.mailbox.filter((queuedMessage) => !replacementByDeadAgentId.has(queuedMessage.toAgentId));
      for (const participantRecord of Object.values(mutableRun.agents)) {
        if (participantRecord.waitingForAgentId && replacementByDeadAgentId.has(participantRecord.waitingForAgentId)) {
          participantRecord.waitingForAgentId = replacementByDeadAgentId.get(participantRecord.waitingForAgentId) ?? null;
        }
        // Re-parent surviving children when their stage coordinator was replaced during revival.
        if (participantRecord.parentAgentId && replacementByDeadAgentId.has(participantRecord.parentAgentId)) {
          participantRecord.parentAgentId = replacementByDeadAgentId.get(participantRecord.parentAgentId) ?? participantRecord.parentAgentId;
        }
      }
    }
    // Ensure every active peer in the current stage is linked to the active stage Forked Lead coordinator.
    for (const stagePeerAgentId of currentStage.peerAgentIds) {
      const stagePeerRecord = mutableRun.agents[stagePeerAgentId];
      if (stagePeerRecord && currentStage.forkedLeadAgentId) {
        stagePeerRecord.parentAgentId = currentStage.forkedLeadAgentId;
      }
    }
    // All roster entries and initial assignments become visible together before any agent can send a message.
    currentPipeline.status = "running";
    currentPipeline.updatedAt = createdAt;
    currentStage.status = "running";
    currentStage.startedAt ??= createdAt;
    mutableRun.mailbox.push(...messages);
  });
  if (!activationChanges.wasStageAlreadyStarted) {
    ctx.logEvent(runId, { taskId: null, from: "pipeline", to: stage.forkedLeadAgentId, kind: "stage.started", summary: `${pipeline.name}/${stage.name}: ${stage.peers.length} peers`, outcome: "queued" });
  } else if (activationChanges.coordinatorCreated || activationChanges.createdPeerIndices.size > 0) {
    const revivedCount = (activationChanges.coordinatorCreated ? 1 : 0) + activationChanges.createdPeerIndices.size;
    ctx.logEvent(runId, { taskId: null, from: "pipeline", to: stage.forkedLeadAgentId, kind: "agent.revived", summary: `${pipeline.name}/${stage.name}: revived ${revivedCount} stage participant(s)`, outcome: "queued" });
  }
}

async function finishStage(ctx: PipelineContext, runId: string, pipelineId: string): Promise<void> {
  const run = ctx.store.require(runId);
  const pipeline = requirePipeline(run, pipelineId);
  const stage = pipeline.stages[pipeline.currentStageIndex];
  if (!stage.result) throw new Error("Stage cannot complete without its Forked Lead approval.");
  const stageAgents = Object.values(run.agents).filter((agent) => agent.pipelineId === pipelineId && agent.stageId === stage.id);
  for (const coordinator of stageAgents.filter((agent) => agent.role === "forked_lead" && !agent.archivedAt)) {
    // Approval tools return before this asynchronous boundary, allowing the coordinator's last turn to finish.
    await ctx.gateway.waitForIdle(coordinator.agentId, 60_000);
  }
  // Keep stage peers and Forked Leads alive even after the final stage completes so the Forked Lead can merge the branch
  // via slp_finalize_pipeline and consult peers or sibling Forked Leads if merge conflicts arise.
  const latestRun = ctx.store.require(runId);
  const latestPipeline = requirePipeline(latestRun, pipelineId);
  const latestStage = latestPipeline.stages[latestPipeline.currentStageIndex];
  // Archival can overlap a pause or abort; preserve that decision instead of advancing whichever stage is now current.
  if (latestRun.status !== "running" || latestPipeline.status !== "running" || latestStage?.id !== stage.id || latestStage.status !== "completing") return;
  ctx.store.mutate(runId, (mutableRun) => {
    const currentPipeline = mutableRun.pipelines[pipelineId];
    const currentStage = currentPipeline.stages[currentPipeline.currentStageIndex];
    currentStage.status = "completed";
    currentStage.completedAt = new Date().toISOString();
    currentPipeline.currentStageIndex += 1;
    currentPipeline.updatedAt = currentStage.completedAt;
    // Clear workflow obligations on all agents in this pipeline before opening the next stage or finalization step.
    for (const pipelineAgent of Object.values(mutableRun.agents)) {
      if (pipelineAgent.pipelineId !== pipelineId) continue;
      pipelineAgent.awaitingTool = null;
      pipelineAgent.awaitingSince = null;
      pipelineAgent.nudges = 0;
      pipelineAgent.waitingForAgentId = null;
      pipelineAgent.deferredTool = null;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (message) => mutableRun.agents[message.toAgentId]?.pipelineId !== pipelineId,
    );
    const complete = currentPipeline.currentStageIndex === currentPipeline.stages.length;
    currentPipeline.status = complete ? "completed" : "queued";
    if (complete) currentPipeline.finalReport = currentPipeline.stages.map((completedStage) => `${completedStage.name}: ${completedStage.result?.summary}`).join("\n\n");
    const gateKind = complete && mutableRun.mode !== "FULL_AUTO" ? "before_integration"
      : !complete && mutableRun.mode === "STEP_BY_STEP_DEBUG" ? "after_stage" : null;
    if (gateKind) {
      // Optional human modes pause between model-authored stages without adding or changing those stages.
      const note = gateKind === "before_integration" ? "All stages approved. Approve integration into the Lead branch."
        : `Stage '${currentStage.name}' approved by Forked Lead. Approve the next declared stage.`;
      currentPipeline.gate = { kind: gateKind, stageId: currentStage.id, openedAt: currentStage.completedAt, note };
      if (!complete) currentPipeline.status = "paused";
      currentPipeline.pausedReason = note;
    }
    // Closure and the next owner's notification share one commit so reload cannot lose the handover.
    if (currentPipeline.gate) {
      mutableRun.mailbox.push(stageMail(mutableRun.supervisorAgentId,
        `Pipeline '${currentPipeline.name}' is waiting for the human gate selected by run mode ${mutableRun.mode}: ${currentPipeline.gate.note}\nTell the human to open SLP Orchestrator and approve the pipeline gate.`, null));
    } else if (currentPipeline.status === "completed") {
      // Assign pipeline branch integration and conflict resolution directly to the final stage's Forked Lead.
      const finalizingAgentId = currentStage.forkedLeadAgentId && !mutableRun.agents[currentStage.forkedLeadAgentId]?.archivedAt
        ? currentStage.forkedLeadAgentId
        : mutableRun.masterLeadAgentId;
      mutableRun.mailbox.push(
        stageMail(finalizingAgentId, pipelineFinalizationBriefing(mutableRun, currentPipeline), "slp_finalize_pipeline"),
      );
    }
  });
}
