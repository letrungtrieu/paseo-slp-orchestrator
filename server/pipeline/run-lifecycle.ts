// Run level flow: start a run (spec phase 1), hand criteria to the Master Lead, accept the task
// split, report upward, and the Supreme Manager's final merge into the base branch.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RunMode } from "../../shared/roles";
import type { ProviderChoices, Run, TaskDefinition } from "../../shared/state";
import { assertGitRepository, currentBranchName, excludeFromGit, mergeIntegrationIntoBase } from "../git/git";
import { findScopeOverlaps } from "../git/scope";
import { createIntegrationWorkspace, openSupervisorWorkspace } from "../git/worktree";
import {
  delegationMessage,
  masterLeadBriefing,
  reportForSupervisor,
  reworkNotice,
  supervisorBriefing,
} from "../prompts/messages";
import { archiveAgentLogged, tell, type PipelineContext } from "./context";
import { approveGate } from "./gates";
import { registerTasks, startQueuedTasks } from "./task-start";
import { ToolError } from "./tool-error";

export const DEFAULT_PROVIDER = "claude/claude-sonnet-5-5";

export interface StartRunInput {
  repoPath: string;
  title?: string;
  baseBranch?: string;
  mode: RunMode;
  providers: Partial<ProviderChoices>;
}

export async function startRun(ctx: PipelineContext, input: StartRunInput) {
  await assertGitRepository(input.repoPath);
  // Fail before creating anything: a non-repo path would otherwise leave orphan workspaces behind.
  const baseBranch = input.baseBranch ?? (await currentBranchName(input.repoPath));
  const runId = randomUUID();
  // Branch names use the short run id so concurrent runs on one repo never collide on slp/<run>/dev.
  const run: Pick<Run, "repoPath" | "baseBranch" | "integrationBranch" | "title"> = {
    repoPath: input.repoPath,
    baseBranch,
    integrationBranch: `slp/${runId.slice(0, 8)}/dev`,
    title: input.title?.trim() || `SLP ${runId.slice(0, 8)}`,
  };
  // keep pipeline files out of every worktree of this repo so they never reach a merge commit
  await excludeFromGit(input.repoPath, [".slp/", "/TASK_SPEC.md"]);
  // The SDK handle is only captured once a hook or RPC handler has run, so every entry point waits on the holder.
  const paseo = await ctx.holder.get();
  // The Supervisor works in the user's own checkout; only the Master Lead gets an isolated integration worktree.
  const supervisorWorkspace = await openSupervisorWorkspace(paseo, input.repoPath);
  const integrationWorkspace = await createIntegrationWorkspace(paseo, run);
  const now = new Date().toISOString();
  // Each role can use a different provider so the user can mix cheap peers with a strong Supervisor.
  const providers: ProviderChoices = {
    supervisor: input.providers.supervisor ?? DEFAULT_PROVIDER,
    lead: input.providers.lead ?? DEFAULT_PROVIDER,
    peer: input.providers.peer ?? DEFAULT_PROVIDER,
  };
  // agent ids are filled in below; the record must exist first because creating an agent writes into it
  ctx.store.insert({
    id: runId,
    ...run,
    mode: input.mode,
    status: "initializing",
    providers,
    criteria: null,
    masterSpecPath: join(integrationWorkspace.cwd, ".slp", "MASTER_SPEC.md"),
    supervisorAgentId: "",
    supervisorWorkspaceId: supervisorWorkspace.workspaceId,
    masterLeadAgentId: "",
    devWorkspaceId: integrationWorkspace.workspaceId,
    devCwd: integrationWorkspace.cwd,
    tasks: {},
    agents: {},
    mailbox: [],
    questions: [],
    gate: null,
    finalReport: null,
    forkDegradedReason: null,
    createdAt: now,
    updatedAt: now,
  });
  // The Master Lead goes first because its bus token and agent id must exist before the Supervisor can delegate to it.
  const masterLead = await ctx.gateway.createAgent({
    runId,
    role: "master_lead",
    taskId: null,
    provider: providers.lead,
    workspaceId: integrationWorkspace.workspaceId,
    title: `[SLP] Master Lead: ${run.title}`,
    initialPrompt: masterLeadBriefing(integrationWorkspace.cwd),
    awaitTool: null,
  });
  const supervisor = await ctx.gateway.createAgent({
    runId,
    role: "supervisor",
    taskId: null,
    provider: providers.supervisor,
    workspaceId: supervisorWorkspace.workspaceId,
    title: `[SLP] Supervisor: ${run.title}`,
    initialPrompt: supervisorBriefing(),
    awaitTool: null,
  });
  // Ids are written back only after both agents exist; 'delegating' is the signal that slp_delegate is now legal.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterLeadAgentId = masterLead.agentId;
    mutableRun.supervisorAgentId = supervisor.agentId;
    mutableRun.status = "delegating";
  });
  ctx.logEvent(runId, { taskId: null, from: "manager", to: supervisor.agentId, kind: "run.started", summary: `${run.title} (${input.mode})`, outcome: "info" });
  return { runId, supervisorAgentId: supervisor.agentId, supervisorWorkspaceId: supervisorWorkspace.workspaceId };
}

