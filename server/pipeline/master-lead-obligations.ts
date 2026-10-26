// Decides which workflow tool the accountable Lead (feature Lead, or QA Lead after handover) owes in the
// current run state, so revival and nudging re-queue exactly one valid obligation instead of a stale one.
import { awaitsLeadRecovery } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { delegationMessage } from "../prompts/messages";
import { qaLeadRevivalBriefing } from "../prompts/qa-messages";
import { isQaPhaseActive, qaVerificationComplete, runHasQaLead } from "./qa/qa-phase-state";

export interface MasterLeadRecoveryObligation {
  awaitTool: string;
  briefingText: string;
}

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
    return runPipelines.some(awaitsLeadRecovery);
  }
  if (awaitedTool === "slp_finalize_pipeline") {
    return runPipelines.some((pipeline) => pipeline.status === "completed" && !pipeline.gate);
  }
  if (awaitedTool === "slp_report") {
    // With a QA Lead, merged code is not reportable until a QA pass has verified it.
    if (runHasQaLead(run)) return qaVerificationComplete(run);
    return runPipelines.length > 0 && runPipelines.every((pipeline) => pipeline.status === "integrated");
  }
  return false;
}

export function inferMasterLeadObligation(
  run: Run,
  previousAwaitingTool: string | null,
): MasterLeadRecoveryObligation | null {
  // A QA Lead in planning owes its QA pipeline over the merged branch, not a feature pipeline.
  if (run.status === "planning" && isQaPhaseActive(run)) {
    return { awaitTool: "slp_define_pipeline", briefingText: qaLeadRevivalBriefing(run) };
  }
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
      briefingText: `${delegationMessage(run.criteria, run.productSpec ? { productSpec: run.productSpec } : undefined)}${reworkContextNote}\nYour previous Master Lead session ended before defining the pipeline. Call slp_define_pipeline now.`,
    };
  }
  if (run.status === "running") {
    const runPipelines = Object.values(run.pipelines);
    // Paused pipelines without a human gate depend on the Master Lead's recovery guidance to continue.
    const pausedPipeline = runPipelines.find(awaitsLeadRecovery);
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
    // Once every declared pipeline is integrated (and, with a QA Lead, verified), the accountable Lead owes the final report.
    const isReportable = runHasQaLead(run)
      ? qaVerificationComplete(run)
      : runPipelines.length > 0 && runPipelines.every((pipeline) => pipeline.status === "integrated");
    if (isReportable) {
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
