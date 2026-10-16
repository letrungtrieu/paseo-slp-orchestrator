// Phase 2 of the spec: after the Master Lead defines tasks, wait for its turn to end, take the
// fork checkpoint, then give every task a worktree, a Forked Lead and a read-only Implementer.
import { TaskSchema, type Task } from "../../shared/state";
import type { TaskDefinition } from "../../shared/state";
import { createTaskWorkspace, writeTaskSpecFile } from "../git/worktree";
import type { ForkBinding } from "../fork/session-forker";
import { forkedLeadBriefing, implementerHandshakeBrief } from "../prompts/messages";
import { requireTask, tell, updateTask, type PipelineContext } from "./context";
import { waitUntilIdle } from "./idle";

// The Master Lead may still be finishing a long survey turn when it calls slp_define_tasks, so allow plenty of time.
const MASTER_LEAD_TURN_TIMEOUT_MS = 15 * 60_000;

export function registerTasks(ctx: PipelineContext, runId: string, definitions: TaskDefinition[]): void {
  ctx.store.mutate(runId, (run) => {
    for (const definition of definitions) {
      // parsing fills every runtime field with its default so a task is always fully shaped
      run.tasks[definition.id] = TaskSchema.parse({
        ...definition,
        phase: "queued",
        updatedAt: new Date().toISOString(),
      });
    }
    // Status flips only after tasks exist, so the sweeper never sees a 'running' run with nothing queued.
    run.status = "running";
  });
}

// runs whose queued tasks are being started right now; keeps the sweeper's recovery from racing
const runsStartingTasks = new Set<string>();

export function isStartingTasks(runId: string): boolean {
  return runsStartingTasks.has(runId);
}

// The fork checkpoint is the Master Lead's idle moment right after it called slp_define_tasks:
// its session then contains the survey, the Master Spec and the task split.
export async function startQueuedTasks(ctx: PipelineContext, runId: string): Promise<void> {
  // Re-entrancy guard: the define-tasks path and the sweeper's recovery may both try to start the same queue.
  if (runsStartingTasks.has(runId)) return;
  runsStartingTasks.add(runId);
  try {
    await startQueuedTasksNow(ctx, runId);
  } finally {
    runsStartingTasks.delete(runId);
  }
}

async function startQueuedTasksNow(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // The fork happens only after the Master Lead's turn ends: a session still mid-turn has not persisted the task split we want the fork to inherit.
  const masterLeadIdle = await waitUntilIdle(ctx, run.masterLeadAgentId, MASTER_LEAD_TURN_TIMEOUT_MS);
  // If the Master Lead never goes idle, fork anyway; stalling the whole run is worse than a slightly stale checkpoint.
  if (!masterLeadIdle) {
    ctx.logEvent(runId, { taskId: null, from: "pipeline", to: "master_lead", kind: "fork.checkpoint", summary: "Master Lead did not become idle in time; forking anyway", outcome: "error" });
  }
  // The session id is read after idle because the provider only reports it once the session is persisted.
  const providerSessionId = await ctx.gateway.sessionIdOf(run.masterLeadAgentId);
  // resolve never throws for unsupported providers; it returns a spec-file binding so the run still proceeds.
  const forkBinding = await ctx.forks.resolve(
    providerSessionId ? { provider: run.providers.lead, providerSessionId } : null,
    run.providers.lead,
  );
  // Stored on the run so every briefing can tell the Forked Lead to read the spec files when no native fork exists.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.forkDegradedReason = forkBinding.mode === "spec-file" ? forkBinding.reason : null;
  });
  ctx.logEvent(runId, {
    taskId: null,
    from: "pipeline",
    to: "master_lead",
    kind: "fork.checkpoint",
    summary: forkBinding.mode === "native" ? `native fork from session ${providerSessionId}` : `degraded: ${forkBinding.reason}`,
    outcome: forkBinding.mode === "native" ? "info" : "error",
  });
  // Only tasks still queued: a recovery pass after a partial failure must not recreate worktrees of started tasks.
  const queuedTaskIds = Object.values(ctx.store.require(runId).tasks)
    .filter((task) => task.phase === "queued")
    .map((task) => task.id);
  for (const queuedTaskId of queuedTaskIds) {
    try {
      await startTask(ctx, runId, queuedTaskId, forkBinding);
    // One failing task must not block its siblings; it is marked failed so the sweeper does not retry it endlessly.
    } catch (startError) {
      const failureReason = startError instanceof Error ? startError.message : String(startError);
      updateTask(ctx, runId, queuedTaskId, (task) => {
        task.phase = "failed";
        task.pausedReason = `Could not start: ${failureReason}`;
      });
      ctx.logEvent(runId, { taskId: queuedTaskId, from: "pipeline", to: "-", kind: "task.start_failed", summary: failureReason, outcome: "error" });
      // without this the Master Lead would wait forever for a task that will never report
      tell(ctx, runId, run.masterLeadAgentId, `Task "${queuedTaskId}" could not be started and is marked failed: ${failureReason}\nFix the cause or call slp_define_tasks again with a replacement task (new id).`, {
        taskId: queuedTaskId,
        awaitTool: null,
        from: "pipeline",
        summary: `task ${queuedTaskId} failed to start`,
      });
    }
  }
}

