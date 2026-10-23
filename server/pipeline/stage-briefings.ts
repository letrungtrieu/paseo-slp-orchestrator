// Every fresh cohort receives the same goal, roster and durable handover before any peer starts work.
import type { PipelineState, StageState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import type { StagePromptContext } from "../prompts/system-prompts";

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

export function stageBriefing(run: Run, pipeline: PipelineState, stage: StageState, currentPeerIndex?: number): string {
  // Format roster and prior stage outcomes as readable Markdown instead of raw JSON so prompts remain easy to scan in chat.
  const rosterLines = stage.peerAgentIds.map((agentId, peerIndex) => {
    const peerAssignment = stage.peers[peerIndex];
    if (peerIndex === currentPeerIndex) {
      return `- **${peerAssignment.role}** (\`${agentId}\` — you)`;
    }
    return `- **${peerAssignment.role}** (\`${agentId}\`): ${peerAssignment.task}`;
  });
  const completedStages = pipeline.stages.slice(0, pipeline.currentStageIndex);
  const previousStageLines = completedStages.map((previousStage) =>
    `- **${previousStage.name}** (${previousStage.goal}): ${previousStage.result?.summary ?? "Approved"}`,
  );
  // Expose live peers from earlier completed stages so downstream peers can directly question them via slp_ask.
  const priorStagePeerLines = completedStages.flatMap((previousStage) =>
    previousStage.peerAgentIds.flatMap((priorPeerAgentId, priorPeerIndex) => {
      if (!priorPeerAgentId || run.agents[priorPeerAgentId]?.archivedAt) return [];
      const priorAssignment = previousStage.peers[priorPeerIndex];
      const latestPeerReport = [...previousStage.reports]
        .reverse()
        .find((reportEntry) => reportEntry.agentId === priorPeerAgentId);
      const reportSummarySuffix = latestPeerReport ? ` — Latest report: ${latestPeerReport.summary}` : "";
      return [
        `- [Stage **${previousStage.name}**] **${priorAssignment?.role ?? "peer"}** (\`${priorPeerAgentId}\`): ${priorAssignment?.task ?? ""}${reportSummarySuffix}`,
      ];
    }),
  );
  const owningLeadId = stage.forkedLeadAgentId ?? pipeline.leadAgentId ?? "pending";
  const sections = [
    [
      "### Stage Context",
      `- **Pipeline**: ${pipeline.name} (\`${pipeline.id}\`) — ${pipeline.description}`,
      `- **Stage**: ${stage.name} (\`${stage.id}\`)`,
      `- **Worktree**: \`${pipeline.worktree}\``,
      `- **Stage Goal**: ${stage.goal}`,
      `- **Lead (Coordinator)**: \`${owningLeadId}\``,
    ].join("\n"),
    `### Stage Peer Roster\n${rosterLines.join("\n")}`,
  ];
  if (run.criteria) {
    sections.push(`### Overall Acceptance Criteria\n${run.criteria}`);
  }
  if (previousStageLines.length > 0) {
    sections.push(`### Previous Stage Results\n${previousStageLines.join("\n")}`);
  }
  if (priorStagePeerLines.length > 0) {
    sections.push(
      `### Prior Stage Peers (Available for Cross-Stage Questions via slp_ask)\n${priorStagePeerLines.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export function peerStageBriefing(run: Run, pipeline: PipelineState, stage: StageState, peerIndex: number): string {
  const assignment = stage.peers[peerIndex];
  const hasPriorStagePeers = pipeline.currentStageIndex > 0;
  const crossStageHint = hasPriorStagePeers
    ? " Peers from earlier stages remain active in this pipeline—if you need clarification on upstream logic or assumptions, ask them directly via `slp_ask` using their IDs from **Prior Stage Peers**."
    : "";
  // Tailor collaboration instructions so a single peer does not waste a turn looking for sibling peers to message.
  const coordinationGuidance = stage.peers.length === 1
    ? `You are the sole peer in this stage.${crossStageHint} Apply your configured \`.slp\` workflow in the worktree and submit evidence with \`slp_stage_report\` (or use \`slp_escalate\` if blocked). The Lead decides when this stage is complete.`
    : `All stage peers are equal participants. Stay focused on the shared goal, collaborate with current-stage or prior-stage peers via \`slp_ask\` (needs an answer) or \`slp_notify\` (information only) when needed, apply your configured \`.slp\` workflow, and submit evidence with \`slp_stage_report\`. The Lead decides when this stage is complete.`;
  return [
    `You are project peer **${assignment.role}** in stage **${stage.name}**.`,
    `### Your Task\n${assignment.task}`,
    coordinationGuidance,
    stageBriefing(run, pipeline, stage, peerIndex),
  ].join("\n\n");
}

export function coordinatorStageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The Lead judges the goal according to its configured .slp/LEAD.md workflow.
  return [
    "You are the **Lead** controlling this stage from its start until closure. Apply your configured `.slp` workflow to direct peers through `slp_ask`, `slp_notify` or `slp_stage_rework`, inspect their evidence and the worktree, and decide when the result is acceptable with `slp_approve_stage({summary})` (or use `slp_escalate` if blocked beyond your authority).",
    stageBriefing(run, pipeline, stage),
  ].join("\n\n");
}

function formatStageReports(reports: StageState["reports"]): string {
  return reports.map((peerReport) => {
    const findingsText = peerReport.findings.length > 0
      ? `\n  Findings:\n${peerReport.findings.map((finding) => `  - ${finding}`).join("\n")}`
      : "";
    return `- **${peerReport.role}** (\`${peerReport.agentId}\`) [${peerReport.status}]: ${peerReport.summary}${findingsText}`;
  }).join("\n");
}

// When a Lead session dies mid-stage after peers already reported, include their saved reports so the replacement can act immediately.
export function coordinatorRevivalBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  const baseBriefing = coordinatorStageBriefing(run, pipeline, stage);
  if (stage.reports.length === 0) return baseBriefing;
  return `${baseBriefing}\n\n### Submitted Stage Peer Reports\n${formatStageReports(stage.reports)}\n\nReview the submitted reports against goal '${stage.goal}' according to your configured \`.slp\` workflow. Direct more work with \`slp_stage_rework\` or approve with \`slp_approve_stage\` when you accept the result.`;
}

// A coordinator that already holds the goal, roster and earlier reports only needs what changed;
// resending the full briefing each round made its context grow quadratically with every rework.
export function coordinatorReportUpdateBriefing(stage: StageState, firstNewReportIndex: number): string {
  const newReports = stage.reports.slice(firstNewReportIndex);
  return [
    `### New Peer Report(s) For Stage '${stage.name}' (${newReports.length} new, ${stage.reports.length} total)`,
    formatStageReports(newReports),
    `You already hold this stage's goal ('${stage.goal}'), roster and the earlier reports. Judge the new evidence against that goal according to your configured \`.slp\` workflow, then direct more work with \`slp_stage_rework\` or approve with \`slp_approve_stage\`. Call \`slp_get_pipeline\` if you need the full report history.`,
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
