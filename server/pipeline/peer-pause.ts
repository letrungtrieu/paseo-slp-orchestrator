// Allows a Lead to immediately pause and resume its child stage peers when Spec or Brief requirements change.
import { randomUUID } from "node:crypto";
import type { BusCaller } from "../bus/http-mcp";
import type { PipelineState, StageState } from "../../shared/pipeline";
import type { AgentRecord, Run } from "../../shared/state";
import type { PipelineContext } from "./context";
import { formatBrief } from "./stage-briefing-sections";
import { requirePipeline } from "./stage-context";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";

export interface PausePeersInput {
  pipelineId?: string;
  peerAgentIds?: string[];
  reason: string;
}

export interface ResumePeersInput {
  pipelineId?: string;
  peerAgentIds?: string[];
  guidance: string;
}

// Resolves the pipeline and active stage owned by the calling Lead (or stage-forked Lead).
function resolveLeadPipelineAndStage(
  run: Run,
  caller: BusCaller,
  explicitPipelineId?: string,
): { pipeline: PipelineState; stage: StageState } {
  const callerRecord = run.agents[caller.agentId];
  // Infer the pipeline from the caller's agent record or stage fork when pipelineId is omitted.
  const resolvedPipelineId =
    explicitPipelineId?.trim()
    || callerRecord?.pipelineId
    || Object.values(run.pipelines).find(
      (candidatePipeline) =>
        candidatePipeline.leadAgentId === caller.agentId
        || candidatePipeline.stages.some((candidateStage) => candidateStage.forkedLeadAgentId === caller.agentId),
    )?.id;
  if (!resolvedPipelineId) {
    throw new ToolError("Specify pipelineId or define a pipeline before managing stage peers.");
  }
  const pipeline = requirePipeline(run, resolvedPipelineId);
  // Enforce pipeline ownership so a feature Lead only pauses its own peers unless it is the run's primary Lead.
  if (
    caller.agentId !== run.masterLeadAgentId
    && pipeline.leadAgentId !== caller.agentId
    && !pipeline.stages.some((candidateStage) => candidateStage.forkedLeadAgentId === caller.agentId)
  ) {
    throw new ToolError(`Lead '${caller.agentId}' does not own pipeline '${pipeline.name}'.`);
  }
  // Target the currently running stage so prior completed stages are never mutated retroactively.
  const currentStage = pipeline.stages[pipeline.currentStageIndex] ?? pipeline.stages.at(-1);
  if (!currentStage) {
    throw new ToolError(`Pipeline '${pipeline.name}' has no active stage.`);
  }
  return { pipeline, stage: currentStage };
}

// Filters and validates the stage peers that the Lead wants to pause or resume.
function selectTargetStagePeers(
  run: Run,
  stage: StageState,
  requestedPeerIds?: readonly string[],
): AgentRecord[] {
  // Default to all peers in the active stage when the Lead does not pass a subset of peerAgentIds.
  const candidateIds = requestedPeerIds && requestedPeerIds.length > 0
    ? requestedPeerIds
    : stage.peerAgentIds.filter(Boolean);
  const resolvedPeers: AgentRecord[] = [];
  for (const peerAgentId of candidateIds) {
    // Prevent a Lead from pausing an unrelated peer belonging to another stage or pipeline.
    if (!stage.peerAgentIds.includes(peerAgentId)) {
      throw new ToolError(`Agent '${peerAgentId}' is not a peer of stage '${stage.name}'.`);
    }
    const peerRecord = run.agents[peerAgentId];
    if (!peerRecord || peerRecord.archivedAt) {
      throw new ToolError(`Peer '${peerAgentId}' is archived or unavailable.`);
    }
    resolvedPeers.push(peerRecord);
  }
  if (resolvedPeers.length === 0) {
    throw new ToolError(`Stage '${stage.name}' has no active peers to manage.`);
  }
  return resolvedPeers;
}

