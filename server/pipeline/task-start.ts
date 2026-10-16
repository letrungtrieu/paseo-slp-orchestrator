// Phase 2 of the spec: after the Master Lead defines tasks, wait for its turn to end, take the
// fork checkpoint, then give every task a worktree, a Forked Lead and a read-only Implementer.
import { ROLE_LABELS } from "../../shared/roles";
import { TaskSchema, type Task } from "../../shared/state";
import type { TaskDefinition } from "../../shared/state";
import { createTaskWorkspace } from "../git/worktree";
import type { ForkBinding } from "../fork/session-forker";
import { forkedLeadBriefing, implementerHandshakeBrief } from "../prompts/messages";
import { requireTask, tell, updateTask, type PipelineContext } from "./context";
import { waitUntilIdle } from "./idle";
import { peerRole } from "../project-prompts/defaults";
import { resolveAgentSettings } from "../project-prompts/agent-settings";

// The Master Lead may still be finishing a long survey turn when it calls slp_define_tasks, so allow plenty of time.
const MASTER_LEAD_TURN_TIMEOUT_MS = 15 * 60_000;

export function registerTasks(ctx: PipelineContext, runId: string, definitions: TaskDefinition[], masterSpec?: string): void {
  ctx.store.mutate(runId, (run) => {
    // Keep the planning context and all new task definitions within one SQLite commit.
    if (masterSpec !== undefined) run.masterSpec = masterSpec;
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
  // LEAD.md may override the form's provider; fork the session with the adapter for the model actually running.
  const leadSettings = resolveAgentSettings(run.promptConfig, "master_lead", undefined, {
    provider: run.providers.lead, thinkingOptionId: run.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: run.providers.leadPermissionModeId ?? undefined,
  });
  // resolve never throws for unsupported providers; it returns a stored-spec binding so the run still proceeds.
  const forkBinding = await ctx.forks.resolve(
    providerSessionId ? { provider: leadSettings.provider, providerSessionId } : null,
    leadSettings.provider,
  );
  // Without native history, the Forked Lead rebuilds context through the SQLite read tools.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.forkDegradedReason = forkBinding.mode === "stored-spec" ? forkBinding.reason : null;
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
  updateTask(ctx, runId, taskId, (task) => {
    task.workspace = createdWorkspace;
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
    thinkingOptionId: run.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: run.providers.leadPermissionModeId ?? undefined,
    workspaceId: run.devWorkspaceId,
    // Keep both responsibility and task identity visible when several worktrees run in parallel.
    title: `[${ROLE_LABELS.forked_lead}] [${queuedTask.id} · ${queuedTask.title}]`,
    initialPrompt: forkedLeadBriefing(queuedTask, run.forkDegradedReason),
    // The Forked Lead owes no tool: it answers through its turn text, which the handshake parses.
    awaitTool: null,
    // extraOptions carries the native fork flags (resume + fork-session); undefined means a plain session with a stored-spec briefing.
    extraOptions: forkBinding.mode === "native" ? forkBinding.providerOptions : undefined,
  });
  // The Implementer stays read-only until the handshake approves; the permission hook enforces that by phase.
  const implementationRole = peerRole(run.promptConfig, queuedTask.implementerRole);
  const implementer = await ctx.gateway.createAgent({
    runId,
    role: "implementer",
    projectRole: implementationRole.role,
    taskId,
    provider: run.providers.peer,
    thinkingOptionId: run.providers.peerThinkingOptionId ?? undefined,
    permissionModeId: run.providers.peerPermissionModeId ?? undefined,
    peerWorktreePath: createdWorkspace.cwd,
    workspaceId: createdWorkspace.workspaceId,
    title: `[${implementationRole.name}] [${queuedTask.id} · ${queuedTask.title}]`,
    initialPrompt: implementerHandshakeBrief(requireTask(ctx.store.require(runId), taskId)),
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
