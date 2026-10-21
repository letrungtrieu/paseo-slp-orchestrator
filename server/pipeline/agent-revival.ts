// Detects and respawns dead, archived or wedged Lead and Peer sessions
// while preserving healthy sibling peers and re-queueing the exact pending workflow obligation.
import { ROLE_LABELS } from "../../shared/roles";
import type { AgentRecord, Run } from "../../shared/state";
import type { BusCaller } from "../bus/http-mcp";
import { delegationMessage } from "../prompts/messages";
import type { AgentLiveStatus } from "../runtime/agent-gateway";
import type { PipelineContext } from "./context";
import { requirePipeline } from "./stage-context";
import { recoverPipelines } from "./stage-engine";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";

export interface ReviveAgentInput {
  target: "auto" | "master_lead" | "stage_cohort" | "agent";
  agentId?: string;
  pipelineId?: string;
  reason?: string;
}

interface MasterLeadRecoveryObligation {
  awaitTool: string;
  briefingText: string;
}

// Prevent overlapping sweeper ticks and manual tool calls from allocating two replacement Master Leads at once.
const revivingMasterLeadRuns = new Set<string>();

// Only these workflow tools represent a durable Master Lead turn obligation that must be restored on revival.
export const MASTER_LEAD_OWED_TOOLS: ReadonlySet<string> = new Set([
  "slp_define_pipeline",
  "slp_resume_pipeline",
  "slp_finalize_pipeline",
  "slp_report",
]);

// Verify that a Master Lead's stamped tool obligation still matches the live run and pipeline state.
export function isMasterLeadObligationActive(run: Run, awaitedTool: string | null): boolean {
  if (!awaitedTool || !MASTER_LEAD_OWED_TOOLS.has(awaitedTool)) return false;
  if (awaitedTool === "slp_define_pipeline") {
    // Once at least one pipeline is defined and the run enters 'running', defining extra pipelines is optional.
    return run.status === "planning";
  }
  if (run.status !== "running") return false;
  const runPipelines = Object.values(run.pipelines);
  if (awaitedTool === "slp_resume_pipeline") {
    return runPipelines.some((pipeline) => pipeline.status === "paused" && !pipeline.gate);
  }
  if (awaitedTool === "slp_finalize_pipeline") {
    return runPipelines.some((pipeline) => pipeline.status === "completed" && !pipeline.gate);
  }
  if (awaitedTool === "slp_report") {
    return runPipelines.length > 0 && runPipelines.every((pipeline) => pipeline.status === "integrated");
  }
  return false;
}

function inferMasterLeadObligation(
  run: Run,
  previousAwaitingTool: string | null,
): MasterLeadRecoveryObligation | null {
  // During planning, the Master Lead owes a pipeline definition for either the initial criteria or a rework pass.
  if (run.status === "planning" && run.criteria) {
    const integratedPipelineNames = Object.values(run.pipelines)
      .filter((pipeline) => pipeline.status === "integrated")
      .map((pipeline) => pipeline.name);
    const reworkContextNote = integratedPipelineNames.length > 0
      ? `\nPreviously integrated pipelines (${integratedPipelineNames.join(", ")}) remain immutable; inspect slp_get_run and define a fresh pipeline.`
      : "";
    return {
      awaitTool: "slp_define_pipeline",
      briefingText: `${delegationMessage(run.criteria)}${reworkContextNote}\nYour previous Master Lead session ended before defining the pipeline. Call slp_define_pipeline now.`,
    };
  }
  if (run.status === "running") {
    const runPipelines = Object.values(run.pipelines);
    // Paused pipelines without a human gate depend on the Master Lead's recovery guidance to continue.
    const pausedPipeline = runPipelines.find((pipeline) => pipeline.status === "paused" && !pipeline.gate);
    if (pausedPipeline) {
      return {
        awaitTool: "slp_resume_pipeline",
        briefingText: `Your Master Lead session was revived. Pipeline '${pausedPipeline.name}' (${pausedPipeline.id}) is paused: ${pausedPipeline.pausedReason ?? "awaiting Lead decision"}.\nInspect slp_get_pipeline and call slp_resume_pipeline with your recovery decision.`,
      };
    }
    // Completed pipelines without a human gate require branch verification and integration by the Master Lead.
    const completedPipeline = runPipelines.find((pipeline) => pipeline.status === "completed" && !pipeline.gate);
    if (completedPipeline) {
      return {
        awaitTool: "slp_finalize_pipeline",
        briefingText: `Your Master Lead session was revived. Pipeline '${completedPipeline.name}' (${completedPipeline.id}) completed all stages in ${completedPipeline.worktree}.\nInspect slp_get_pipeline, verify its branch, then call slp_finalize_pipeline.`,
      };
    }
    // Once every declared pipeline is integrated, the Master Lead owes the final integration report to the Supervisor.
    if (runPipelines.length > 0 && runPipelines.every((pipeline) => pipeline.status === "integrated")) {
      return {
        awaitTool: "slp_report",
        briefingText: "Your Master Lead session was revived after all pipelines were integrated. Inspect slp_list_pipelines and call slp_report to hand the result to the Supervisor.",
      };
    }
  }
  // Preserve any explicit valid tool obligation only when it still matches the current run state.
  if (isMasterLeadObligationActive(run, previousAwaitingTool)) {
    return {
      awaitTool: previousAwaitingTool!,
      briefingText: `Your Master Lead session was revived while owing ${previousAwaitingTool}. Inspect slp_get_run and slp_list_pipelines, then call ${previousAwaitingTool}.`,
    };
  }
  return null;
}

