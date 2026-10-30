// Every fresh cohort receives the same goal, roster and durable handover before any peer starts work.
import type { PipelineState, StageState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { runOrchestration } from "../../shared/orchestration";
import { peerKindOf } from "../../shared/project-prompts";
import { peerRole } from "../project-prompts/defaults";
import type { StagePromptContext } from "../prompts/system-prompts";
import { briefSection, formatStageReports, peerKindGuidance } from "./stage-briefing-sections";

export function stagePromptContext(pipeline: PipelineState, stage: StageState, task: string): StagePromptContext {
  // The goal and assignment are system context even before the final roster is activated through the mailbox.
  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stageId: stage.id,
    stageName: stage.name,
    goal: stage.goal,
    task,
    worktree: pipeline.worktree,
    peerRoster: stage.peers.map(({ role, task }) => ({ role, task })),
    priorResults: pipeline.stages
      .slice(0, pipeline.currentStageIndex)
      .map((previousStage) => `${previousStage.name}: ${previousStage.result?.summary ?? ""}`),
    history: stage.messages.map((message) => `${message.fromAgentId} -> ${message.toAgentId}: ${message.message}`),
  };
}

function stageContextSection(pipeline: PipelineState, stage: StageState): string {
  const owningLeadId = stage.forkedLeadAgentId ?? pipeline.leadAgentId ?? "pending";
  return [
    "### Stage Context",
    `- **Pipeline**: ${pipeline.name} (\`${pipeline.id}\`) — ${pipeline.description}`,
    `- **Stage**: ${stage.name} (\`${stage.id}\`, ${stage.kind ?? "stage"})`,
    `- **Worktree**: \`${pipeline.worktree}\``,
    `- **Stage Goal**: ${stage.goal}`,
    `- **Lead (your only contact)**: \`${owningLeadId}\``,
  ].join("\n");
}

// Shared tail of every stage briefing: acceptance criteria, the locked brief and what earlier stages concluded.
function stageBackgroundSections(run: Run, pipeline: PipelineState): string[] {
  const sections: string[] = [];
  if (run.criteria) sections.push(`### Overall Acceptance Criteria\n${run.criteria}`);
  const lockedBrief = briefSection(run, pipeline);
  if (lockedBrief) sections.push(lockedBrief);
  const previousStageLines = pipeline.stages.slice(0, pipeline.currentStageIndex).map((previousStage) =>
    `- **${previousStage.name}** (${previousStage.goal}): ${previousStage.result?.summary ?? "Approved"}`,
  );
  if (previousStageLines.length > 0) sections.push(`### Previous Stage Results\n${previousStageLines.join("\n")}`);
  return sections;
}

export function stageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The coordinator alone sees the roster: peers talk to the Lead, never to each other.
  const rosterLines = stage.peerAgentIds.map((agentId, peerIndex) => {
    const peerAssignment = stage.peers[peerIndex];
    return `- **${peerAssignment.role}** (\`${agentId}\`): ${peerAssignment.task}`;
  });
  return [
    stageContextSection(pipeline, stage),
    `### Stage Peer Roster\n${rosterLines.join("\n")}`,
    ...stageBackgroundSections(run, pipeline),
  ].join("\n\n");
}

export function peerStageBriefing(run: Run, pipeline: PipelineState, stage: StageState, peerIndex: number): string {
  const assignment = stage.peers[peerIndex];
  const peerKind = peerKindOf(peerRole(run.promptConfig, assignment.role));
  return [
    `You are project peer **${assignment.role}** in stage **${stage.name}**.`,
    `### Your Task\n${assignment.task}`,
    peerKindGuidance(peerKind, stage),
    stageContextSection(pipeline, stage),
    ...stageBackgroundSections(run, pipeline),
  ].join("\n\n");
}

function reworkBudgetLine(run: Run, stage: StageState): string {
  const { maxReworkRounds } = runOrchestration(run);
  return `Rework rounds used: ${stage.reworkRounds}/${maxReworkRounds}. At the cap you either approve or call slp_escalate, and the human decides through the Supervisor.`;
}

