// Shared dependencies and tiny helpers used by every pipeline module. Passing one context object
// (instead of importing singletons) keeps the state machine testable with fakes.
import { FIX_LOOP_LIMIT, type SlpRole } from "../../shared/roles";
import { TASK_CARD_KIND, TASK_CARD_VERSION, phaseLabel, type TaskCardData } from "../../shared/card";
import type { GateKind, Run, Task } from "../../shared/state";
import type { ForkRegistry } from "../fork/session-forker";
import type { AgentGateway } from "../runtime/agent-gateway";
import type { Mailbox } from "../runtime/mailbox";
import type { PaseoHolder } from "../runtime/paseo-holder";
import type { CommLogInput } from "../store/comm-log";
import type { RunStore } from "../store/run-store";

export type PipelineLogEntry = Omit<CommLogInput, "runId">;

export interface PipelineContext {
  store: RunStore;
  gateway: AgentGateway;
  mailbox: Mailbox;
  forks: ForkRegistry;
  holder: PaseoHolder;
  logEvent(runId: string, entry: PipelineLogEntry): void;
  // gate continuations are registered after construction to avoid circular imports
  continuations: Partial<Record<GateKind, (runId: string, taskId: string | null) => Promise<void>>>;
}

export function requireTask(run: Run, taskId: string): Task {
  // Task IDs arrive through tools, so inherited object keys must never resolve as actual tasks.
  const task = Object.hasOwn(run.tasks, taskId) ? run.tasks[taskId] : undefined;
  // The known-task list in the message helps an agent that mistyped a task id recover on its own.
  if (!task) throw new Error(`Unknown task '${taskId}'. Known tasks: ${Object.keys(run.tasks).join(", ") || "(none)"}`);
  return task;
}

export function agentIdForRole(task: Task, role: string): string | null {
  return task.agentIds[role] ?? null;
}

export function buildTaskCard(run: Run, task: Task): TaskCardData {
  return {
    runId: run.id,
    taskId: task.id,
    title: task.title,
    phase: task.phase,
    // The label is computed by the shared module so the daemon timeline card and the client render identical text.
    phaseLabel: phaseLabel(task.phase, task.fixLoopCount, FIX_LOOP_LIMIT),
    fixLoopCount: task.fixLoopCount,
    fixLoopLimit: FIX_LOOP_LIMIT,
    gateNote: task.gate?.note ?? null,
    pausedReason: task.pausedReason,
    workspaceId: task.workspace?.workspaceId ?? null,
    updatedAt: task.updatedAt,
  };
}

// Appends (or replaces, same id) the progress card in the Supervisor's chat. Cards are cosmetic,
// so any failure is logged and never propagates into the pipeline.
export async function publishTaskCard(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  try {
    const run = ctx.store.require(runId);
    const task = requireTask(run, taskId);
    // Short timeout: a card is cosmetic and must not hold up a state change while the SDK is still starting.
    const paseo = await ctx.holder.get(5_000);
    await paseo.agents.ref(run.supervisorAgentId).timeline.append({
      type: "plugin",
      // A stable id makes the append replace the previous card row instead of adding one per state change.
      id: `task-${task.id}`,
      kind: TASK_CARD_KIND,
      version: TASK_CARD_VERSION,
      data: buildTaskCard(run, task),
    });
  } catch (cardError) {
    console.error("[slp] progress card failed", cardError);
  }
}

// Single place where task state changes: mutate, stamp, then refresh the card.
export function updateTask(
  ctx: PipelineContext,
  runId: string,
  taskId: string,
  mutator: (task: Task) => void,
): void {
  ctx.store.mutate(runId, (run) => {
    const task = requireTask(run, taskId);
    mutator(task);
    task.updatedAt = new Date().toISOString();
  });
  // Fire and forget: the store write above is already durable, the card only mirrors it.
  void publishTaskCard(ctx, runId, taskId);
}

// Retiring an agent must never stop the pipeline, but a silent failure leaves orphan agents
// running, so the failure is written to the audit log instead of being swallowed.
export async function archiveAgentLogged(
  ctx: PipelineContext,
  runId: string,
  taskId: string | null,
  agentId: string,
): Promise<boolean> {
  try {
    await ctx.gateway.archive(agentId);
    return true;
  } catch (archiveError) {
    ctx.logEvent(runId, {
      taskId,
      from: "pipeline",
      to: agentId,
      kind: "agent.archive_failed",
      summary: "could not archive agent",
      outcome: "error",
      reason: archiveError instanceof Error ? archiveError.message : String(archiveError),
    });
    return false;
  }
}

export function tell(
  ctx: PipelineContext,
  runId: string,
  toAgentId: string,
  text: string,
  options: { taskId: string | null; awaitTool: string | null; from: string; summary: string },
): void {
  // Never sends directly: the mailbox holds mail until the target is idle, because prompting a busy agent would interrupt its turn.
  ctx.mailbox.enqueue(runId, toAgentId, text, options);
}
