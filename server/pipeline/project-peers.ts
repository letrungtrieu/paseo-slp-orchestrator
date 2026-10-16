// Lead-controlled extra assignments complement the task pipeline without encoding business role kinds in project YAML.
import type { BusCaller } from "../bus/http-mcp";
import type { PeerReportSubmission } from "../../shared/reports";
import { peerRole } from "../project-prompts/defaults";
import { requireTask, tell, updateTask, type PipelineContext } from "./context";
import { ToolError } from "./tool-error";
import type { Run } from "../../shared/state";

export interface SpawnPeerInput {
  taskId?: string;
  role: string;
  brief: string;
  allowWrites: boolean;
}

function activeRun(ctx: PipelineContext, runId: string) {
  const run = ctx.store.require(runId);
  // Planning consultations are allowed, but a finished or presented run must not create fresh work.
  if (!["planning", "running"].includes(run.status)) throw new ToolError(`Run '${runId}' no longer accepts peer assignments.`);
  return run;
}

function activeTask(ctx: PipelineContext, runId: string, taskId: string) {
  const run = activeRun(ctx, runId);
  const task = requireTask(run, taskId);
  // Reports and archived work must not be reopened by a late Lead tool call.
  if (run.status !== "running" || ["merged", "failed"].includes(task.phase)) {
    throw new ToolError(`Task '${taskId}' no longer accepts peer assignments.`);
  }
  return { run, task };
}

function suspendLead(run: Run): string | null {
  const lead = run.agents[run.masterLeadAgentId];
  const continuation = lead?.awaitingTool ?? null;
  // A spawn is a legitimate delegation; suppress idle nudges until evidence is delivered back.
  if (lead) lead.awaitingTool = null;
  return continuation;
}

function resumeLeadTool(run: Run, continuation: string | null): string | null {
  // Another expert may already have supplied enough evidence to advance the run before this report arrives.
  if (continuation === "slp_define_tasks" && run.status !== "planning") return null;
  if (continuation === "slp_archive_task" && !Object.values(run.tasks).some((task) => task.phase === "ready_for_merge")) return null;
  return continuation;
}

export async function spawnProjectPeer(ctx: PipelineContext, runId: string, input: SpawnPeerInput): Promise<string> {
  const run = activeRun(ctx, runId);
  const task = input.taskId ? activeTask(ctx, runId, input.taskId).task : null;
  let definition;
  try { definition = peerRole(run.promptConfig, input.role); }
  catch (roleError) { throw new ToolError(roleError instanceof Error ? roleError.message : String(roleError)); }
  if (task && !task.workspace) throw new ToolError("Wait until the task worktree is ready before spawning additional peers.");
  if (input.allowWrites && (!task || !["implementing", "fixing"].includes(task.phase))) {
    // A Lead assignment must not bypass the handshake or reopen code while reviewers are judging it.
    throw new ToolError("Writable peers require a task in implementing or fixing; use a read-only assignment in other phases.");
  }
  const createdPeer = await ctx.gateway.createAgent({
    runId, role: "peer", projectRole: definition.role, taskId: task?.id ?? null,
    writeScope: input.allowWrites && task ? [...task.writableScope] : [],
    leadContinuationTool: run.agents[run.masterLeadAgentId]?.awaitingTool ?? null,
    provider: run.providers.peer, thinkingOptionId: run.providers.peerThinkingOptionId ?? undefined,
    permissionModeId: run.providers.peerPermissionModeId ?? undefined,
    parentAgentId: run.masterLeadAgentId, workspaceId: task?.workspace?.workspaceId ?? run.devWorkspaceId,
    peerWorktreePath: task?.workspace?.cwd ?? run.devCwd,
    title: `[${definition.name}] [${task ? `${task.id} · ${task.title}` : run.title}]`,
    // The assignment supplies current task authority, while the role's workflow supplies domain-specific steps.
    initialPrompt: `The Lead assigned you project role "${definition.role}" for ${task ? `task "${task.id}"` : "project planning"}.\n${input.brief}\nAccess: ${input.allowWrites ? "write only within the task's writable scope" : "READ-ONLY"}. Read ${task ? "slp_get_task" : "slp_get_run"} and apply your project workflow. Return evidence through slp_peer_report, then end your turn.`,
    awaitTool: "slp_peer_report",
  });
  ctx.store.mutate(runId, (mutableRun) => {
    // Separate identity keys allow several instances of the same business role without replacing a primary participant.
    if (task) mutableRun.tasks[task.id].agentIds[`peer:${createdPeer.agentId}`] = createdPeer.agentId;
    suspendLead(mutableRun);
  });
  return JSON.stringify({ agentId: createdPeer.agentId, role: definition.role, taskId: task?.id ?? null,
    message: "Peer started. End your turn; its report will be delivered to you." });
}

export function promptProjectPeer(ctx: PipelineContext, runId: string, agentId: string, brief: string): string {
  const lookup = ctx.store.findAgent(agentId);
  // Reusing another run's peer would mix requirements and worktree permissions.
  if (!lookup || lookup.run.id !== runId || lookup.agentRecord.role !== "peer") {
    throw new ToolError("Select an additional peer belonging to this run.");
  }
  activeRun(ctx, runId);
  if (lookup.agentRecord.taskId) activeTask(ctx, runId, lookup.agentRecord.taskId);
  ctx.store.mutate(runId, (run) => {
    run.agents[agentId].leadContinuationTool = suspendLead(run);
  });
  tell(ctx, runId, agentId, `${brief}\nReturn findings through slp_peer_report and end your turn.`, {
    taskId: lookup.agentRecord.taskId, awaitTool: "slp_peer_report", from: lookup.run.masterLeadAgentId,
    summary: "additional project peer assignment",
  });
  return "Assignment queued for the peer. End your turn; its report will be delivered to you.";
}

export function reportProjectPeer(ctx: PipelineContext, caller: BusCaller, submission: PeerReportSubmission): string {
  const lookup = ctx.store.findAgent(caller.agentId);
  if (!lookup || lookup.agentRecord.role !== "peer" || lookup.run.id !== caller.runId) {
    throw new ToolError("Only an additional assigned peer can submit this report.");
  }
  const run = activeRun(ctx, caller.runId);
  const task = lookup.agentRecord.taskId ? activeTask(ctx, caller.runId, lookup.agentRecord.taskId).task : null;
  const roleId = lookup.agentRecord.projectRole;
  if (!roleId) throw new ToolError("Peer has no project role.");
  const report = { ...submission, agentId: caller.agentId, role: roleId, submittedAt: new Date().toISOString() };
  if (task) updateTask(ctx, run.id, task.id, (mutableTask) => {
    // Store every follow-up report; later revisions must not erase earlier evidence used by the Lead.
    mutableTask.peerReports.push(report);
  });
  else ctx.store.mutate(run.id, (mutableRun) => {
    // Planning evidence stays available after task definitions are produced from that consultation.
    mutableRun.peerReports.push(report);
  });
  tell(ctx, run.id, run.masterLeadAgentId, `Project peer ${roleId} (${caller.agentId}) reports for ${task ? `task ${task.id}` : "project planning"}:\n${JSON.stringify(report)}\nDecide the next assignment from this evidence.`, {
    taskId: task?.id ?? null, awaitTool: resumeLeadTool(run, lookup.agentRecord.leadContinuationTool),
    from: caller.agentId, summary: `${roleId}: ${submission.status}`,
  });
  return "Report saved and sent to the Lead. End your turn.";
}
