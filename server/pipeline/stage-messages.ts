// Direct conversations and peer evidence are durable stage records, independent of business role names.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { StageReportSubmission } from "../../shared/pipeline";
import type { PipelineContext } from "./context";
import { coordinatorRevivalBriefing } from "./stage-briefings";
import { pausePipeline, requirePipeline, requireStageLead, stageForCaller } from "./stage-context";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

export function sendPeerMessage(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { toAgentId: string; message: string; waitForReply: boolean },
): string {
  const run = ctx.store.require(caller.runId);
  const agent = run.agents[caller.agentId];
  if (!agent || agent.archivedAt) {
    throw new ToolError("This tool requires an active agent session.");
  }
  const recipient = run.agents[input.toAgentId];
  const createdAt = new Date().toISOString();

  // Allow direct cross-Lead collaboration between unarchived Leads during planning, stage execution, or merge finalization
  // so parallel Leads can align shared APIs, data schemas, and end-to-end user flows across features.
  if (
    ["planning", "running"].includes(run.status)
    && agent.role === "master_lead"
    && recipient
    && !recipient.archivedAt
    && recipient.role === "master_lead"
    && input.toAgentId !== caller.agentId
  ) {
    const callerPipeline = agent.pipelineId ? run.pipelines[agent.pipelineId] : undefined;
    const recipientPipeline = recipient.pipelineId ? run.pipelines[recipient.pipelineId] : undefined;
    const callerStage = callerPipeline
      ? (callerPipeline.stages.find((candidate) => candidate.id === agent.stageId) ?? callerPipeline.stages.at(-1))
      : undefined;
    const recipientStage = recipientPipeline
      ? (recipientPipeline.stages.find((candidate) => candidate.id === recipient.stageId) ?? recipientPipeline.stages.at(-1))
      : undefined;
    const callerFeatureLabel = callerPipeline?.name ?? agent.featureName ?? "parallel-feature";
    const restoresSiblingReply = recipient.waitingForAgentId === caller.agentId;
    const siblingReplyTool = restoresSiblingReply ? recipient.deferredTool : null;
    const crossLeadDeliveryText = `Cross-Lead collaboration message from Lead (${caller.agentId}, feature '${callerFeatureLabel}'):\n${input.message}\nReply directly to ${caller.agentId} using slp_send_peer_message({ toAgentId: "${caller.agentId}", message: "...", waitForReply: false }) with concrete API contracts, schemas, or merge resolution details so your parallel features integrate seamlessly.`;
    ctx.store.mutate(run.id, (mutableRun) => {
      const messageEntry = { id: randomUUID(), fromAgentId: caller.agentId, toAgentId: input.toAgentId, message: input.message, createdAt };
      if (callerStage) {
        callerStage.messages.push(messageEntry);
      }
      if (recipientStage && recipientStage.id !== callerStage?.id) {
        recipientStage.messages.push(messageEntry);
      }
      mutableRun.mailbox.push({
        id: randomUUID(),
        toAgentId: input.toAgentId,
        text: crossLeadDeliveryText,
        taskId: null,
        awaitTool: siblingReplyTool,
        isReminder: false,
        createdAt,
      });
      if (restoresSiblingReply) {
        recipient.waitingForAgentId = null;
        recipient.deferredTool = null;
      }
      if (input.waitForReply) {
        // Preserve whichever obligation (slp_define_pipeline, slp_approve_stage, slp_finalize_pipeline, or slp_report) the Lead owed before consulting its sibling.
        const defaultLeadObligation = !callerPipeline
          ? "slp_define_pipeline"
          : callerPipeline.status === "completed"
            ? "slp_finalize_pipeline"
            : callerPipeline.status === "integrated"
              ? "slp_report"
              : "slp_approve_stage";
        agent.waitingForAgentId = input.toAgentId;
        agent.deferredTool = agent.awaitingTool ?? defaultLeadObligation;
        agent.awaitingTool = null;
        agent.awaitingSince = createdAt;
      }
    });
    ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: input.toAgentId, kind: "stage.message", summary: input.message.slice(0, 240), outcome: "queued" });
    return input.waitForReply
      ? "Cross-Lead consultation queued. End your turn while waiting for the sibling Lead's reply."
      : "Cross-Lead message queued. Continue your planning, stage, or merge assignment.";
  }

  if (!agent.pipelineId || !agent.stageId) {
    throw new ToolError("This tool requires an active stage assignment.");
  }
  const pipeline = requirePipeline(run, agent.pipelineId);

  // Allow the Lead and Peers of a completed pipeline to exchange merge/conflict Q&A before slp_finalize_pipeline finishes.
  if (run.status === "running" && pipeline.status === "completed") {
    const finalStage = pipeline.stages.at(-1);
    if (!finalStage) throw new ToolError("Completed pipeline has no stages.");
    const pipelinePeerIds = new Set(pipeline.stages.flatMap((completedStage) => completedStage.peerAgentIds).filter(Boolean));
    const pipelineCoordinatorIds = new Set(
      [
        pipeline.leadAgentId,
        ...pipeline.stages.map((completedStage) => completedStage.forkedLeadAgentId),
      ].filter((id): id is string => Boolean(id)),
    );
    const isPipelineParticipant = pipelinePeerIds.has(caller.agentId) || pipelineCoordinatorIds.has(caller.agentId);
    const isRecipientInPipeline = Boolean(
      recipient && !recipient.archivedAt && recipient.pipelineId === pipeline.id
      && (pipelinePeerIds.has(input.toAgentId) || pipelineCoordinatorIds.has(input.toAgentId))
      && input.toAgentId !== caller.agentId,
    );
    if (!isPipelineParticipant || !recipient || !isRecipientInPipeline) {
      throw new ToolError("Select an active peer or Lead of this pipeline, or another pipeline's Lead.");
    }
    const callerStageName = pipeline.stages.find((candidate) => candidate.id === agent.stageId)?.name ?? finalStage.name;
    const restoresMergeReply = recipient.waitingForAgentId === caller.agentId;
    const mergeReplyTool = restoresMergeReply ? recipient.deferredTool : null;
    const mergeDeliveryText = agent.role === "master_lead"
      ? `Merge/conflict question from pipeline '${pipeline.name}' Lead (${caller.agentId}):\n${input.message}\nReply directly to ${caller.agentId} using slp_send_peer_message({ toAgentId: "${caller.agentId}", message: "...", waitForReply: false }) explaining why your code was written this way and how the conflict should be resolved, then end your turn. Do not call slp_stage_report.`
      : `Merge/conflict reply from stage '${callerStageName}' ${agent.projectRole ?? "peer"} (${caller.agentId}):\n${input.message}\nUse this clarification to resolve the conflict and call slp_finalize_pipeline when ready.`;
    ctx.store.mutate(run.id, (mutableRun) => {
      finalStage.messages.push({ id: randomUUID(), fromAgentId: caller.agentId, toAgentId: input.toAgentId, message: input.message, createdAt });
      mutableRun.mailbox.push({
        id: randomUUID(), toAgentId: input.toAgentId, text: mergeDeliveryText,
        taskId: null, awaitTool: mergeReplyTool, isReminder: false, createdAt,
      });
      if (restoresMergeReply) {
        recipient.waitingForAgentId = null;
        recipient.deferredTool = null;
      }
      if (input.waitForReply && agent.role === "master_lead") {
        // Suspend slp_finalize_pipeline nudges while the Lead waits for the peer's conflict explanation.
        agent.waitingForAgentId = input.toAgentId;
        agent.deferredTool = agent.awaitingTool ?? "slp_finalize_pipeline";
        agent.awaitingTool = null;
        agent.awaitingSince = createdAt;
      }
    });
    ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: input.toAgentId, kind: "stage.message", summary: input.message.slice(0, 240), outcome: "queued" });
    return input.waitForReply && agent.role === "master_lead"
      ? "Message saved and queued. End your turn while waiting for the reply."
      : "Message saved and queued. Continue resolving the merge or end your turn.";
  }

  const currentStage = pipeline.stages[pipeline.currentStageIndex];
  if (run.status !== "running" || pipeline.status !== "running" || !currentStage || currentStage.status !== "running") {
    throw new ToolError("Your stage is no longer running. Read slp_get_pipeline for its current state.");
  }
  const completedPriorStages = pipeline.stages.slice(0, pipeline.currentStageIndex);
  const currentStageParticipantIds = new Set(
    [...currentStage.peerAgentIds, currentStage.forkedLeadAgentId, pipeline.leadAgentId].filter((id): id is string => Boolean(id)),
  );
  const priorStagePeerIds = new Set(
    completedPriorStages.flatMap((priorStage) => priorStage.peerAgentIds).filter(Boolean),
  );
  const isCurrentStageCaller = agent.stageId === currentStage.id && currentStageParticipantIds.has(caller.agentId);
  const isPriorStagePeerCaller = agent.role === "peer" && priorStagePeerIds.has(caller.agentId);
  if (!isCurrentStageCaller && !isPriorStagePeerCaller) {
    throw new ToolError("Agent is not a participant of this pipeline.");
  }
  // Current-stage participants may message peers in the current stage or live peers from earlier stages of this pipeline;
  // prior-stage peers may only reply to active participants of the current running stage.
  const allowedRecipientIds = isCurrentStageCaller
    ? new Set([...currentStageParticipantIds, ...priorStagePeerIds])
    : currentStageParticipantIds;
  if (!recipient || recipient.archivedAt || !allowedRecipientIds.has(input.toAgentId) || input.toAgentId === caller.agentId) {
    throw new ToolError("Select another active participant of your current stage or a peer from an earlier stage of this pipeline.");
  }
  const isRecipientPriorStagePeer = priorStagePeerIds.has(input.toAgentId);
  const callerStageName = pipeline.stages.find((candidate) => candidate.id === agent.stageId)?.name ?? currentStage.name;
  const restoresReply = recipient.waitingForAgentId === caller.agentId;
  const replyTool = restoresReply ? recipient.deferredTool : null;
  const deliveryText = isRecipientPriorStagePeer
    ? `Cross-stage question from stage '${currentStage.name}' ${agent.projectRole ?? "Lead"} (${caller.agentId}):\n${input.message}\nReply directly to ${caller.agentId} using slp_send_peer_message({ toAgentId: "${caller.agentId}", message: "...", waitForReply: false }) with concrete metrics (exact logic, expected inputs, and expected outputs/outcomes), then end your turn. Do not call slp_stage_report.`
    : isPriorStagePeerCaller
      ? `Cross-stage reply from prior stage '${callerStageName}' ${agent.projectRole ?? "peer"} (${caller.agentId}):\n${input.message}\nReply directly with slp_send_peer_message if further clarification is needed, or continue your stage assignment.`
      : `Direct stage message from ${agent.projectRole ?? "Lead"} (${caller.agentId}):\n${input.message}\nReply directly with slp_send_peer_message when a response is needed. Keep the stage goal in view.`;
  ctx.store.mutate(run.id, (mutableRun) => {
    // Store history under the active stage and queue delivery atomically so a reload cannot lose the message.
    currentStage.messages.push({ id: randomUUID(), fromAgentId: caller.agentId, toAgentId: input.toAgentId, message: input.message, createdAt });
    mutableRun.mailbox.push({ id: randomUUID(), toAgentId: input.toAgentId,
      text: deliveryText, taskId: null, awaitTool: replyTool, isReminder: false, createdAt });
    if (restoresReply) {
      recipient.waitingForAgentId = null;
      recipient.deferredTool = null;
    }
    if (input.waitForReply && isCurrentStageCaller) {
      // An explicit wait suspends the active stage caller's report reminders until the chosen recipient replies.
      agent.waitingForAgentId = input.toAgentId;
      agent.deferredTool = agent.awaitingTool ?? (agent.role === "peer" ? "slp_stage_report" : "slp_approve_stage");
      agent.awaitingTool = null;
      agent.awaitingSince = createdAt;
    }
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: input.toAgentId, kind: "stage.message", summary: input.message.slice(0, 240), outcome: "queued" });
  return input.waitForReply && isCurrentStageCaller
    ? "Message saved and queued. End your turn while waiting for the reply."
    : "Message saved and queued. Continue the stage assignment or report your findings.";
}

