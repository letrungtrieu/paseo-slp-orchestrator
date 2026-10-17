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

export function stageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  const roster = stage.peerAgentIds.map((agentId, peerIndex) => ({
    agentId, role: stage.peers[peerIndex].role, task: stage.peers[peerIndex].task,
  }));
  const previousStages = pipeline.stages.slice(0, pipeline.currentStageIndex).map((previousStage) => ({
    name: previousStage.name, goal: previousStage.goal, result: previousStage.result, reports: previousStage.reports,
  }));
  // Assignments and accepted results are included directly; tools provide the full message history on demand.
  return JSON.stringify({
    pipelineId: pipeline.id, pipeline: pipeline.name, description: pipeline.description,
    worktree: pipeline.worktree, stageId: stage.id, stage: stage.name, goal: stage.goal,
    acceptanceCriteria: run.criteria, forkedLeadAgentId: stage.forkedLeadAgentId, peers: roster,
    previousStageResults: previousStages,
  }, null, 2);
}

export function peerStageBriefing(run: Run, pipeline: PipelineState, stage: StageState, peerIndex: number): string {
  const assignment = stage.peers[peerIndex];
  // Business roles share authority; none gains a hidden reviewer or primary-implementer position.
  return `You are project peer '${assignment.role}' in stage '${stage.name}'.\nYour task: ${assignment.task}\nAll stage peers are equal participants. Stay focused on the shared goal. Discuss directly with slp_send_peer_message, then submit evidence with slp_stage_report. The Forked Lead decides when this stage is complete.\n${stageBriefing(run, pipeline, stage)}`;
}

export function coordinatorStageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The coordinator judges the goal; peer report counts and majority votes do not replace that judgment.
  return `You are the Forked Lead controlling this stage from its start until closure. Direct peers through slp_send_peer_message or slp_stage_rework, inspect their evidence and the worktree, and keep them focused on goal. You decide when the result is acceptable with slp_approve_stage({summary}). If blocked beyond your authority, use slp_escalate. Do not approve merely because peers stopped talking.\n${stageBriefing(run, pipeline, stage)}`;
}

// When a Forked Lead session dies mid-stage after peers already reported, include their saved reports so the replacement can act immediately.
export function coordinatorRevivalBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  const baseBriefing = coordinatorStageBriefing(run, pipeline, stage);
  if (stage.reports.length === 0) return baseBriefing;
  return `${baseBriefing}\n\nSubmitted stage peer reports before coordinator revival:\n${JSON.stringify(stage.reports, null, 2)}\nCompare this evidence with goal '${stage.goal}'. Direct more work with slp_stage_rework or approve with slp_approve_stage when you accept the result.`;
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