export async function reviveMasterLead(
  ctx: PipelineContext,
  runId: string,
  revivalReason: string,
  liveStatuses?: Map<string, AgentLiveStatus>,
): Promise<AgentRecord | null> {
  if (revivingMasterLeadRuns.has(runId)) return null;
  revivingMasterLeadRuns.add(runId);
  try {
    const initialRun = ctx.store.require(runId);
    if (
      initialRun.engineVersion !== "dynamic-stages-v1"
      || !["delegating", "planning", "running", "reporting"].includes(initialRun.status)
    ) {
      return null;
    }
    const previousMasterLeadId = initialRun.masterLeadAgentId;
    const previousMasterLeadRecord = initialRun.agents[previousMasterLeadId];
    const previousAwaitingTool = previousMasterLeadRecord?.awaitingTool ?? null;
    const targetWorkspaceId = previousMasterLeadRecord?.workspaceId ?? initialRun.devWorkspaceId;
    const targetWorktreePath = previousMasterLeadRecord?.worktreePath ?? undefined;
    const replacementMasterLead = await ctx.gateway.createAgent({
      runId,
      role: "master_lead",
      taskId: null,
      pipelineId: previousMasterLeadRecord?.pipelineId ?? undefined,
      stageId: previousMasterLeadRecord?.stageId ?? undefined,
      provider: initialRun.providers.lead,
      thinkingOptionId: initialRun.providers.leadThinkingOptionId ?? undefined,
      permissionModeId: initialRun.providers.leadPermissionModeId ?? undefined,
      parentAgentId: initialRun.supervisorAgentId || undefined,
      workspaceId: targetWorkspaceId,
      peerWorktreePath: targetWorktreePath,
      title: `[${ROLE_LABELS.master_lead}] [${previousMasterLeadRecord?.featureName ?? initialRun.title}]`,
      awaitTool: null,
    });
    const postCreateRun = ctx.store.require(runId);
    // Close the newly created session immediately if the run finished while the SDK request was in flight.
    if (["completed", "aborted"].includes(postCreateRun.status)) {
      await ctx.gateway.archive(replacementMasterLead.agentId).catch(() => undefined);
      return null;
    }
    const revivedAt = new Date().toISOString();
    ctx.store.mutate(runId, (mutableRun) => {
      const deadLeadRecord = mutableRun.agents[previousMasterLeadId];
      if (deadLeadRecord) {
        deadLeadRecord.archivedAt ??= revivedAt;
        deadLeadRecord.awaitingTool = null;
        deadLeadRecord.awaitingSince = null;
        deadLeadRecord.waitingForAgentId = null;
        deadLeadRecord.deferredTool = null;
      }
      const replacementRecord = mutableRun.agents[replacementMasterLead.agentId];
      if (replacementRecord && deadLeadRecord) {
        replacementRecord.workspaceId = deadLeadRecord.workspaceId;
        replacementRecord.worktreePath = deadLeadRecord.worktreePath;
        replacementRecord.featureName = deadLeadRecord.featureName;
        replacementRecord.featureCriteria = deadLeadRecord.featureCriteria;
      }
      mutableRun.masterLeadAgentId = replacementMasterLead.agentId;
      for (const mutablePipeline of Object.values(mutableRun.pipelines)) {
        if (mutablePipeline.leadAgentId === previousMasterLeadId) {
          mutablePipeline.leadAgentId = replacementMasterLead.agentId;
        }
        const activeStage = mutablePipeline.stages[mutablePipeline.currentStageIndex];
        if (activeStage?.forkedLeadAgentId === previousMasterLeadId) {
          activeStage.forkedLeadAgentId = replacementMasterLead.agentId;
        }
      }
      // Re-parent active child agents to the replacement Lead before retiring the old session.
      for (const childRecord of Object.values(mutableRun.agents)) {
        if (childRecord.parentAgentId === previousMasterLeadId) {
          childRecord.parentAgentId = replacementMasterLead.agentId;
        }
      }
      // Transfer unread mail from the dead Lead identity so pending escalations or delegations are not lost.
      for (const queuedMessage of mutableRun.mailbox) {
        if (queuedMessage.toAgentId === previousMasterLeadId) {
          queuedMessage.toAgentId = replacementMasterLead.agentId;
        }
      }
      const hasTransferredMail = mutableRun.mailbox.some(
        (queuedMessage) => queuedMessage.toAgentId === replacementMasterLead.agentId,
      );
      if (!hasTransferredMail) {
        const inferredObligation = inferMasterLeadObligation(mutableRun, previousAwaitingTool);
        if (inferredObligation) {
          mutableRun.mailbox.push(
            stageMail(replacementMasterLead.agentId, inferredObligation.briefingText, inferredObligation.awaitTool),
          );
        }
      }
    });
    // Archive the old session after re-parenting children so an agent.archived callback sees zero remaining children on it.
    if (
      previousMasterLeadId
      && previousMasterLeadRecord
      && !previousMasterLeadRecord.archivedAt
      && !liveStatuses?.get(previousMasterLeadId)?.archived
    ) {
      await ctx.gateway.archive(previousMasterLeadId).catch(() => undefined);
    }
    // Register the replacement as idle in the current sweep map so Mailbox.flush delivers its briefing on the same tick.
    liveStatuses?.set(replacementMasterLead.agentId, {
      agentId: replacementMasterLead.agentId,
      status: "idle",
      pendingPermissions: [],
      archived: false,
    });
    ctx.logEvent(runId, {
      taskId: null,
      from: "pipeline",
      to: replacementMasterLead.agentId,
      kind: "agent.revived",
      summary: `Master Lead revived (${previousMasterLeadId || "none"} -> ${replacementMasterLead.agentId}): ${revivalReason}`,
      outcome: "delivered",
    });
    return replacementMasterLead;
  } finally {
    revivingMasterLeadRuns.delete(runId);
  }
}