export function submitStageReport(ctx: PipelineContext, caller: BusCaller, submission: StageReportSubmission): string {
  const { run, pipeline, stage, agent } = stageForCaller(ctx, caller);
  if (agent.role !== "peer" || !agent.projectRole) throw new ToolError("Only an assigned stage peer submits peer evidence.");
  const coordinatorId = stage.forkedLeadAgentId ?? pipeline.leadAgentId;
  if (!coordinatorId) throw new ToolError("Stage coordinator is unavailable.");
  const report = { ...submission, agentId: caller.agentId, role: agent.projectRole, submittedAt: new Date().toISOString() };
  let notifiedCoordinator = false;
  ctx.store.mutate(run.id, (mutableRun) => {
    // Follow-up reports append evidence instead of erasing the discussion that led to the latest conclusion.
    stage.reports.push(report);
    agent.awaitingTool = null;
    agent.awaitingSince = null;
    agent.nudges = 0;
    agent.waitingForAgentId = null;
    agent.deferredTool = null;
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === caller.agentId && queuedMessage.awaitTool === "slp_stage_report"),
    );
    // Release any sibling peer that was waiting on this caller for a direct reply so it does not hang for 120 seconds.
    for (const siblingPeerId of stage.peerAgentIds) {
      if (!siblingPeerId || siblingPeerId === caller.agentId) continue;
      const siblingRecord = mutableRun.agents[siblingPeerId];
      if (siblingRecord && !siblingRecord.archivedAt && siblingRecord.waitingForAgentId === caller.agentId) {
        const restoredPeerTool = siblingRecord.deferredTool ?? "slp_stage_report";
        siblingRecord.waitingForAgentId = null;
        siblingRecord.deferredTool = null;
        mutableRun.mailbox.push(stageMail(
          siblingPeerId,
          `Peer **${report.role}** (\`${caller.agentId}\`) submitted its stage report (${report.status}): ${report.summary}\nContinue your work and submit your own evidence with ${restoredPeerTool}.`,
          restoredPeerTool,
        ));
      }
    }
    if (mutableRun.agents[coordinatorId]?.waitingForAgentId === caller.agentId) {
      // A report is also a reply to a coordinator's request; it replaces any deferred conversation wait.
      mutableRun.agents[coordinatorId].waitingForAgentId = null;
      mutableRun.agents[coordinatorId].deferredTool = null;
    }
    // Check whether any other active peer in this stage still owes its stage report before waking the Lead.
    const otherPeersStillOwingReport = stage.peerAgentIds.some((peerAgentId) => {
      if (!peerAgentId || peerAgentId === caller.agentId) return false;
      const peerRecord = mutableRun.agents[peerAgentId];
      if (!peerRecord || peerRecord.archivedAt) return false;
      const hasQueuedReportMail = mutableRun.mailbox.some(
        (queuedMessage) => queuedMessage.toAgentId === peerAgentId && queuedMessage.awaitTool === "slp_stage_report",
      );
      return peerRecord.awaitingTool === "slp_stage_report"
        || peerRecord.deferredTool === "slp_stage_report"
        || hasQueuedReportMail;
    });
    if (!otherPeersStillOwingReport || report.status === "blocked") {
      mutableRun.mailbox = mutableRun.mailbox.filter(
        (queuedMessage) =>
          !(
            queuedMessage.toAgentId === coordinatorId
            && queuedMessage.awaitTool === "slp_approve_stage"
          ),
      );
      mutableRun.mailbox.push(
        stageMail(coordinatorId, coordinatorRevivalBriefing(mutableRun, pipeline, stage), "slp_approve_stage"),
      );
      notifiedCoordinator = true;
    }
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: coordinatorId, kind: "stage.report", summary: `${agent.projectRole}: ${submission.status}`, outcome: "queued" });
  return notifiedCoordinator
    ? "Stage report saved and queued for the Lead. End your turn; further assignments arrive as messages."
    : "Stage report saved. Waiting for remaining stage peers to finish before waking the Lead. End your turn.";
}

