// Direct conversations and peer evidence are durable stage records, independent of business role names.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { StageReportSubmission } from "../../shared/pipeline";
import type { PipelineContext } from "./context";
import { coordinatorRevivalBriefing } from "./stage-briefings";
import { pausePipeline, requireStageLead, stageForCaller } from "./stage-context";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

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
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === caller.agentId && queuedMessage.awaitTool === "slp_stage_report"),
    );
    // Check whether any other active peer in this stage still owes its stage report before waking the Lead.
    const otherPeersStillOwingReport = stage.peerAgentIds.some((peerAgentId) => {
      if (!peerAgentId || peerAgentId === caller.agentId) return false;
      const peerRecord = mutableRun.agents[peerAgentId];
      if (!peerRecord || peerRecord.archivedAt) return false;
      const hasQueuedReportMail = mutableRun.mailbox.some(
        (queuedMessage) => queuedMessage.toAgentId === peerAgentId && queuedMessage.awaitTool === "slp_stage_report",
      );
      return peerRecord.awaitingTool === "slp_stage_report" || hasQueuedReportMail;
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
      // All prior reports remain stage history; the rework message is appended to it.
      stage.messages.push({ id: randomUUID(), fromAgentId: caller.agentId, toAgentId: recipientId,
        message: input.feedback, createdAt: new Date().toISOString() });
      run.mailbox.push(stageMail(recipientId,
        `Lead requests rework for stage '${stage.name}'.\nGoal: ${stage.goal}\n${input.feedback}\nDiscuss with your peers as needed and submit new evidence using slp_stage_report.`, "slp_stage_report"));
    }
    // The coordinator has delegated a further pass and should be woken by results rather than approval reminders.
    agent.awaitingTool = null;
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
  // Notify the Supervisor when a Lead escalates a stage so the Supervisor has immediate visibility into blockers.
  if (run.supervisorAgentId && run.agents[run.supervisorAgentId] && !run.agents[run.supervisorAgentId].archivedAt) {
    ctx.mailbox.enqueue(
      run.id,
      run.supervisorAgentId,
      `Lead (${caller.agentId}) escalated pipeline '${pipeline.name}' (${pipeline.id}) at stage '${stage.name}':\n${reason}\nInspect slp_get_pipeline({ pipelineId: "${pipeline.id}" }) or wait for the Lead to resume with slp_resume_pipeline.`,
      {
        taskId: null,
        awaitTool: null,
        from: caller.agentId,
        summary: `escalation: ${pipeline.name}/${stage.name}`,
      },
    );
  }
  return "Stage escalated. End your turn until a recovery decision arrives.";
}
