// Every fresh cohort receives the same goal, roster and durable handover before any peer starts work.
import type { PipelineState, StageState } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import type { StagePromptContext } from "../prompts/system-prompts";

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
  const previousStageLines = pipeline.stages.slice(0, pipeline.currentStageIndex).map((previousStage) =>
    `- **${previousStage.name}** (${previousStage.goal}): ${previousStage.result?.summary ?? "Approved"}`,
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
  return sections.join("\n\n");
}

export function peerStageBriefing(run: Run, pipeline: PipelineState, stage: StageState, peerIndex: number): string {
  const assignment = stage.peers[peerIndex];
  // Business roles share authority; none gains a hidden reviewer or primary-implementer position.
  return [
    `You are project peer **${assignment.role}** in stage **${stage.name}**.`,
    `### Your Task\n${assignment.task}`,
    "All stage peers are equal participants. Stay focused on the shared goal. Discuss directly with `slp_send_peer_message`, then submit evidence with `slp_stage_report`. The Forked Lead decides when this stage is complete.",
    stageBriefing(run, pipeline, stage, peerIndex),
  ].join("\n\n");
}

export function coordinatorStageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The coordinator judges the goal; peer report counts and majority votes do not replace that judgment.
  return [
    "You are the **Forked Lead** controlling this stage from its start until closure. Direct peers through `slp_send_peer_message` or `slp_stage_rework`, inspect their evidence and the worktree, and keep them focused on goal. You decide when the result is acceptable with `slp_approve_stage({summary})`. If blocked beyond your authority, use `slp_escalate`. Do not approve merely because peers stopped talking.",
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
  return `${baseBriefing}\n\n### Submitted Stage Peer Reports\n${formattedReports}\n\nCompare this evidence with goal '${stage.goal}'. Direct more work with \`slp_stage_rework\` or approve with \`slp_approve_stage\` when you accept the result.`;
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
