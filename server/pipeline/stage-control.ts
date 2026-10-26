// Approval is the Lead's decision; engine state only coordinates closure and subsequent stages.
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineBrief } from "../../shared/pipeline";
import type { PipelineContext } from "./context";
import { pipelineFinalizationBriefing } from "./stage-briefings";
import { requirePipeline, requireStageLead } from "./stage-context";
import { fallbackLeadIdFor } from "./qa/qa-phase-state";
import { recoverPipelines } from "./stage-engine";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

function scheduleRecovery(ctx: PipelineContext, runId: string): void {
  // Tool replies must return before waiting for the Lead's turn or advancing the stage.
  void recoverPipelines(ctx, runId).catch((failure) => console.error("[slp] stage recovery failed", failure));
}

export function approveStage(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { summary: string; brief?: PipelineBrief },
): string {
  const { run, pipeline, stage } = requireStageLead(ctx, caller);
  const { summary, brief } = input;
  // The planning stage exists to produce the brief, so closing it without one would leave the developer without a contract.
  if (stage.kind === "planning" && !brief) {
    throw new ToolError("Approving the planning stage requires brief: { approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }. It becomes the locked contract for the next stages.");
  }
  if (stage.kind !== "planning" && brief) {
    throw new ToolError(pipeline.brief
      ? "The brief is locked and cannot be changed. If it is wrong, call slp_escalate."
      : "Only a planning stage approval sets the brief.");
  }
  const approvedAt = new Date().toISOString();
  ctx.store.mutate(run.id, () => {
    // Persist the decision before any archive call: recovery resumes closure rather than asking for approval twice.
    stage.result = { summary, approvedBy: caller.agentId, approvedAt };
    stage.status = "completing";
    if (brief) {
      pipeline.brief = brief;
      pipeline.briefLockedAt = approvedAt;
    }
    pipeline.updatedAt = approvedAt;
    run.agents[caller.agentId].awaitingTool = null;
  });
  ctx.logEvent(run.id, { taskId: null, from: caller.agentId, to: "pipeline", kind: "stage.approved", summary: `${pipeline.name}/${stage.name}: ${summary}`, outcome: "delivered" });
  scheduleRecovery(ctx, run.id);
  return "Stage approval saved. End your turn. The engine hands accepted results to the next stage (or assigns slp_finalize_pipeline to merge the completed pipeline branch).";
}

export function resumePipeline(
  ctx: PipelineContext,
  runId: string,
  pipelineId: string,
  feedback: string,
  options: { relayedHumanDecision?: boolean } = {},
): string {
  const run = ctx.store.require(runId);
  if (run.status !== "running") throw new ToolError("Only an active run can resume its pipeline.");
  const pipeline = requirePipeline(run, pipelineId);
  if (pipeline.status !== "paused") throw new ToolError("Only a paused pipeline can be resumed.");
  if (pipeline.gate) throw new ToolError("This pipeline is waiting for the human approval selected by its run mode.");
  // The rework cap exists so the human, not the Lead, decides what happens after repeated failed rounds.
  if (pipeline.awaitingHumanDecision && !options.relayedHumanDecision) {
    throw new ToolError("This pipeline is waiting for the human's decision, which the Supervisor relays. End your turn.");
  }
  const stage = pipeline.stages[pipeline.currentStageIndex];
  if (!stage) throw new ToolError("Pipeline has no stage to resume.");
  const targetLeadId = stage.forkedLeadAgentId ?? pipeline.leadAgentId ?? fallbackLeadIdFor(run, pipeline);
  ctx.store.mutate(runId, () => {
    pipeline.status = stage.status === "pending" ? "queued" : "running";
    pipeline.pausedReason = null;
    pipeline.updatedAt = new Date().toISOString();
    if (options.relayedHumanDecision) {
      // The human granted a fresh set of rounds (or told the Lead to accept), so the counter starts over.
      pipeline.awaitingHumanDecision = false;
      stage.reworkRounds = 0;
    }
    // The recovery decision is attached to the stage so replacement Lead sessions can read it after a partial startup.
    stage.messages.push({ id: `decision-${pipeline.updatedAt}`, fromAgentId: fallbackLeadIdFor(run, pipeline),
      toAgentId: targetLeadId || "stage-coordinator", message: feedback, createdAt: pipeline.updatedAt });
    if (stage.status === "running" && targetLeadId) {
      // A persisted resume must carry its recovery direction through the same restart boundary.
      run.mailbox.push(stageMail(targetLeadId,
        `Lead resumes stage '${stage.name}':\n${feedback}\nInspect slp_get_pipeline and direct peers or approve against its goal.`, "slp_approve_stage"));
    }
  });
  scheduleRecovery(ctx, runId);
  return "Pipeline resumed with your decision. End your turn while its stage coordinator continues.";
}

// The Supervisor's only way to hand the human's verdict back to a rework-capped stage.
export function relayHumanDecision(ctx: PipelineContext, runId: string, pipelineId: string, decision: string): string {
  const pipeline = requirePipeline(ctx.store.require(runId), pipelineId);
  if (!pipeline.awaitingHumanDecision) throw new ToolError(`Pipeline '${pipeline.name}' is not waiting for a human decision.`);
  resumePipeline(ctx, runId, pipelineId, `Human decision (relayed by the Supervisor): ${decision}\nThe rework counter is reset. Apply this decision: approve with slp_approve_stage or request rework with slp_stage_rework.`, { relayedHumanDecision: true });
  return "Decision relayed to the Lead. End your turn.";
}

export function approvePipelineGate(ctx: PipelineContext, runId: string, pipelineId: string): string {
  const run = ctx.store.require(runId);
  // A delayed mobile approval must not reopen a gate after the run was aborted elsewhere.
  if (run.engineVersion !== "dynamic-stages-v1" || run.status !== "running") throw new ToolError("Only an active dynamic run can approve a pipeline gate.");
  const pipeline = requirePipeline(run, pipelineId);
  const gate = pipeline.gate;
  if (!gate) throw new ToolError("Pipeline has no human approval gate.");
  ctx.store.mutate(runId, () => {
    pipeline.gate = null;
    pipeline.pausedReason = null;
    // A completed pipeline waits for integration; an intermediate approval schedules its next declared stage.
    pipeline.status = gate.kind === "before_integration" ? "completed" : "queued";
    if (gate.kind === "before_integration") {
      const finalStageCoordinatorId = pipeline.stages.at(-1)?.forkedLeadAgentId ?? pipeline.leadAgentId;
      const finalizingAgentId = finalStageCoordinatorId && !run.agents[finalStageCoordinatorId]?.archivedAt
        ? finalStageCoordinatorId
        : fallbackLeadIdFor(run, pipeline);
      run.mailbox.push(stageMail(finalizingAgentId, pipelineFinalizationBriefing(run, pipeline), "slp_finalize_pipeline"));
    }
  });
  scheduleRecovery(ctx, runId);
  return gate.kind === "before_integration" ? "Integration approved for the Lead." : "Next stage scheduled.";
}