export async function recoverMasterLead(
  ctx: PipelineContext,
  runId: string,
  liveStatuses: Map<string, AgentLiveStatus>,
): Promise<boolean> {
  const currentRun = ctx.store.require(runId);
  if (
    currentRun.engineVersion !== "dynamic-stages-v1"
    || !["delegating", "planning", "running", "reporting"].includes(currentRun.status)
  ) {
    return false;
  }
  const currentMasterLeadId = currentRun.masterLeadAgentId;
  const masterLeadRecord = currentMasterLeadId ? currentRun.agents[currentMasterLeadId] : undefined;
  const masterLeadLiveStatus = currentMasterLeadId ? liveStatuses.get(currentMasterLeadId) : undefined;
  // Respawn automatically when the Master Lead record is missing, marked archived in SQLite, or archived in Paseo.
  const isMasterLeadDead =
    !masterLeadRecord
    || Boolean(masterLeadRecord.archivedAt)
    || Boolean(masterLeadLiveStatus?.archived);
  if (!isMasterLeadDead) return false;
  const hasQueuedMasterLeadMail = Boolean(
    currentMasterLeadId && currentRun.mailbox.some((queuedMessage) => queuedMessage.toAgentId === currentMasterLeadId),
  );
  // Do not auto-spawn a Master Lead before initial delegation or after it was retired with no remaining obligation.
  const hasInferredMasterLeadObligation =
    isMasterLeadObligationActive(currentRun, masterLeadRecord?.awaitingTool ?? null) ||
    inferMasterLeadObligation(currentRun, masterLeadRecord?.awaitingTool ?? null) !== null;
  if (
    !hasQueuedMasterLeadMail
    && !hasInferredMasterLeadObligation
    && (currentRun.status === "delegating" || Boolean(masterLeadRecord))
  ) {
    return false;
  }
  const replacementLead = await reviveMasterLead(
    ctx,
    runId,
    "Master Lead session was archived or missing during sweep",
    liveStatuses,
  );
  return replacementLead !== null;
}

