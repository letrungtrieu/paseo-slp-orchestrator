// Decides whether one agent may reach another and under which collaboration rule. Notifications and
// blocking questions share this gate, so both obey the same cross-Lead / merge / in-stage boundaries.
import type { PeerRouteScope } from "../../../shared/peer-questions";
import type { AgentRecord, Run } from "../../../shared/state";
import type { StageState } from "../../../shared/pipeline";
import { isPipelineLeadRole } from "../../../shared/roles";
import { requirePipeline } from "../stage-context";
import { ToolError } from "../tool-error";

export interface PeerRoute {
  scope: PeerRouteScope;
  pipelineId: string | null;
  // Stages whose message history records the exchange, so slp_get_pipeline shows who talked to whom.
  historyStages: StageState[];
  // Human-readable origin used in the text the recipient reads, e.g. "Lead (id, feature 'auth-api')".
  senderDescription: string;
  // Short name of the rule that admitted the message, e.g. "Cross-Lead" or "Merge/conflict".
  scopeLabel: string;
}

function resolveCrossLeadRoute(run: Run, caller: AgentRecord, recipient: AgentRecord): PeerRoute {
  const callerPipeline = caller.pipelineId ? run.pipelines[caller.pipelineId] : undefined;
  const recipientPipeline = recipient.pipelineId ? run.pipelines[recipient.pipelineId] : undefined;
  // A Lead that has not defined its pipeline yet has no stage; fall back to the latest one so history is never silently dropped.
  const callerStage = callerPipeline
    ? (callerPipeline.stages.find((candidate) => candidate.id === caller.stageId) ?? callerPipeline.stages.at(-1))
    : undefined;
  const recipientStage = recipientPipeline
    ? (recipientPipeline.stages.find((candidate) => candidate.id === recipient.stageId) ?? recipientPipeline.stages.at(-1))
    : undefined;
  const callerFeatureLabel = callerPipeline?.name ?? caller.featureName ?? "parallel-feature";
  const historyStages = [callerStage, recipientStage && recipientStage.id !== callerStage?.id ? recipientStage : undefined]
    .filter((stage): stage is StageState => Boolean(stage));
  return {
    scope: "cross_lead",
    pipelineId: callerPipeline?.id ?? null,
    historyStages,
    senderDescription: `Lead (${caller.agentId}, feature '${callerFeatureLabel}')`,
    scopeLabel: "Cross-Lead",
  };
}

function resolveMergeRoute(run: Run, caller: AgentRecord, recipient: AgentRecord | undefined, recipientId: string): PeerRoute {
  const pipeline = requirePipeline(run, caller.pipelineId as string);
  const finalStage = pipeline.stages.at(-1);
  if (!finalStage) throw new ToolError("Completed pipeline has no stages.");
  const pipelinePeerIds = new Set(pipeline.stages.flatMap((completedStage) => completedStage.peerAgentIds).filter(Boolean));
  const pipelineCoordinatorIds = new Set(
    [pipeline.leadAgentId, ...pipeline.stages.map((completedStage) => completedStage.forkedLeadAgentId)]
      .filter((id): id is string => Boolean(id)),
  );
  const isPipelineParticipant = pipelinePeerIds.has(caller.agentId) || pipelineCoordinatorIds.has(caller.agentId);
  const isRecipientInPipeline = Boolean(
    recipient && !recipient.archivedAt && recipient.pipelineId === pipeline.id
    && (pipelinePeerIds.has(recipientId) || pipelineCoordinatorIds.has(recipientId))
    && recipientId !== caller.agentId,
  );
  if (!isPipelineParticipant || !recipient || !isRecipientInPipeline) {
    throw new ToolError("Select an active peer or Lead of this pipeline, or another pipeline's Lead.");
  }
  const callerStageName = pipeline.stages.find((candidate) => candidate.id === caller.stageId)?.name ?? finalStage.name;
  return {
    scope: "merge",
    pipelineId: pipeline.id,
    historyStages: [finalStage],
    senderDescription: isPipelineLeadRole(caller.role)
      ? `pipeline '${pipeline.name}' Lead (${caller.agentId})`
      : `stage '${callerStageName}' ${caller.projectRole ?? "peer"} (${caller.agentId})`,
    scopeLabel: "Merge/conflict",
  };
}

