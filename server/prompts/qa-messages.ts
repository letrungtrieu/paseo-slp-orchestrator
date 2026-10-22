// Runtime messages for the QA Lead; its standing behavior comes from .slp/QA_LEAD.md, these only carry run events.
import type { PipelineState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import type { SiblingLeadSummary } from "./messages";

export interface QaLeadBriefingContext {
  acceptanceCriteria: string;
  sharedContext?: string;
  qaWorktreePath: string;
  qaBranch: string;
  featureLeads: ReadonlyArray<SiblingLeadSummary>;
}

// Agent ids are included verbatim because the QA Lead needs them for slp_send_peer_message.
function featureLeadRoster(featureLeads: ReadonlyArray<SiblingLeadSummary>): string {
  return featureLeads
    .map(
      (featureLead) =>
        `- **Feature \`${featureLead.featureName}\`**: Lead \`${featureLead.agentId}\` (worktree \`${featureLead.worktreePath ?? "n/a"}\`, branch \`${featureLead.branch ?? "n/a"}\`)\n  Criteria: ${featureLead.acceptanceCriteria}${featureLead.productSpec ? `\n  Product spec:\n${featureLead.productSpec}` : ""}`,
    )
    .join("\n");
}

// Sent at delegation: the QA Lead plans while features are built, so testing starts the moment the last branch merges.
export function qaLeadPreparationBriefing(context: QaLeadBriefingContext): string {
  return [
    "The Supervisor delegated this run. You are its QA Lead.",
    `### Your QA Worktree\n- **Worktree**: \`${context.qaWorktreePath}\` (branch \`${context.qaBranch}\`)\n- Every feature Lead merges its finished branch into this branch with slp_finalize_pipeline and resolves merge conflicts before you start.`,
    `### Overall Acceptance Criteria\n${context.acceptanceCriteria}`,
    context.sharedContext ? `### Shared Cross-Feature Context\n${context.sharedContext}` : "",
    `### Feature Leads Building in Parallel (reachable via slp_send_peer_message)\n${featureLeadRoster(context.featureLeads)}`,
    [
      "### What To Do Now (Preparation Phase)",
      "1. Read `.slp/standards/TEST_POLICY.md` and study how this project tests: unit tests, automation/E2E suites, manual-test checklists and critical journeys.",
      "2. Build the QA plan for the merged build: turn every Given/When/Then scenario of each product spec into a test case (automated where TEST_POLICY allows, manual otherwise), then add suites, evidence and the `.slp/peers` roles that will run them.",
      "3. Ask feature Leads about risky contracts or areas when needed.",
      "4. Do NOT call slp_define_pipeline yet; it is rejected until the engine hands the merged QA branch to you. End your turn when the plan is ready.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

// Each Lead's finalize summary carries its heavy-verification hand-offs, so it is forwarded unabridged.
function mergedFeatureSummary(pipeline: PipelineState): string {
  return [
    `#### Feature Pipeline: ${pipeline.name} (\`${pipeline.id}\`)`,
    `- **Merged**: \`${pipeline.branch ?? "n/a"}\` (commit \`${pipeline.mergedCommit ?? "n/a"}\`)`,
    `- **Lead summary and heavy-verification hand-offs**:\n${pipeline.finalReport ?? "No summary provided."}`,
  ].join("\n");
}

// Sent when the last feature branch lands: the QA branch now holds the whole conflict-free result.
export function qaHandoverBriefing(run: Run, mergedFeaturePipelines: readonly PipelineState[]): string {
  return [
    `Every feature pipeline is merged into the QA branch \`${run.integrationBranch}\` (\`${run.devCwd}\`); the feature Leads resolved all merge conflicts and have been retired.`,
    "## Merged Feature Summaries",
    mergedFeaturePipelines.map(mergedFeatureSummary).join("\n\n"),
    [
      "## Next Action for QA Lead",
      "1. Inspect the merged QA branch and the hand-off items above.",
      "2. Call slp_define_pipeline now with your QA stages (omit worktree; QA pipelines always run in the QA worktree). Stage peers fork from your session.",
      "3. Supervise the stages, approve the last one, close it with slp_finalize_pipeline, then call slp_report with a pass/fail line for every product spec scenario.",
    ].join("\n"),
  ].join("\n\n");
}

// Supervisor rework returns to the QA Lead, who reuses the QA worktree for fix and re-verification stages.
export function qaReworkNotice(feedback: string, run: Run): string {
  return [
    `The Supervisor requested rework of the verified result on the QA branch \`${run.integrationBranch}\` (\`${run.devCwd}\`):`,
    feedback,
    "Define a new QA pipeline with a new name via slp_define_pipeline containing the fix stages (developer peers) and the re-verification stages, close it with slp_finalize_pipeline, then call slp_report again.",
  ].join("\n");
}

// Used when a replacement QA Lead session takes over during the QA phase.
export function qaLeadRevivalBriefing(run: Run): string {
  return `Your QA Lead session was revived. Every feature branch is merged into the QA branch \`${run.integrationBranch}\` (\`${run.devCwd}\`). Inspect slp_get_run and slp_list_pipelines, then call slp_define_pipeline to run the QA stages.`;
}