export async function markStageParticipantForRevival(
  ctx: PipelineContext,
  runId: string,
  targetAgentId: string,
  liveStatuses?: Map<string, AgentLiveStatus>,
): Promise<string | null> {
  const currentRun = ctx.store.require(runId);
  const participantRecord = currentRun.agents[targetAgentId];
  if (!participantRecord || !participantRecord.pipelineId || !participantRecord.stageId) return null;
  const wasAlreadyArchived = Boolean(participantRecord.archivedAt) || Boolean(liveStatuses?.get(targetAgentId)?.archived);
  const archivedAt = new Date().toISOString();
  let affectedPipelineId: string | null = null;
  ctx.store.mutate(runId, (mutableRun) => {
    const mutableParticipant = mutableRun.agents[targetAgentId];
    if (!mutableParticipant?.pipelineId || !mutableParticipant.stageId) return;
    mutableParticipant.archivedAt ??= archivedAt;
    mutableParticipant.awaitingTool = null;
    mutableParticipant.awaitingSince = null;
    mutableParticipant.waitingForAgentId = null;
    mutableParticipant.deferredTool = null;
    const targetPipeline = mutableRun.pipelines[mutableParticipant.pipelineId];
    if (!targetPipeline) return;
    const currentStage = targetPipeline.stages[targetPipeline.currentStageIndex];
    if (!currentStage || currentStage.id !== mutableParticipant.stageId) return;
    if (currentStage.forkedLeadAgentId === targetAgentId || targetPipeline.leadAgentId === targetAgentId) {
      currentStage.forkedLeadAgentId = null;
      if (targetPipeline.leadAgentId === targetAgentId) {
        targetPipeline.leadAgentId = null;
      }
      // Detach surviving stage peers before archiving a wedged coordinator so they can be re-parented to its replacement.
      for (const peerAgentId of currentStage.peerAgentIds) {
        const peerRecord = mutableRun.agents[peerAgentId];
        if (peerRecord?.parentAgentId === targetAgentId) {
          peerRecord.parentAgentId = null;
        }
      }
    }
    currentStage.peerAgentIds = currentStage.peerAgentIds.map((peerId) => (peerId === targetAgentId ? "" : peerId));
    currentStage.status = "starting";
    // Reopen a pipeline that paused due to agent failure so stage recovery can spawn the replacement cohort member.
    if (targetPipeline.status === "paused" && !targetPipeline.gate) {
      targetPipeline.status = "starting";
      targetPipeline.pausedReason = null;
    }
    affectedPipelineId = targetPipeline.id;
  });
  // Archive in Paseo after detaching stage children unless the directory poll already confirmed the session is archived.
  if (!wasAlreadyArchived) {
    await ctx.gateway.archive(targetAgentId).catch(() => undefined);
  }
  if (liveStatuses?.has(targetAgentId)) {
    const existingStatus = liveStatuses.get(targetAgentId)!;
    liveStatuses.set(targetAgentId, { ...existingStatus, archived: true });
  }
  return affectedPipelineId;
}