function resolveStageRoute(run: Run, caller: AgentRecord, recipient: AgentRecord | undefined, recipientId: string): PeerRoute {
  const pipeline = requirePipeline(run, caller.pipelineId as string);
  const currentStage = pipeline.stages[pipeline.currentStageIndex];
  if (run.status !== "running" || pipeline.status !== "running" || !currentStage || currentStage.status !== "running") {
    throw new ToolError("Your stage is no longer running. Read slp_get_pipeline for its current state.");
  }
  const currentStageParticipantIds = new Set(
    [...currentStage.peerAgentIds, currentStage.forkedLeadAgentId, pipeline.leadAgentId].filter((id): id is string => Boolean(id)),
  );
  const priorStagePeerIds = new Set(
    pipeline.stages.slice(0, pipeline.currentStageIndex).flatMap((priorStage) => priorStage.peerAgentIds).filter(Boolean),
  );
  const isCurrentStageCaller = caller.stageId === currentStage.id && currentStageParticipantIds.has(caller.agentId);
  const isPriorStagePeerCaller = caller.role === "peer" && priorStagePeerIds.has(caller.agentId);
  if (!isCurrentStageCaller && !isPriorStagePeerCaller) throw new ToolError("Agent is not a participant of this pipeline.");
  // Current-stage participants may reach their stage and live earlier-stage peers; earlier-stage peers may only answer back to the running stage.
  const allowedRecipientIds = isCurrentStageCaller
    ? new Set([...currentStageParticipantIds, ...priorStagePeerIds])
    : currentStageParticipantIds;
  if (!recipient || recipient.archivedAt || !allowedRecipientIds.has(recipientId) || recipientId === caller.agentId) {
    throw new ToolError("Select another active participant of your current stage or a peer from an earlier stage of this pipeline.");
  }
  const callerStageName = pipeline.stages.find((candidate) => candidate.id === caller.stageId)?.name ?? currentStage.name;
  const isRecipientPriorStagePeer = priorStagePeerIds.has(recipientId);
  const callerRoleLabel = caller.projectRole ?? (isPriorStagePeerCaller ? "peer" : "Lead");
  const senderDescription = isRecipientPriorStagePeer
    ? `stage '${currentStage.name}' ${callerRoleLabel} (${caller.agentId})`
    : isPriorStagePeerCaller
      ? `prior stage '${callerStageName}' ${callerRoleLabel} (${caller.agentId})`
      : `${callerRoleLabel} (${caller.agentId})`;
  return {
    scope: "stage",
    pipelineId: pipeline.id,
    historyStages: [currentStage],
    senderDescription,
    scopeLabel: isRecipientPriorStagePeer || isPriorStagePeerCaller ? "Cross-stage" : "Direct stage",
  };
}

// Mirrors the three collaboration windows of the pipeline: planning/running Lead alignment, merge-conflict
// consultation after a pipeline completes, and day-to-day traffic inside a running stage.
export function resolvePeerRoute(run: Run, caller: AgentRecord, recipientId: string): PeerRoute {
  if (caller.archivedAt) throw new ToolError("This tool requires an active agent session.");
  const recipient = run.agents[recipientId];
  // Sibling Leads align shared APIs and flows across features, so this window ignores stage pointers entirely.
  if (
    ["planning", "running"].includes(run.status)
    && isPipelineLeadRole(caller.role)
    && recipient
    && !recipient.archivedAt
    && isPipelineLeadRole(recipient.role)
    && recipientId !== caller.agentId
  ) {
    return resolveCrossLeadRoute(run, caller, recipient);
  }
  if (!caller.pipelineId || !caller.stageId) throw new ToolError("This tool requires an active stage assignment.");
  const pipeline = requirePipeline(run, caller.pipelineId);
  // A completed pipeline's Lead and peers stay reachable so merge conflicts can be explained before slp_finalize_pipeline.
  if (run.status === "running" && pipeline.status === "completed") return resolveMergeRoute(run, caller, recipient, recipientId);
  return resolveStageRoute(run, caller, recipient, recipientId);
}

// Appends the exchange to every history stage so it appears in slp_get_pipeline next to the peer reports.
export function recordRouteHistory(
  route: PeerRoute,
  entry: { id: string; fromAgentId: string; toAgentId: string; message: string; createdAt: string },
): void {
  for (const historyStage of route.historyStages) historyStage.messages.push(entry);
}