export function requestStageRework(ctx: PipelineContext, caller: BusCaller, input: { agentIds: string[]; feedback: string }): string {
  const { run, stage, agent } = requireStageLead(ctx, caller);
  const recipients = [...new Set(input.agentIds.length ? input.agentIds : stage.peerAgentIds)];
  if (recipients.some((agentId) => !stage.peerAgentIds.includes(agentId) || run.agents[agentId]?.archivedAt)) {
    throw new ToolError("Rework recipients must be active peers of this stage.");
  }
  ctx.store.mutate(run.id, () => {
    for (const recipientId of recipients) {
      // Fresh direction replaces a peer's conversation wait, while all prior reports remain stage history.
      run.agents[recipientId].waitingForAgentId = null;
      run.agents[recipientId].deferredTool = null;
      stage.messages.push({ id: randomUUID(), fromAgentId: caller.agentId, toAgentId: recipientId,
        message: input.feedback, createdAt: new Date().toISOString() });
      run.mailbox.push(stageMail(recipientId,
        `Lead requests rework for stage '${stage.name}'.\nGoal: ${stage.goal}\n${input.feedback}\nDiscuss with your peers as needed and submit new evidence using slp_stage_report.`, "slp_stage_report"));
    }
    // The coordinator has delegated a further pass and should be woken by results rather than approval reminders.
    agent.awaitingTool = null;
    agent.waitingForAgentId = null;
    agent.deferredTool = null;
  });
  return "Rework queued. End your turn while peers prepare the next evidence.";
}

export function escalateStage(ctx: PipelineContext, caller: BusCaller, reason: string): string {
  const { run, pipeline, stage, agent } = stageForCaller(ctx, caller);
  if (agent.role === "peer") {
    // Peer disagreement belongs to its Lead; only that coordinator escalates a whole stage.
    return submitStageReport(ctx, caller, { summary: reason, findings: [], status: "blocked" });
  }
  pausePipeline(ctx, run.id, pipeline.id, `${stage.name}: ${reason}`);
  return "Stage escalated. End your turn until a recovery decision arrives.";
}