async function startTask(ctx: PipelineContext, runId: string, taskId: string, forkBinding: ForkBinding): Promise<void> {
  const run = ctx.store.require(runId);
  const queuedTask = requireTask(run, taskId);
  const paseo = await ctx.holder.get();
  // The worktree comes first because both peers are created inside it and need its workspace id.
  const createdWorkspace = await createTaskWorkspace(paseo, run, queuedTask);
  // The hash lets the scope gate detect and undo edits to TASK_SPEC.md later.
  const taskSpecSha256 = await writeTaskSpecFile(createdWorkspace.cwd, run, queuedTask);
  updateTask(ctx, runId, taskId, (task) => {
    task.workspace = createdWorkspace;
    task.taskSpecSha256 = taskSpecSha256;
    // The phase leaves 'queued' before agents exist so a concurrent sweeper pass cannot start this task twice.
    task.phase = "handshaking";
  });
  // The Forked Lead lives in the Master Lead's own checkout: Claude keys sessions by cwd,
  // so a fork must share it to find the source conversation.
  const forkedLead = await ctx.gateway.createAgent({
    runId,
    role: "forked_lead",
    taskId,
    provider: run.providers.lead,
    workspaceId: run.devWorkspaceId,
    title: `[SLP ${taskId}] Forked Lead`,
    initialPrompt: forkedLeadBriefing(queuedTask, run.forkDegradedReason, run.masterSpecPath),
    // The Forked Lead owes no tool: it answers through its turn text, which the handshake parses.
    awaitTool: null,
    // extraOptions carries the native fork flags (resume + fork-session); undefined means a plain session with a spec-file briefing.
    extraOptions: forkBinding.mode === "native" ? forkBinding.providerOptions : undefined,
  });
  // The Implementer stays read-only until the handshake approves; the permission hook enforces that by phase.
  const implementer = await ctx.gateway.createAgent({
    runId,
    role: "implementer",
    taskId,
    provider: run.providers.peer,
    workspaceId: createdWorkspace.workspaceId,
    title: `[SLP ${taskId}] Implementer`,
    initialPrompt: implementerHandshakeBrief(requireTask(ctx.store.require(runId), taskId), `${createdWorkspace.cwd}/TASK_SPEC.md`),
    awaitTool: "slp_submit_plan",
  });
  // The role-to-agent map is how later steps address peers, so it is filled once both agents exist.
  updateTask(ctx, runId, taskId, (task) => {
    task.agentIds.forked_lead = forkedLead.agentId;
    task.agentIds.implementer = implementer.agentId;
  });
  ctx.logEvent(runId, { taskId, from: "pipeline", to: implementer.agentId, kind: "task.started", summary: `worktree ${createdWorkspace.branch}`, outcome: "delivered" });
}

// Exposed so the sweeper can restart tasks stuck in "queued" after a plugin restart.
export function queuedTasks(tasks: Record<string, Task>): Task[] {
  return Object.values(tasks).filter((task) => task.phase === "queued");
}