export function delegate(ctx: PipelineContext, runId: string, acceptanceCriteria: string): string {
  const run = ctx.store.require(runId);
  // Delegating twice would reset the Master Lead mid-plan; later changes must go through the rework path.
  if (run.criteria !== null && run.status !== "delegating") {
    throw new ToolError("The project was already delegated. Use slp_request_rework for changes.");
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.criteria = acceptanceCriteria;
    mutableRun.status = "planning";
  });
  tell(ctx, runId, run.masterLeadAgentId, delegationMessage(acceptanceCriteria, run.masterSpecPath ?? ".slp/MASTER_SPEC.md"), {
    taskId: null,
    awaitTool: "slp_define_tasks",
    from: run.supervisorAgentId,
    summary: "project delegated",
  });
  return "Delegated to the Master Lead. Tell the Supreme Manager in Vietnamese that work has started, then end your turn.";
}

export function defineTasks(ctx: PipelineContext, runId: string, masterSpecPath: string, tasks: TaskDefinition[]): string {
  const run = ctx.store.require(runId);
  const taskIds = tasks.map((task) => task.id);
  // Checks both duplicates inside this batch and collisions with tasks from an earlier define call.
  const duplicateId = taskIds.find((id, index) => taskIds.indexOf(id) !== index || run.tasks[id]);
  if (duplicateId) throw new ToolError(`Task id '${duplicateId}' is duplicated or already exists.`);
  // Overlapping writable scopes would make parallel worktrees conflict at merge time, so reject the split up front.
  const overlaps = findScopeOverlaps(tasks);
  if (overlaps.length > 0) {
    throw new ToolError(`Writable scopes overlap (${overlaps.join("; ")}). Make scopes disjoint and call slp_define_tasks again.`);
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterSpecPath = masterSpecPath;
  });
  registerTasks(ctx, runId, tasks);
  // detached: the fork waits for this very turn to end, so the tool call must return first
  void startQueuedTasks(ctx, runId).catch((startError) => {
    const failureReason = startError instanceof Error ? startError.message : String(startError);
    ctx.logEvent(runId, { taskId: null, from: "pipeline", to: "-", kind: "run.start_tasks_failed", summary: failureReason, outcome: "error" });
  });
  return `${tasks.length} task(s) registered. Worktrees and peers are being prepared. End your turn.`;
}

export function report(ctx: PipelineContext, runId: string, summary: string, docPaths: string[]): string {
  // Reporting moves the run to the Supervisor's audit; the Master Lead's turn ends right after this call.
  const run = ctx.store.require(runId);
  // a late duplicate report must not pull a run back from the Supreme Manager's approval screen
  if (run.status === "awaiting_user" || run.status === "completed" || run.status === "aborted") {
    throw new ToolError(`The run is already '${run.status}'; no further report is needed.`);
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.finalReport = summary;
    mutableRun.status = "reporting";
  });
  tell(ctx, runId, run.supervisorAgentId, reportForSupervisor(summary, docPaths, run.baseBranch, run.integrationBranch), {
    taskId: null,
    awaitTool: null,
    from: run.masterLeadAgentId,
    summary: "final report",
  });
  return "Report sent to the Supervisor. End your turn.";
}