function selectStageTargetsForCohortRevival(
  run: Run,
  pipelineId: string,
  liveStatuses: Map<string, AgentLiveStatus>,
): string[] {
  const targetPipeline = requirePipeline(run, pipelineId);
  const currentStage = targetPipeline.stages[targetPipeline.currentStageIndex];
  if (!currentStage) throw new ToolError(`Pipeline '${targetPipeline.name}' has no active stage to revive.`);
  const stageParticipants = [currentStage.forkedLeadAgentId, ...currentStage.peerAgentIds].filter(
    (agentId): agentId is string => Boolean(agentId),
  );
  // Prefer replacing participants that Paseo reports as archived, missing or in an error state.
  const brokenParticipants = stageParticipants.filter((agentId) => {
    const liveStatus = liveStatuses.get(agentId);
    const persistedRecord = run.agents[agentId];
    return !persistedRecord || Boolean(persistedRecord.archivedAt) || !liveStatus || liveStatus.archived || liveStatus.status === "error";
  });
  if (brokenParticipants.length > 0) return brokenParticipants;
  // When no session is explicitly marked broken, replace participants that still owe their workflow tool.
  const stalledObligationParticipants = stageParticipants.filter((agentId) => Boolean(run.agents[agentId]?.awaitingTool));
  if (stalledObligationParticipants.length > 0) return stalledObligationParticipants;
  // If a stage paused after peers reported, revive the coordinator; otherwise revive peers that have not reported yet.
  const reportedPeerIds = new Set(currentStage.reports.map((report) => report.agentId));
  const unreportedPeers = currentStage.peerAgentIds.filter((peerId) => peerId && !reportedPeerIds.has(peerId));
  if (unreportedPeers.length > 0) return unreportedPeers;
  return currentStage.forkedLeadAgentId ? [currentStage.forkedLeadAgentId] : stageParticipants;
}

