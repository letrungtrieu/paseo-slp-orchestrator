// Human gates (spec section 5). STEP_BY_STEP_DEBUG stops after every hand-over, SEMI_AUTO only
// at circuit breakers and before merging, FULL_AUTO never stops except for the final approval.
import type { RunMode } from "../../shared/roles";
import type { Gate, GateKind } from "../../shared/state";
import { requireTask, updateTask, type PipelineContext } from "./context";

const GATES_BY_MODE: Record<RunMode, readonly GateKind[]> = {
  // Step-by-step stops after every hand-over, so a human can inspect the worktree between pipeline stages.
  STEP_BY_STEP_DEBUG: [
    "after_handshake",
    "after_implementation",
    "after_verification",
    "before_merge",
    "circuit_breaker",
    "final_approval",
  ],
  // Semi-auto trusts the pipeline except where a human decision is cheapest: unrecoverable loops and the merge.
  SEMI_AUTO: ["before_merge", "circuit_breaker", "final_approval"],
  // the final merge into the base branch always needs the Supreme Manager
  FULL_AUTO: ["final_approval"],
};

// Pure so tests and the UI can ask whether a mode would stop without touching the store.
export function gateRequired(mode: RunMode, gateKind: GateKind): boolean {
  return GATES_BY_MODE[mode].includes(gateKind);
}

function describeGate(gateKind: GateKind, taskId: string | null): Gate {
  const gateNotes: Record<GateKind, string> = {
    after_handshake: "Handshake finished. Review the plan, then approve to unlock coding.",
    after_implementation: "Implementation committed. Approve to start QA/Security.",
    after_verification: "QA/Security approved. Approve to write the acceptance doc.",
    before_merge: "Ready for merge. Approve to notify the Master Lead.",
    circuit_breaker: "Fix loop limit exceeded. Approve (with guidance) to resume the task.",
    final_approval: "Result verified by the Supervisor. Approve to merge into the base branch.",
  };
  return {
    kind: gateKind,
    openedAt: new Date().toISOString(),
    note: taskId ? `[${taskId}] ${gateNotes[gateKind]}` : gateNotes[gateKind],
  };
}

// Returns true when a gate was opened; the caller must then stop and wait for approval.
export function openGateIfRequired(
  ctx: PipelineContext,
  runId: string,
  taskId: string | null,
  gateKind: GateKind,
): boolean {
  const run = ctx.store.require(runId);
  // Not required means the caller simply continues inline; that is the whole FULL_AUTO path.
  if (!gateRequired(run.mode, gateKind)) return false;
  const openedGate = describeGate(gateKind, taskId);
  // Task-level gates are stored on the task so parallel tasks can wait for approval independently; only run-level gates use the run.
  if (taskId) {
    updateTask(ctx, runId, taskId, (task) => {
      task.gate = openedGate;
    });
  } else {
    ctx.store.mutate(runId, (mutableRun) => {
      mutableRun.gate = openedGate;
    });
  }
  // Logged as a message to the manager so the gate shows up in the audit trail next to agent traffic.
  ctx.logEvent(runId, {
    taskId,
    from: "pipeline",
    to: "manager",
    kind: `gate.${gateKind}`,
    summary: openedGate.note,
    outcome: "info",
  });
  return true;
}

// Called by the UI. Clears the gate and runs the step that was waiting behind it.
export async function approveGate(
  ctx: PipelineContext,
  runId: string,
  taskId: string | null,
): Promise<string> {
  const run = ctx.store.require(runId);
  // The gate is looked up before anything is cleared, so a double click on Approve fails cleanly instead of re-running the step.
  const openGate = taskId ? requireTask(run, taskId).gate : run.gate;
  if (!openGate) throw new Error(taskId ? `Task '${taskId}' has no open gate` : "Run has no open gate");
  if (taskId) {
    updateTask(ctx, runId, taskId, (task) => {
      task.gate = null;
    });
  } else {
    ctx.store.mutate(runId, (mutableRun) => {
      mutableRun.gate = null;
    });
  }
  // Gates are continuations: each gate kind maps to the step that was deferred, so approving resumes the pipeline exactly there (no polling, no re-derived state).
  const continuation = ctx.continuations[openGate.kind];
  if (!continuation) throw new Error(`No continuation registered for gate ${openGate.kind}`);
  ctx.logEvent(runId, {
    taskId,
    from: "manager",
    to: "pipeline",
    kind: `gate.${openGate.kind}.approved`,
    summary: "gate approved",
    outcome: "delivered",
  });
  // Awaited so a failing continuation surfaces to the UI as an error on the Approve click.
  await continuation(runId, taskId);
  return `Gate ${openGate.kind} approved`;
}