export function requestRework(ctx: PipelineContext, runId: string, feedback: string): string {
  const run = ctx.store.require(runId);
  // Rework re-enters 'running' so task events and sweeper restarts are treated as live again.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "running";
  });
  tell(ctx, runId, run.masterLeadAgentId, reworkNotice(feedback), {
    taskId: null,
    awaitTool: "slp_report",
    from: run.supervisorAgentId,
    summary: "rework requested",
  });
  return "Sent back to the Master Lead. End your turn.";
}

export function presentToManager(ctx: PipelineContext, runId: string): string {
  // spec phase 6: only a Master Lead report under audit can be presented
  if (ctx.store.require(runId).status !== "reporting") {
    throw new ToolError("There is no Master Lead report to present yet.");
  }
  // Status flips before the gate opens so the UI never shows a gate on a run that is not awaiting the user.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "awaiting_user";
  });
  // the gate is always required: the Supreme Manager alone merges into the base branch
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.gate = {
      kind: "final_approval",
      openedAt: new Date().toISOString(),
      note: "Result verified by the Supervisor. Approve to merge into the base branch.",
    };
  });
  return "Result presented. Give the Supreme Manager your short Vietnamese report in chat, then end your turn.";
}

export async function approveMain(ctx: PipelineContext, runId: string): Promise<string> {
  const run = ctx.store.require(runId);
  if (run.status !== "awaiting_user") throw new Error(`Run is '${run.status}', not awaiting approval`);
  // Merge happens before the status change so a conflict leaves the run awaiting approval and the human can retry.
  const mergeCommit = await mergeIntegrationIntoBase(run.repoPath, run.baseBranch, run.integrationBranch);
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "completed";
    mutableRun.gate = null;
  });
  ctx.logEvent(runId, { taskId: null, from: "manager", to: run.baseBranch, kind: "run.merged_to_base", summary: mergeCommit, outcome: "delivered" });
  await retireRunResources(ctx, runId);
  return `Merged ${run.integrationBranch} into ${run.baseBranch} (${mergeCommit.slice(0, 8)})`;
}

// After the final merge only the Supervisor's chat (with its report and cards) is worth keeping.
async function retireRunResources(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  for (const agentRecord of Object.values(run.agents)) {
    // The Supervisor stays alive so the Supreme Manager can still chat with it after the merge.
    if (agentRecord.role === "supervisor") continue;
    await archiveAgentLogged(ctx, runId, agentRecord.taskId, agentRecord.agentId);
  }
  const paseo = await ctx.holder.get();
  // the integration branch survives archiving, so the merge commit keeps its history
  // Best effort: an already-archived workspace must not turn a successful merge into an error.
  await paseo.workspaces.archive(run.devWorkspaceId).catch(() => undefined);
}

export async function approveRunGate(ctx: PipelineContext, runId: string, taskId: string | null): Promise<string> {
  const run = ctx.store.require(runId);
  // the run level gate is final_approval, which is consumed by approveMain rather than a continuation
  if (!taskId && run.gate?.kind === "final_approval") return approveMain(ctx, runId);
  return approveGate(ctx, runId, taskId);
}

export async function abortRun(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // Every agent is archived (including the Supervisor) because an aborted run has nothing worth keeping alive.
  for (const agentRecord of Object.values(run.agents)) {
    await archiveAgentLogged(ctx, runId, agentRecord.taskId, agentRecord.agentId);
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "aborted";
    // Queued mail is dropped so the sweeper cannot deliver stale messages to agents of an aborted run.
    mutableRun.mailbox = [];
  });
  ctx.logEvent(runId, { taskId: null, from: "manager", to: "pipeline", kind: "run.aborted", summary: "aborted by the Supreme Manager", outcome: "info" });
}