export async function reviveAgentsOnDemand(
  ctx: PipelineContext,
  caller: BusCaller,
  input: ReviveAgentInput,
): Promise<string> {
  const initialRun = ctx.store.require(caller.runId);
  const liveStatuses = await ctx.gateway.liveStatuses(caller.runId);
  const revivalSummaries: string[] = [];
  const manualReason = input.reason ?? `manual revival requested by ${caller.role}`;
  const explicitTargetRecord = input.agentId ? initialRun.agents[input.agentId] : undefined;
  const isStageCoordinatorTarget =
    input.target === "agent" &&
    Boolean(explicitTargetRecord?.pipelineId && explicitTargetRecord?.stageId);

  if (
    input.target === "master_lead" ||
    (input.target === "agent" && input.agentId === initialRun.masterLeadAgentId && !isStageCoordinatorTarget)
  ) {
    if (caller.agentId === initialRun.masterLeadAgentId) {
      throw new ToolError("Master Lead cannot revive itself while executing a tool call; use target 'stage_cohort' or 'agent' for stage participants.");
    }
    const replacementLead = await reviveMasterLead(ctx, caller.runId, manualReason, liveStatuses);
    if (!replacementLead) throw new ToolError("Master Lead could not be revived in the current run state.");
    await ctx.mailbox.flush(caller.runId, await ctx.gateway.liveStatuses(caller.runId));
    return `Revived Master Lead: ${initialRun.masterLeadAgentId} -> ${replacementLead.agentId}. Queued its pending workflow obligation.`;
  }

  if (input.target === "agent") {
    if (!input.agentId) throw new ToolError("Specify agentId when target is 'agent'.");
    const targetRecord = initialRun.agents[input.agentId];
    if (!targetRecord || targetRecord.role === "supervisor") {
      throw new ToolError(`Agent '${input.agentId}' is not a revivable Master Lead or stage participant of this run.`);
    }
    const affectedPipelineId = await markStageParticipantForRevival(ctx, caller.runId, input.agentId, liveStatuses);
    if (!affectedPipelineId) throw new ToolError(`Agent '${input.agentId}' does not belong to an active pipeline stage.`);
    await recoverPipelines(ctx, caller.runId);
    await ctx.mailbox.flush(caller.runId, await ctx.gateway.liveStatuses(caller.runId));
    const updatedStage = requirePipeline(ctx.store.require(caller.runId), affectedPipelineId).stages.at(
      requirePipeline(ctx.store.require(caller.runId), affectedPipelineId).currentStageIndex,
    );
    return `Revived stage ${targetRecord.projectRole ?? targetRecord.role} (${input.agentId}) in stage '${updatedStage?.name ?? affectedPipelineId}'.`;
  }

  if (input.target === "stage_cohort") {
    const candidatePipelines = Object.values(initialRun.pipelines).filter((pipeline) => pipeline.status !== "integrated");
    const targetPipeline = input.pipelineId
      ? requirePipeline(initialRun, input.pipelineId)
      : candidatePipelines.at(-1);
    if (!targetPipeline) throw new ToolError("No active or paused pipeline found to revive.");
    const targetAgentIds = selectStageTargetsForCohortRevival(initialRun, targetPipeline.id, liveStatuses);
    for (const targetAgentId of targetAgentIds) {
      await markStageParticipantForRevival(ctx, caller.runId, targetAgentId, liveStatuses);
      revivalSummaries.push(targetAgentId);
    }
    await recoverPipelines(ctx, caller.runId);
    await ctx.mailbox.flush(caller.runId, await ctx.gateway.liveStatuses(caller.runId));
    return `Revived ${revivalSummaries.length} stage participant(s) (${revivalSummaries.join(", ")}) in pipeline '${targetPipeline.name}'.`;
  }

  // target === "auto": inspect Master Lead first (when called by Supervisor), then inspect every non-integrated pipeline.
  if (caller.role === "supervisor") {
    const masterLeadId = initialRun.masterLeadAgentId;
    const masterLeadLive = liveStatuses.get(masterLeadId);
    const masterLeadRecord = initialRun.agents[masterLeadId];
    const isMasterLeadBroken =
      !masterLeadRecord
      || Boolean(masterLeadRecord.archivedAt)
      || !masterLeadLive
      || masterLeadLive.archived
      || masterLeadLive.status === "error";
    if (isMasterLeadBroken) {
      const replacementLead = await reviveMasterLead(ctx, caller.runId, manualReason, liveStatuses);
      if (replacementLead) revivalSummaries.push(`master_lead:${masterLeadId}->${replacementLead.agentId}`);
    }
  }
  const latestRun = ctx.store.require(caller.runId);
  let touchedPipelines = false;
  for (const pipeline of Object.values(latestRun.pipelines)) {
    if (["completed", "integrated"].includes(pipeline.status) || pipeline.gate) continue;
    const currentStage = pipeline.stages[pipeline.currentStageIndex];
    if (!currentStage) continue;
    const stageParticipants = [currentStage.forkedLeadAgentId, ...currentStage.peerAgentIds].filter(
      (agentId): agentId is string => Boolean(agentId),
    );
    const brokenStageParticipants = stageParticipants.filter((agentId) => {
      const liveStatus = liveStatuses.get(agentId);
      const persistedRecord = latestRun.agents[agentId];
      return !persistedRecord || Boolean(persistedRecord.archivedAt) || !liveStatus || liveStatus.archived || liveStatus.status === "error";
    });
    const targetsToRevive = brokenStageParticipants.length > 0
      ? brokenStageParticipants
      : pipeline.status === "paused"
        ? selectStageTargetsForCohortRevival(latestRun, pipeline.id, liveStatuses)
        : [];
    for (const targetAgentId of targetsToRevive) {
      await markStageParticipantForRevival(ctx, caller.runId, targetAgentId, liveStatuses);
      revivalSummaries.push(`stage:${targetAgentId}`);
      touchedPipelines = true;
    }
  }
  // If auto-detection found no archived/error flag but Supervisor asked to revive during planning/running, revive the active owner.
  if (revivalSummaries.length === 0) {
    const activePipelines = Object.values(latestRun.pipelines).filter((pipeline) => !["completed", "integrated"].includes(pipeline.status));
    if (activePipelines.length > 0) {
      const targetPipeline = activePipelines.at(-1)!;
      const targetAgentIds = selectStageTargetsForCohortRevival(latestRun, targetPipeline.id, liveStatuses);
      for (const targetAgentId of targetAgentIds) {
        await markStageParticipantForRevival(ctx, caller.runId, targetAgentId, liveStatuses);
        revivalSummaries.push(`stage:${targetAgentId}`);
        touchedPipelines = true;
      }
    } else if (caller.role === "supervisor") {
      const replacementLead = await reviveMasterLead(ctx, caller.runId, manualReason, liveStatuses);
      if (replacementLead) revivalSummaries.push(`master_lead:${latestRun.masterLeadAgentId}->${replacementLead.agentId}`);
    }
  }
  if (touchedPipelines) await recoverPipelines(ctx, caller.runId);
  await ctx.mailbox.flush(caller.runId, await ctx.gateway.liveStatuses(caller.runId));
  return revivalSummaries.length > 0
    ? `Revived agent session(s): ${revivalSummaries.join(", ")}.`
    : "All active agents are healthy; flushed pending mailbox messages.";
}
