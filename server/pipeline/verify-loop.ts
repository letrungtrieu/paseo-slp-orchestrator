// Verify stages run a fix-and-regrade loop without peer-to-peer chatter: QA peers grade, the Lead decides,
// a fix by the stage's developer automatically triggers a fresh grading pass before the Lead is woken again.
import type { StageState, StoredStageReport } from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import { stageMail } from "./stage-mail";
import { agentPeerKind } from "./stage-shape";

export interface VerifyStageCast {
  developerAgentId: string | null;
  graderAgentIds: string[];
}

// Archived slots are skipped so a regrade never queues mail for a session that can no longer answer.
export function verifyStageCast(run: Run, stage: StageState): VerifyStageCast {
  const cast: VerifyStageCast = { developerAgentId: null, graderAgentIds: [] };
  for (const peerAgentId of stage.peerAgentIds) {
    const peerRecord = peerAgentId ? run.agents[peerAgentId] : undefined;
    if (!peerRecord || peerRecord.archivedAt) continue;
    const peerKind = agentPeerKind(run, peerRecord.projectRole);
    if (peerKind === "qa") cast.graderAgentIds.push(peerAgentId);
    else if (peerKind === "developer") cast.developerAgentId = peerAgentId;
  }
  return cast;
}

// Queued inside the caller's mutation so the fix report and the regrade requests commit together.
export function queueRegrade(mutableRun: Run, stage: StageState, fixReport: StoredStageReport, graderAgentIds: readonly string[]): void {
  for (const graderAgentId of graderAgentIds) {
    mutableRun.mailbox.push(stageMail(graderAgentId, [
      `The developer finished a fix pass in stage '${stage.name}'. Grade every brief criterion again on the current worktree and submit a new scorecard with slp_stage_report.`,
      `Developer's report: ${fixReport.summary}`,
      fixReport.findings.length > 0 ? `Developer's notes:\n${fixReport.findings.map((finding) => `- ${finding}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"), "slp_stage_report"));
  }
}
