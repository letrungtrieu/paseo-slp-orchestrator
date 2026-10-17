// Direct conversations and peer evidence are durable stage records, independent of business role names.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { StageReportSubmission } from "../../shared/pipeline";
import type { PipelineContext } from "./context";
import { pausePipeline, requireStageLead, stageForCaller } from "./stage-context";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

export function sendPeerMessage(ctx: PipelineContext, caller: BusCaller, input: { toAgentId: string; message: string; waitForReply: boolean }): string {
  const { run, stage, agent } = stageForCaller(ctx, caller);
  const recipient = run.agents[input.toAgentId];
  // Peers may challenge one another or contact their coordinator, but may not bypass a different stage's boundary.
  const participants = new Set([...stage.peerAgentIds, stage.forkedLeadAgentId]);
  if (!recipient || recipient.archivedAt || !participants.has(input.toAgentId) || input.toAgentId === caller.agentId) {
    throw new ToolError("Select another active participant of your current stage.");
  }
  const createdAt = new Date().toISOString();
  const restoresReply = recipient.waitingForAgentId === caller.agentId;
  const replyTool = restoresReply ? recipient.deferredTool : null;
  ctx.store.mutate(run.id, (mutableRun) => {
    // Store history and queued delivery atomically so a reload cannot expose a message that will never be delivered.
    stage.messages.push({ id: randomUUID(), fromAgentId: caller.agentId, toAgentId: input.toAgentId, message: input.message, createdAt });
    mutableRun.mailbox.push({ id: randomUUID(), toAgentId: input.toAgentId,
      text: `Direct stage message from ${agent.projectRole ?? "Forked Lead"} (${caller.agentId}):\n${input.message}\nReply directly with slp_send_peer_message when a response is needed. Keep the stage goal in view.`,
      taskId: null, awaitTool: replyTool, isReminder: false, createdAt });
    if (restoresReply) {
      recipient.waitingForAgentId = null;
      recipient.deferredTool = null;
    }
    if (input.waitForReply) {
      // An explicit wait suspends report reminders until the chosen recipient replies.
      agent.waitingForAgentId = input.toAgentId;
      agent.deferredTool = agent.awaitingTool ?? (agent.role === "peer" ? "slp_stage_report" : "slp_approve_stage");
      agent.awaitingTool = null;
      agent.awaitingSince = createdAt;
    }
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: input.toAgentId, kind: "stage.message", summary: input.message.slice(0, 240), outcome: "queued" });
  return input.waitForReply ? "Message saved and queued. End your turn while waiting for the reply." : "Message saved and queued. Continue the stage assignment or report your findings.";
}

export function submitStageReport(ctx: PipelineContext, caller: BusCaller, submission: StageReportSubmission): string {
  const { run, stage, agent } = stageForCaller(ctx, caller);
  if (agent.role !== "peer" || !agent.projectRole) throw new ToolError("Only an assigned stage peer submits peer evidence.");
  const coordinatorId = stage.forkedLeadAgentId;
  if (!coordinatorId) throw new ToolError("Stage coordinator is unavailable.");
  const report = { ...submission, agentId: caller.agentId, role: agent.projectRole, submittedAt: new Date().toISOString() };
  ctx.store.mutate(run.id, () => {
    // Follow-up reports append evidence instead of erasing the discussion that led to the latest conclusion.
    stage.reports.push(report);
    agent.waitingForAgentId = null;
    agent.deferredTool = null;
    if (run.agents[coordinatorId]) {
      // A report is also a reply to a coordinator's request; it replaces any deferred conversation wait.
      run.agents[coordinatorId].waitingForAgentId = null;
      run.agents[coordinatorId].deferredTool = null;
    }
    // A report and its wake-up are one durable transition, preventing lost evidence notifications after reload.
    run.mailbox.push(stageMail(coordinatorId,
      `Stage '${stage.name}' peer report:\n${JSON.stringify(report)}\nCompare this evidence with goal '${stage.goal}'. Direct more work or approve when you accept the result.`, "slp_approve_stage"));
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: coordinatorId, kind: "stage.report", summary: `${agent.projectRole}: ${submission.status}`, outcome: "queued" });
  return "Stage report saved for the Forked Lead. End your turn; further assignments arrive as messages.";
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
        `Forked Lead requests rework for stage '${stage.name}'.\nGoal: ${stage.goal}\n${input.feedback}\nDiscuss with your peers as needed and submit new evidence using slp_stage_report.`, "slp_stage_report"));
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
    // Peer disagreement belongs to its Forked Lead; only that coordinator escalates a whole stage to the Master Lead.
    return submitStageReport(ctx, caller, { summary: reason, findings: [], status: "blocked" });
  }
  pausePipeline(ctx, run.id, pipeline.id, `${stage.name}: ${reason}`);
  return "Stage escalated to the Master Lead. End your turn until a recovery decision arrives.";
}