// Planning and Mockup stages end in the locked brief, so the coordinator is reminded that approval carries that contract.
function coordinatorDecisionGuidance(stage: StageState): string {
  if (stage.kind === "planning") {
    return "Discuss the approach with the advisors, choose the simplest option that meets the acceptance criteria, then call `slp_approve_stage({ summary, brief: { approach, criteria: [{ id, requirement, verification }], inScope, outOfScope } })`. The brief is locked after approval.";
  }
  if (stage.kind === "mockup") {
    return "Coordinate your engineer peers to analyze sub-parts of the Spec and assemble a working HTML/CSS/JS mockup at `.slp/mockups/<feature>/index.html`. Then call `slp_submit_mockup({ summary })` so the engine snapshots `.slp/mockups/<feature>/versions/v<N>/index.html` and notifies the Supervisor for human review. Once the human approves the mockup, call `slp_approve_stage({ summary, brief: { approach, criteria: [{ id, requirement, verification }], inScope, outOfScope } })` to lock the Brief and open `implement`.";
  }
  if (stage.kind === "verify") {
    return "Decide from the QA scorecards: approve with `slp_approve_stage`, or send a fix to the developer with `slp_stage_rework` (the graders re-score automatically after the fix). Observations outside the criteria are your judgement call.";
  }
  return "Judge the developer's report against the locked brief. Approve with `slp_approve_stage`, or request a correction with `slp_stage_rework`. Do not ask for work outside the brief.";
}

export function coordinatorStageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The Lead judges the goal according to its configured .slp/LEAD.md workflow.
  return [
    `You are the **Lead** controlling this stage until closure. ${coordinatorDecisionGuidance(stage)} Use \`slp_escalate\` if blocked beyond your authority.`,
    reworkBudgetLine(run, stage),
    stageBriefing(run, pipeline, stage),
  ].join("\n\n");
}

// When a Lead session dies mid-stage after peers already reported, include their saved reports so the replacement can act immediately.
export function coordinatorRevivalBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  const baseBriefing = coordinatorStageBriefing(run, pipeline, stage);
  if (stage.reports.length === 0) return baseBriefing;
  return `${baseBriefing}\n\n### Submitted Stage Peer Reports\n${formatStageReports(stage.reports)}\n\nDecide on the submitted reports according to your configured \`.slp\` workflow: \`slp_stage_rework\` or \`slp_approve_stage\`.`;
}

// A coordinator that already holds the goal, roster and earlier reports only needs what changed;
// resending the full briefing each round made its context grow quadratically with every rework.
export function coordinatorReportUpdateBriefing(run: Run, stage: StageState, firstNewReportIndex: number): string {
  const newReports = stage.reports.slice(firstNewReportIndex);
  return [
    `### New Peer Report(s) For Stage '${stage.name}' (${newReports.length} new, ${stage.reports.length} total)`,
    formatStageReports(newReports),
    reworkBudgetLine(run, stage),
    `You already hold this stage's goal ('${stage.goal}'), brief and the earlier reports. ${coordinatorDecisionGuidance(stage)} Call \`slp_get_pipeline\` if you need the full history.`,
  ].join("\n\n");
}

// Inform a surviving Lead when dead peer slots are replaced so direct messages and rework target the new identities.
export function peerRosterUpdateNotice(stage: StageState, revivedPeerIndices: ReadonlySet<number>): string {
  const revivedPeerSummaries = [...revivedPeerIndices].map((peerIndex) => {
    const peerAssignment = stage.peers[peerIndex];
    const replacementPeerAgentId = stage.peerAgentIds[peerIndex];
    return `${peerAssignment.role} (${replacementPeerAgentId})`;
  });
  return `Stage '${stage.name}' revived dead peer session(s): ${revivedPeerSummaries.join(", ")}. Continue coordinating this stage with the updated peer roster.`;
}

