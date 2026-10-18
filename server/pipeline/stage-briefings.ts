// Every fresh cohort receives the same goal, roster and durable handover before any peer starts work.
import type { PipelineState, StageState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { isDeveloperProjectRole, type StagePromptContext } from "../prompts/system-prompts";

export function stagePromptContext(pipeline: PipelineState, stage: StageState, task: string): StagePromptContext {
  // The goal and assignment are system context even before the final roster is activated through the mailbox.
  return { pipelineId: pipeline.id, pipelineName: pipeline.name, stageId: stage.id, stageName: stage.name,
    goal: stage.goal, task, worktree: pipeline.worktree,
    peerRoster: stage.peers.map(({ role, task }) => ({ role, task })),
    priorResults: pipeline.stages.slice(0, pipeline.currentStageIndex).map((previousStage) =>
      `${previousStage.name}: ${previousStage.result?.summary ?? ""}`),
    history: stage.messages.map((message) => `${message.fromAgentId} -> ${message.toAgentId}: ${message.message}`) };
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
  // Expose live peers from earlier completed stages so downstream peers can directly question them via slp_send_peer_message.
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
  const sections = [
    [
      "### Stage Context",
      `- **Pipeline**: ${pipeline.name} (\`${pipeline.id}\`) — ${pipeline.description}`,
      `- **Stage**: ${stage.name} (\`${stage.id}\`)`,
      `- **Worktree**: \`${pipeline.worktree}\``,
      `- **Stage Goal**: ${stage.goal}`,
      `- **Forked Lead (Coordinator)**: \`${stage.forkedLeadAgentId ?? "pending"}\``,
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
      `### Prior Stage Peers (Available for Cross-Stage Questions via slp_send_peer_message)\n${priorStagePeerLines.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export function peerStageBriefing(run: Run, pipeline: PipelineState, stage: StageState, peerIndex: number): string {
  const assignment = stage.peers[peerIndex];
  const hasPriorStagePeers = pipeline.currentStageIndex > 0;
  const crossStageHint = hasPriorStagePeers
    ? " Peers from earlier stages remain active in this pipeline—if you need clarification on upstream logic or assumptions, message them directly via `slp_send_peer_message` using their IDs from **Prior Stage Peers**."
    : "";
  // Tailor collaboration instructions so a single peer does not waste a turn looking for sibling peers to message.
  const coordinationGuidance = stage.peers.length === 1
    ? `You are the sole peer in this stage.${crossStageHint} Complete your task in the worktree and submit evidence with \`slp_stage_report\` (or use \`slp_escalate\` if blocked). Your session stays alive until the pipeline is merged into the integration branch so downstream stage peers or the Forked Lead (during merge conflict resolution) can message you. The Forked Lead decides when this stage is complete.`
    : `All stage peers are equal participants. Stay focused on the shared goal. Discuss directly with current-stage or prior-stage peers via \`slp_send_peer_message\` when needed, then submit evidence with \`slp_stage_report\`. Your session stays alive until the pipeline is merged into the integration branch so downstream stage peers or the Forked Lead (during merge conflict resolution) can message you. The Forked Lead decides when this stage is complete.`;
  const developerMethodologySuffix = isDeveloperProjectRole(assignment.role)
    ? " As a developer peer, you MUST also present your methodological argument and rejected alternatives step-by-step with metrics (e.g., \"I used technique A to solve problem B; with input data C, it produced output D in time/complexity E. I did not use technique F because G...\")."
    : "";
  const metricsRule = `**Mandatory Technical Reporting Rule**: Present all messages and \`slp_stage_report\` evidence with concrete metrics: for each function/feature, state (1) the exact logic, (2) expected inputs, and (3) expected output values/metrics (or the exact observable runtime outcome if non-numeric).${developerMethodologySuffix}`;
  return [
    `You are project peer **${assignment.role}** in stage **${stage.name}**.`,
    `### Your Task\n${assignment.task}`,
    coordinationGuidance,
    metricsRule,
    stageBriefing(run, pipeline, stage, peerIndex),
  ].join("\n\n");
}

export function coordinatorStageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The coordinator judges the goal; peer report counts and majority votes do not replace that judgment.
  return [
    "You are the **Forked Lead** controlling this stage from its start until closure. Direct peers through `slp_send_peer_message` or `slp_stage_rework`, inspect their evidence and the worktree, and keep them focused on goal. Rigorously audit peer metrics (exact logic, expected inputs, expected outputs/outcomes) against the stage goal: verify there is no missing or redundant data, no system garbage/bloat, and that every generated data structure or artifact is strictly necessary to solve the problem. You decide when the result is acceptable with `slp_approve_stage({summary})`. If blocked beyond your authority, use `slp_escalate`. Do not approve merely because peers stopped talking.",
    stageBriefing(run, pipeline, stage),
  ].join("\n\n");
}

// When a Forked Lead session dies mid-stage after peers already reported, include their saved reports so the replacement can act immediately.
export function coordinatorRevivalBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  const baseBriefing = coordinatorStageBriefing(run, pipeline, stage);
  if (stage.reports.length === 0) return baseBriefing;
  const formattedReports = stage.reports.map((peerReport) => {
    const findingsText = peerReport.findings.length > 0
      ? `\n  Findings:\n${peerReport.findings.map((finding) => `  - ${finding}`).join("\n")}`
      : "";
    return `- **${peerReport.role}** (\`${peerReport.agentId}\`) [${peerReport.status}]: ${peerReport.summary}${findingsText}`;
  }).join("\n");
  return `${baseBriefing}\n\n### Submitted Stage Peer Reports\n${formattedReports}\n\nAudit the reported metrics (logic, expected inputs, expected outputs/outcomes) against goal '${stage.goal}', verify there is no missing/redundant data or system garbage/bloat, and confirm every added element is strictly necessary. Direct more work with \`slp_stage_rework\` or approve with \`slp_approve_stage\` when you accept the result.`;
}

// Inform a surviving Forked Lead when dead peer slots are replaced so direct messages and rework target the new identities.
export function peerRosterUpdateNotice(stage: StageState, revivedPeerIndices: ReadonlySet<number>): string {
  const revivedPeerSummaries = [...revivedPeerIndices].map((peerIndex) => {
    const peerAssignment = stage.peers[peerIndex];
    const replacementPeerAgentId = stage.peerAgentIds[peerIndex];
    return `${peerAssignment.role} (${replacementPeerAgentId})`;
  });
  return `Stage '${stage.name}' revived dead peer session(s): ${revivedPeerSummaries.join(", ")}. Continue coordinating this stage with the updated peer roster.`;
}

// Provide the final Forked Lead with peer and sibling-Forked-Lead contacts so it can merge autonomously and consult on conflicts.
export function pipelineFinalizationBriefing(run: Run, pipeline: PipelineState): string {
  const pipelinePeerLines = pipeline.stages.flatMap((completedStage) =>
    completedStage.peerAgentIds.flatMap((peerAgentId, peerIndex) => {
      if (!peerAgentId || run.agents[peerAgentId]?.archivedAt) return [];
      const peerAssignment = completedStage.peers[peerIndex];
      return [`- [Stage **${completedStage.name}**] **${peerAssignment?.role ?? "peer"}** (\`${peerAgentId}\`): ${peerAssignment?.task ?? ""}`];
    }),
  );
  // Expose active Forked Leads from sibling pipelines so cross-pipeline merge conflicts can be resolved collaboratively.
  const siblingForkedLeadLines = Object.values(run.pipelines)
    .filter((candidatePipeline) => candidatePipeline.id !== pipeline.id)
    .flatMap((siblingPipeline) => {
      const siblingCoordinatorId = [...siblingPipeline.stages]
        .reverse()
        .map((siblingStage) => siblingStage.forkedLeadAgentId)
        .find((coordinatorId): coordinatorId is string => Boolean(coordinatorId && !run.agents[coordinatorId]?.archivedAt));
      if (!siblingCoordinatorId) return [];
      return [
        `- Pipeline **${siblingPipeline.name}** (\`${siblingPipeline.id}\`, branch \`${siblingPipeline.branch ?? "n/a"}\`, status \`${siblingPipeline.status}\`): Forked Lead \`${siblingCoordinatorId}\``,
      ];
    });
  const briefingSections = [
    `Pipeline '${pipeline.name}' (${pipeline.id}) completed all stages. You are responsible for verifying and merging its branch into the integration branch.`,
    [
      "### Merge & Finalization Instructions",
      `1. Inspect \`${pipeline.worktree}\` (branch \`${pipeline.branch}\`) and commit any remaining valid stage work so the worktree is clean.`,
      `2. Call \`slp_finalize_pipeline({ pipelineId: "${pipeline.id}", summary })\` with a consolidated summary of all delivered changes and verified metrics to merge \`${pipeline.branch}\` into \`${run.integrationBranch}\` (\`${run.devCwd}\`).`,
      `3. If \`slp_finalize_pipeline\` reports a merge conflict: inspect the conflicting files. If you do not fully understand why a conflicting change was made, message the responsible **Peer** in this pipeline or the sibling **Forked Lead** of the related feature pipeline via \`slp_send_peer_message({ toAgentId, message, waitForReply: true })\`. Then merge \`${run.integrationBranch}\` into \`${pipeline.branch}\` inside \`${pipeline.worktree}\`, resolve the conflicts cleanly, commit, and call \`slp_finalize_pipeline\` again.`,
    ].join("\n"),
  ];
  if (pipelinePeerLines.length > 0) {
    briefingSections.push(`### Pipeline Peers (Available for Merge/Conflict Questions via slp_send_peer_message)\n${pipelinePeerLines.join("\n")}`);
  }
  if (siblingForkedLeadLines.length > 0) {
    briefingSections.push(`### Sibling Pipeline Forked Leads (Available for Cross-Feature Conflict Consultation via slp_send_peer_message)\n${siblingForkedLeadLines.join("\n")}`);
  }
  return briefingSections.join("\n\n");
}
