// Peer evidence, rework requests and escalations are durable stage records, independent of business role names.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { StageReportSubmission } from "../../shared/pipeline";
import { runOrchestration } from "../../shared/orchestration";
import type { PipelineContext } from "./context";
import { humanDecisionRequest } from "./stage-briefing-sections";
import { coordinatorReportUpdateBriefing, coordinatorRevivalBriefing } from "./stage-briefings";
import { pausePipeline, requireStageLead, stageForCaller } from "./stage-context";
import { agentPeerKind } from "./stage-shape";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";
import { queueRegrade, verifyStageCast } from "./verify-loop";

export function submitStageReport(ctx: PipelineContext, caller: BusCaller, submission: StageReportSubmission): string {
  const { run, pipeline, stage, agent } = stageForCaller(ctx, caller);
  if (agent.role !== "peer" || !agent.projectRole) throw new ToolError("Only an assigned stage peer submits peer evidence.");
  const coordinatorId = stage.forkedLeadAgentId ?? pipeline.leadAgentId;
  if (!coordinatorId) throw new ToolError("Stage coordinator is unavailable.");
  const peerKind = agentPeerKind(run, agent.projectRole);
  // The Lead decides on the scorecard alone, so a QA result without one would force it to go and ask.
  if (peerKind === "qa" && submission.status === "completed" && !submission.scorecard?.length) {
    throw new ToolError("QA peers submit a scorecard: one entry per brief criterion { criterionId, status: pass|fail|blocked, reason, evidence }. Put anything outside the criteria into observations.");
  }
  if (peerKind !== "qa" && submission.scorecard?.length) throw new ToolError("Only QA peers submit a scorecard.");
  const report = { ...submission, agentId: caller.agentId, role: agent.projectRole, submittedAt: new Date().toISOString() };
  let notifiedCoordinator = false;
  let regradeQueued = false;
  ctx.store.mutate(run.id, (mutableRun) => {
    // Follow-up reports append evidence instead of erasing the discussion that led to the latest conclusion.
    stage.reports.push(report);
    agent.awaitingTool = null;
    agent.awaitingSince = null;
    agent.nudges = 0;
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === caller.agentId && queuedMessage.awaitTool === "slp_stage_report"),
    );
    // A completed fix in a verify stage is only half a round: the Lead wakes once the graders have re-scored it.
    if (stage.kind === "verify" && peerKind === "developer" && report.status === "completed") {
      const graderAgentIds = verifyStageCast(mutableRun, stage).graderAgentIds;
      if (graderAgentIds.length > 0) {
        queueRegrade(mutableRun, stage, report, graderAgentIds);
        regradeQueued = true;
        return;
      }
    }
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
      // An undelivered review mail means the coordinator has not yet seen what it announced; replacing it
      // with a delta would drop that content, so only a delivered one allows a delta.
      const hasUndeliveredReviewMail = mutableRun.mailbox.some(
        (queuedMessage) => queuedMessage.toAgentId === coordinatorId && queuedMessage.awaitTool === "slp_approve_stage",
      );
      const reportsAlreadyBriefed = hasUndeliveredReviewMail ? 0 : stage.coordinatorSeenReports;
      mutableRun.mailbox = mutableRun.mailbox.filter(
        (queuedMessage) =>
          !(
            queuedMessage.toAgentId === coordinatorId
            && queuedMessage.awaitTool === "slp_approve_stage"
          ),
      );
      const reviewBriefing = reportsAlreadyBriefed > 0
        ? coordinatorReportUpdateBriefing(mutableRun, stage, reportsAlreadyBriefed)
        : coordinatorRevivalBriefing(mutableRun, pipeline, stage);
      mutableRun.mailbox.push(stageMail(coordinatorId, reviewBriefing, "slp_approve_stage"));
      // Recorded at queue time: a later report either replaces this mail (then briefs from zero) or follows its delivery.
      stage.coordinatorSeenReports = stage.reports.length;
      notifiedCoordinator = true;
    }
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: coordinatorId, kind: "stage.report", summary: `${agent.projectRole}: ${submission.status}`, outcome: "queued" });
  if (regradeQueued) return "Fix report saved. The QA peers re-grade your work now; end your turn.";
  return notifiedCoordinator
    ? "Stage report saved and queued for the Lead. End your turn; further assignments arrive as messages."
    : "Stage report saved. Waiting for remaining stage peers to finish before waking the Lead. End your turn.";
}

