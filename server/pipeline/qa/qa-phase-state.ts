// Pure predicates over persisted run state that decide which phase a run is in: feature Leads building
// in parallel, or the QA Lead verifying the merged QA branch. Every module asks these instead of re-deriving them.
import type { PipelineState } from "../../../shared/pipeline";
import type { Run } from "../../../shared/state";

export function isQaPipeline(pipeline: PipelineState): boolean {
  return pipeline.kind === "qa";
}

export function featurePipelinesOf(run: Run): PipelineState[] {
  return Object.values(run.pipelines).filter((pipeline) => !isQaPipeline(pipeline));
}

export function qaPipelinesOf(run: Run): PipelineState[] {
  return Object.values(run.pipelines).filter(isQaPipeline);
}

// Runs created before QA Leads existed keep the old "primary Lead reports" flow.
export function runHasQaLead(run: Run): boolean {
  return Boolean(run.qaLeadAgentId);
}

// The handover moves run accountability (revival, nudges, rework) to the QA Lead by repointing masterLeadAgentId.
export function isQaPhaseActive(run: Run): boolean {
  return runHasQaLead(run) && run.masterLeadAgentId === run.qaLeadAgentId;
}

// A feature Lead still owing its first pipeline means more branches will arrive, so the QA branch is not complete yet.
export function hasFeatureLeadStillPlanning(run: Run): boolean {
  return Object.values(run.agents).some(
    (agentRecord) =>
      agentRecord.role === "master_lead"
      && !agentRecord.archivedAt
      && agentRecord.awaitingTool === "slp_define_pipeline",
  );
}

// `pendingPipelineId` lets finalization ask "will everything be merged once this branch lands?" before persisting it.
export function allFeaturePipelinesIntegrated(run: Run, pendingPipelineId?: string): boolean {
  const featurePipelines = featurePipelinesOf(run);
  if (featurePipelines.length === 0 || hasFeatureLeadStillPlanning(run)) return false;
  return featurePipelines.every(
    (pipeline) => pipeline.id === pendingPipelineId || pipeline.status === "integrated",
  );
}

// QA counts only if it closed after the last feature merge; an older QA pass verified different code.
export function qaVerificationComplete(run: Run): boolean {
  if (!allFeaturePipelinesIntegrated(run)) return false;
  const qaPipelines = qaPipelinesOf(run);
  // A running or paused QA pipeline means verification is still in progress, even if an older pass succeeded.
  if (qaPipelines.some((pipeline) => !["integrated", "failed"].includes(pipeline.status))) return false;
  // ISO-8601 timestamps from one clock compare correctly as strings.
  const latestFeatureMergeAt = featurePipelinesOf(run)
    .map((pipeline) => pipeline.integratedAt ?? "")
    .reduce((latestTimestamp, candidateTimestamp) => (candidateTimestamp > latestTimestamp ? candidateTimestamp : latestTimestamp), "");
  return qaPipelines.some(
    (pipeline) => pipeline.status === "integrated" && (pipeline.integratedAt ?? "") >= latestFeatureMergeAt,
  );
}

// Stage recovery falls back to the accountable Lead when a pipeline lost its own coordinator.
export function fallbackLeadIdFor(run: Run, pipeline: PipelineState): string {
  return isQaPipeline(pipeline) && run.qaLeadAgentId ? run.qaLeadAgentId : run.masterLeadAgentId;
}
