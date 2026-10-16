// Run-scoped projections expose task knowledge without leaking mailbox contents or agent credentials.
import type { BusCaller } from "../bus/http-mcp";
import type { TaskPhase } from "../../shared/state";
import { requireTask, type PipelineContext } from "./context";
import { ToolError } from "./tool-error";
import { defaultProjectPrompts } from "../project-prompts/defaults";

export function readRun(ctx: PipelineContext, caller: BusCaller): string {
  const run = ctx.store.require(caller.runId);
  // Select explicit fields: returning the raw run would disclose other agents' authentication tokens.
  return JSON.stringify({
    id: run.id, title: run.title, status: run.status, mode: run.mode,
    criteria: run.criteria, masterSpec: run.masterSpec,
    repoPath: run.repoPath, baseBranch: run.baseBranch, integrationBranch: run.integrationBranch,
    taskCount: Object.keys(run.tasks).length, finalReport: run.finalReport, supervisorReport: run.supervisorReport,
  });
}

export function listTasks(ctx: PipelineContext, caller: BusCaller, filter: { phase?: TaskPhase; limit: number; offset: number }): string {
  const matchingTasks = Object.values(ctx.store.require(caller.runId).tasks)
    .filter((task) => !filter.phase || task.phase === filter.phase);
  // Summaries keep broad coordination cheap; the detail tool carries a selected task's full context.
  return JSON.stringify({
    total: matchingTasks.length,
    tasks: matchingTasks.slice(filter.offset, filter.offset + filter.limit).map((task) => ({
      id: task.id, title: task.title, phase: task.phase, writableScope: task.writableScope,
      workspace: task.workspace, hasAcceptanceReport: task.acceptanceReport !== null,
    })),
  });
}

function requestedTaskId(caller: BusCaller, taskId?: string): string {
  const selectedTaskId = taskId ?? caller.taskId;
  // A Supervisor has no implicit task, so guessing one could return the wrong worktree's instructions.
  if (!selectedTaskId) throw new ToolError("Provide taskId, or use slp_list_tasks to find one.");
  return selectedTaskId;
}

export function readTask(ctx: PipelineContext, caller: BusCaller, taskId?: string): string {
  return JSON.stringify(requireTask(ctx.store.require(caller.runId), requestedTaskId(caller, taskId)));
}

export function readReport(ctx: PipelineContext, caller: BusCaller, taskId?: string): string {
  const run = ctx.store.require(caller.runId);
  const selectedTaskId = taskId ?? caller.taskId;
  // Run-level callers get the integration review; task peers naturally get their own acceptance report.
  if (!selectedTaskId) return JSON.stringify({ finalReport: run.finalReport, supervisorReport: run.supervisorReport, peerReports: run.peerReports });
  const task = requireTask(run, selectedTaskId);
  return JSON.stringify({ taskId: task.id, implementationSummary: task.implementationSummary,
    acceptanceReport: task.acceptanceReport, reviewVerdicts: task.roundVerdicts, peerReports: task.peerReports });
}

export function listPeerRoles(ctx: PipelineContext, caller: BusCaller): string {
  const configuration = ctx.store.require(caller.runId).promptConfig ?? defaultProjectPrompts();
  // Discovery exposes metadata only; the workflow body is injected into the peer that actually receives the assignment.
  return JSON.stringify({ peers: configuration.peers.map(({ role, name, description, model, thinking, frontMatter, sourcePath }) =>
    ({ role, name, description, model, thinking, frontMatter, sourcePath })) });
}