// Immediately pauses child stage peers, locks their write permissions, and preempts their active SDK turn.
export async function pauseStagePeers(
  ctx: PipelineContext,
  caller: BusCaller,
  input: PausePeersInput,
): Promise<string> {
  const initialRun = ctx.store.require(caller.runId);
  const { pipeline, stage } = resolveLeadPipelineAndStage(initialRun, caller, input.pipelineId);
  const targetPeers = selectTargetStagePeers(initialRun, stage, input.peerAgentIds);
  const pausedTimestamp = new Date().toISOString();
  const pauseReason = input.reason.trim();

  ctx.store.mutate(initialRun.id, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipeline.id);
    const mutableStage = mutablePipeline.stages[mutablePipeline.currentStageIndex] ?? mutablePipeline.stages.at(-1);
    for (const targetPeer of targetPeers) {
      const mutablePeer = mutableRun.agents[targetPeer.agentId];
      if (!mutablePeer) continue;
      // Setting pausedAt immediately revokes file-write and mutating-shell permissions in permission-handler.ts.
      mutablePeer.pausedAt = pausedTimestamp;
      mutablePeer.pausedReason = pauseReason;
      // Clear awaitingTool so lifecycle hooks do not nudge a peer that the Lead intentionally paused.
      mutablePeer.awaitingTool = null;
      mutablePeer.awaitingSince = null;
      mutablePeer.nudges = 0;
      mutableStage?.messages.push({
        id: randomUUID(),
        fromAgentId: caller.agentId,
        toAgentId: targetPeer.agentId,
        message: `[PAUSED BY LEAD] ${pauseReason}`,
        createdAt: pausedTimestamp,
      });
    }
    // Remove undelivered stage assignments for paused peers so the mailbox does not wake them prematurely.
    const pausedIdSet = new Set(targetPeers.map((peer) => peer.agentId));
    mutableRun.mailbox = mutableRun.mailbox.filter((queuedMail) => !pausedIdSet.has(queuedMail.toAgentId));
  });

  // Interrupt any currently executing turn or shell on each paused peer via Paseo's prompt preemption.
  for (const targetPeer of targetPeers) {
    const interruptMessage = [
      `## Work Paused by Lead (\`${caller.agentId}\`)`,
      `- **Reason**: ${pauseReason}`,
      "Stop all file edits and shell commands immediately and end your turn. Wait until your Lead updates the Brief and resumes your assignment.",
    ].join("\n");
    await ctx.gateway.prompt(targetPeer.agentId, interruptMessage).catch(() => undefined);
  }

  // Record the pause event in the run audit log so the human operator sees when and why peers were stopped.
  ctx.logEvent(initialRun.id, {
    taskId: pipeline.id,
    from: caller.agentId,
    to: "pipeline",
    kind: "peers.paused",
    summary: `Paused ${targetPeers.length} peer(s) in ${pipeline.name}/${stage.name}: ${pauseReason}`,
    outcome: "delivered",
  });

  return `Paused ${targetPeers.length} peer(s) (${targetPeers.map((peer) => peer.agentId).join(", ")}). Their active turns were interrupted and write permissions are locked until you call slp_resume_peers.`;
}

// Restores write permissions for paused child peers and wakes them with the updated Brief diff and Lead guidance.
export function resumeStagePeers(
  ctx: PipelineContext,
  caller: BusCaller,
  input: ResumePeersInput,
): string {
  const initialRun = ctx.store.require(caller.runId);
  const { pipeline, stage } = resolveLeadPipelineAndStage(initialRun, caller, input.pipelineId);
  const targetPeers = selectTargetStagePeers(initialRun, stage, input.peerAgentIds);
  const resumedTimestamp = new Date().toISOString();
  const resumeGuidance = input.guidance.trim();
  // Include the latest Brief diff in the resume message so peers immediately see what changed in the contract.
  const linkedBoardTicket = ctx.store.board.findByPipeline(pipeline.id);
  const latestBriefDiff = linkedBoardTicket?.briefRevisions.at(-1)?.diff ?? "";

  ctx.store.mutate(initialRun.id, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, pipeline.id);
    const mutableStage = mutablePipeline.stages[mutablePipeline.currentStageIndex] ?? mutablePipeline.stages.at(-1);
    for (const targetPeer of targetPeers) {
      const mutablePeer = mutableRun.agents[targetPeer.agentId];
      if (!mutablePeer) continue;
      // Clearing pausedAt restores write permissions and allows the mailbox to deliver the updated assignment.
      mutablePeer.pausedAt = null;
      mutablePeer.pausedReason = null;
      mutableStage?.messages.push({
        id: randomUUID(),
        fromAgentId: caller.agentId,
        toAgentId: targetPeer.agentId,
        message: `[RESUMED BY LEAD] ${resumeGuidance}`,
        createdAt: resumedTimestamp,
      });
      const resumeMailSections = [
        `## Work Resumed by Lead (\`${caller.agentId}\`) — Stage '${stage.name}'`,
        `### Lead Guidance\n${resumeGuidance}`,
        linkedBoardTicket
          ? `### Kanban Ticket \`${linkedBoardTicket.ticketKey}\` (Spec v${linkedBoardTicket.currentSpecRev} · Brief v${linkedBoardTicket.currentBriefRev})\nCall \`slp_board_get_ticket({ ticketId: "${linkedBoardTicket.ticketKey}" })\` to inspect all brief bullets.`
          : "",
        latestBriefDiff ? `### Latest Brief Diff\n\`\`\`diff\n${latestBriefDiff}\n\`\`\`` : "",
        mutablePipeline.brief ? `### Current Brief\n${formatBrief(mutablePipeline.brief)}` : "",
        "Continue your work according to the updated Brief and submit your results with `slp_stage_report`.",
      ].filter(Boolean);
      // Enqueue a stage assignment expecting slp_stage_report so the peer re-enters normal stage tracking.
      mutableRun.mailbox.push(
        stageMail(targetPeer.agentId, resumeMailSections.join("\n\n"), "slp_stage_report"),
      );
    }
  });

  // Log the resume action so the audit trail pairs every peer pause with its corresponding resumption.
  ctx.logEvent(initialRun.id, {
    taskId: pipeline.id,
    from: caller.agentId,
    to: "pipeline",
    kind: "peers.resumed",
    summary: `Resumed ${targetPeers.length} peer(s) in ${pipeline.name}/${stage.name}`,
    outcome: "queued",
  });

  return `Resumed ${targetPeers.length} peer(s) (${targetPeers.map((peer) => peer.agentId).join(", ")}) with updated guidance. End your turn while they continue.`;
}