// Provide the pipeline's Lead with peer and sibling-Lead contacts so it can merge autonomously and consult on conflicts.
// A QA pipeline already lives on the QA branch, so its closing step is a clean-tree check and the report, never a merge.
function qaPipelineClosingBriefing(run: Run, pipeline: PipelineState): string {
  return [
    `QA pipeline '${pipeline.name}' (${pipeline.id}) completed all stages on the QA branch \`${run.integrationBranch}\` (\`${run.devCwd}\`).`,
    [
      "### Closing Instructions",
      "1. Confirm with slp_get_pipeline that every fix made by your peers is committed; you cannot commit yourself, so send any uncommitted work back with slp_stage_rework before closing.",
      `2. Call \`slp_finalize_pipeline({ pipelineId: "${pipeline.id}", summary })\` to close the QA pipeline (nothing is merged).`,
      "3. Call slp_report with the tested scope, results with metrics, evidence paths and known issues.",
    ].join("\n"),
  ].join("\n\n");
}

export function pipelineFinalizationBriefing(run: Run, pipeline: PipelineState): string {
  if (pipeline.kind === "qa") return qaPipelineClosingBriefing(run, pipeline);
  const pipelinePeerLines = pipeline.stages.flatMap((completedStage) =>
    completedStage.peerAgentIds.flatMap((peerAgentId, peerIndex) => {
      if (!peerAgentId || run.agents[peerAgentId]?.archivedAt) return [];
      const peerAssignment = completedStage.peers[peerIndex];
      return [`- [Stage **${completedStage.name}**] **${peerAssignment?.role ?? "peer"}** (\`${peerAgentId}\`): ${peerAssignment?.task ?? ""}`];
    }),
  );
  // Expose active Leads from sibling pipelines so cross-pipeline merge conflicts and shared contracts can be resolved collaboratively.
  const siblingLeadLines = Object.values(run.pipelines)
    .filter((candidatePipeline) => candidatePipeline.id !== pipeline.id)
    .flatMap((siblingPipeline) => {
      const siblingCoordinatorId =
        (siblingPipeline.leadAgentId && !run.agents[siblingPipeline.leadAgentId]?.archivedAt
          ? siblingPipeline.leadAgentId
          : null) ??
        [...siblingPipeline.stages]
          .reverse()
          .map((siblingStage) => siblingStage.forkedLeadAgentId)
          .find((coordinatorId): coordinatorId is string => Boolean(coordinatorId && !run.agents[coordinatorId]?.archivedAt));
      if (!siblingCoordinatorId) return [];
      return [
        `- Pipeline **${siblingPipeline.name}** (\`${siblingPipeline.id}\`, branch \`${siblingPipeline.branch ?? "n/a"}\`, status \`${siblingPipeline.status}\`): Lead \`${siblingCoordinatorId}\``,
      ];
    });
  const briefingSections = [
    `Pipeline '${pipeline.name}' (${pipeline.id}) completed all stages. You are responsible for verifying and merging its branch into the integration branch.`,
    [
      "### Merge & Finalization Instructions",
      `1. Inspect \`${pipeline.worktree}\` (branch \`${pipeline.branch}\`) and commit any remaining valid stage work so the worktree is clean.`,
      `2. Call \`slp_finalize_pipeline({ pipelineId: "${pipeline.id}", summary })\` with a consolidated summary of all delivered changes and verified metrics to merge \`${pipeline.branch}\` into \`${run.integrationBranch}\` (\`${run.devCwd}\`).`,
      `3. If \`slp_finalize_pipeline\` reports a merge conflict: inspect the conflicting files. If you do not fully understand why a conflicting change was made, ask the responsible **Peer** in this pipeline or the sibling **Lead** of the related feature pipeline via \`slp_ask({ toAgentId, question })\`. Then merge \`${run.integrationBranch}\` into \`${pipeline.branch}\` inside \`${pipeline.worktree}\`, resolve the conflicts cleanly, commit, and call \`slp_finalize_pipeline\` again.`,
    ].join("\n"),
  ];
  if (pipelinePeerLines.length > 0) {
    briefingSections.push(`### Pipeline Peers (Available for Merge/Conflict Questions via slp_ask)\n${pipelinePeerLines.join("\n")}`);
  }
  if (siblingLeadLines.length > 0) {
    briefingSections.push(`### Sibling Pipeline Leads (Available for Cross-Feature Conflict Consultation via slp_ask)\n${siblingLeadLines.join("\n")}`);
  }
  return briefingSections.join("\n\n");
}