export function requestStageRework(ctx: PipelineContext, caller: BusCaller, input: { agentIds: string[]; feedback: string }): string {
  const { run, stage, agent } = requireStageLead(ctx, caller);
  const { maxReworkRounds } = runOrchestration(run);
  // The cap stops endless polishing: after it, the human decides instead of another model round.
  if (stage.reworkRounds >= maxReworkRounds) {
    throw new ToolError(`Rework cap reached for stage '${stage.name}' (${stage.reworkRounds}/${maxReworkRounds}). Approve with slp_approve_stage if the result is acceptable, otherwise call slp_escalate with the open problems and your recommendation; the Supervisor asks the human for the final decision.`);
  }
  // In a verify stage the natural rework target is the fixer; the graders re-score automatically after the fix.
  const verifyDeveloperId = stage.kind === "verify" ? verifyStageCast(run, stage).developerAgentId : null;
  const defaultRecipients = verifyDeveloperId ? [verifyDeveloperId] : stage.peerAgentIds;
  const recipients = [...new Set(input.agentIds.length ? input.agentIds : defaultRecipients)];
  if (recipients.some((agentId) => !stage.peerAgentIds.includes(agentId) || run.agents[agentId]?.archivedAt)) {
    throw new ToolError("Rework recipients must be active peers of this stage.");
  }
  const reworkRound = stage.reworkRounds + 1;
  ctx.store.mutate(run.id, () => {
    stage.reworkRounds = reworkRound;
    for (const recipientId of recipients) {
      // All prior reports remain stage history; the rework message is appended to it.
      stage.messages.push({ id: randomUUID(), fromAgentId: caller.agentId, toAgentId: recipientId,
        message: input.feedback, createdAt: new Date().toISOString() });
      run.mailbox.push(stageMail(recipientId,
        `Lead requests rework ${reworkRound}/${maxReworkRounds} for stage '${stage.name}'.\nGoal: ${stage.goal}\n${input.feedback}\nStay within the locked brief, ask only the Lead if something is unclear, and submit new evidence using slp_stage_report.`, "slp_stage_report"));
    }
    // The coordinator has delegated a further pass and should be woken by results rather than approval reminders.
    agent.awaitingTool = null;
  });
  return `Rework round ${reworkRound}/${maxReworkRounds} queued. End your turn while peers prepare the next evidence.`;
}

export function escalateStage(ctx: PipelineContext, caller: BusCaller, reason: string): string {
  const { run, pipeline, stage, agent } = stageForCaller(ctx, caller);
  if (agent.role === "peer") {
    // Peer disagreement belongs to its Lead; only that coordinator escalates a whole stage.
    return submitStageReport(ctx, caller, { summary: reason, findings: [], status: "blocked" });
  }
  const { maxReworkRounds } = runOrchestration(run);
  const reachedReworkCap = stage.reworkRounds >= maxReworkRounds;
  pausePipeline(ctx, run.id, pipeline.id, `${stage.name}: ${reason}`, { awaitingHumanDecision: reachedReworkCap });
  // Notify the Supervisor when a Lead escalates a stage so the Supervisor has immediate visibility into blockers.
  if (run.supervisorAgentId && run.agents[run.supervisorAgentId] && !run.agents[run.supervisorAgentId].archivedAt) {
    const supervisorText = reachedReworkCap
      ? humanDecisionRequest(pipeline, stage, caller.agentId, reason, maxReworkRounds)
      : `Lead (${caller.agentId}) escalated pipeline '${pipeline.name}' (${pipeline.id}) at stage '${stage.name}':\n${reason}\nInspect slp_get_pipeline({ pipelineId: "${pipeline.id}" }) or wait for the Lead to resume with slp_resume_pipeline.`;
    ctx.mailbox.enqueue(run.id, run.supervisorAgentId, supervisorText, {
      taskId: null,
      awaitTool: null,
      from: caller.agentId,
      // Only the latest blocker of a pipeline matters to the Supervisor, not each earlier escalation.
      supersedeKey: `escalation:${pipeline.id}`,
      summary: `escalation: ${pipeline.name}/${stage.name}`,
    });
  }
  return reachedReworkCap
    ? "Stage escalated to the human through the Supervisor. End your turn until the decision arrives."
    : "Stage escalated. End your turn until a recovery decision arrives.";
}
