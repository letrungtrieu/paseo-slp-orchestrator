// Pausing and resuming a task: circuit breaker, repeated scope violations and escalations all
// end here, and every way of resuming (Master Lead decision, human button) funnels through resumeTask.
import { FIX_LOOP_LIMIT } from "../../shared/roles";
import type { TaskPhase } from "../../shared/state";
import { circuitBreakerNotice, escalationNotice, specDecisionForAgent } from "../prompts/messages";
import { agentIdForRole, requireTask, tell, updateTask, type PipelineContext } from "./context";
import { openGateIfRequired } from "./gates";

export function pauseTask(
  ctx: PipelineContext,
  runId: string,
  taskId: string,
  reason: string,
): void {
  // Pausing only flips state; no agent is interrupted, so a peer mid-turn finishes and then waits for the resume message.
  updateTask(ctx, runId, taskId, (task) => {
    // remember where to continue; a second pause while paused must not overwrite it
    if (task.phase !== "paused") task.pausedFromPhase = task.phase;
    task.phase = "paused";
    task.pausedReason = reason;
  });
  ctx.logEvent(runId, { taskId, from: "pipeline", to: "master_lead", kind: "task.paused", summary: reason, outcome: "info" });
}

export function pauseForEscalation(ctx: PipelineContext, runId: string, taskId: string, reason: string): void {
  pauseTask(ctx, runId, taskId, `Escalated: ${reason}`);
  const run = ctx.store.require(runId);
  // The Master Lead owes slp_spec_decision, so the sweeper nudges it if it ends its turn without deciding.
  tell(ctx, runId, run.masterLeadAgentId, escalationNotice(requireTask(run, taskId), reason), {
    taskId,
    awaitTool: "slp_spec_decision",
    from: "pipeline",
    summary: `escalation from ${taskId}`,
  });
}

export function pauseForCircuitBreaker(
  ctx: PipelineContext,
  runId: string,
  taskId: string,
  issuesByRole: Record<string, string[]>,
): void {
  pauseTask(ctx, runId, taskId, `Circuit breaker: more than ${FIX_LOOP_LIMIT} rejected rounds`);
  const run = ctx.store.require(runId);
  tell(ctx, runId, run.masterLeadAgentId, circuitBreakerNotice(requireTask(run, taskId), issuesByRole), {
    taskId,
    awaitTool: "slp_spec_decision",
    from: "pipeline",
    summary: `circuit breaker tripped on ${taskId}`,
  });
  // Opened after the notice so in STEP_BY_STEP and SEMI_AUTO a human can also resume with guidance from the UI.
  openGateIfRequired(ctx, runId, taskId, "circuit_breaker");
}

// Where the Implementer picks up again, depending on what the task was doing when it paused.
const RESUME_INSTRUCTION: Partial<Record<TaskPhase, { awaitTool: string; nextPhase: TaskPhase; hint: string }>> = {
  handshaking: { awaitTool: "slp_submit_plan", nextPhase: "handshaking", hint: "Adjust your plan accordingly and call slp_submit_plan again. Still READ-ONLY." },
  implementing: { awaitTool: "slp_stage_done", nextPhase: "implementing", hint: "Continue implementing, commit, then call slp_stage_done." },
  fixing: { awaitTool: "slp_stage_done", nextPhase: "fixing", hint: "Fix the open review issues, commit, then call slp_stage_done." },
  // 'verifying' resumes as 'fixing': the open review issues are the work, and the next slp_stage_done restarts verification.
  verifying: { awaitTool: "slp_stage_done", nextPhase: "fixing", hint: "Address the open review issues, commit, then call slp_stage_done." },
  // Resuming documentation must direct the agent to SQLite submission rather than the retired file layout.
  documenting: { awaitTool: "slp_doc_done", nextPhase: "documenting", hint: "Submit the complete structured acceptance report through slp_doc_done; do not create a document file." },
};

export function resumeTask(ctx: PipelineContext, runId: string, taskId: string, guidance: string | null): void {
  const run = ctx.store.require(runId);
  const task = requireTask(run, taskId);
  if (task.phase !== "paused") throw new Error(`Task '${taskId}' is not paused (phase: ${task.phase})`);
  // Falls back to implementing for tasks paused by an older state file that lacks pausedFromPhase.
  const resumeFrom = task.pausedFromPhase ?? "implementing";
  const resumeInstruction = RESUME_INSTRUCTION[resumeFrom];
  if (!resumeInstruction) throw new Error(`Task '${taskId}' cannot resume from phase ${resumeFrom}`);
  const implementerId = agentIdForRole(task, "implementer");
  if (!implementerId) throw new Error(`Task '${taskId}' has no Implementer to resume`);
  // Counters reset so a resumed task is not instantly re-paused by the limit that paused it.
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.phase = resumeInstruction.nextPhase;
    mutableTask.pausedReason = null;
    mutableTask.pausedFromPhase = null;
    mutableTask.scopeViolations = 0;
    // the Lead's decision changes the premise, so the clarification budget starts over too
    if (resumeFrom === "handshaking") mutableTask.handshakeRounds = 0;
    // a human or Lead decision grants a fresh fix budget
    if (resumeFrom === "fixing" || resumeFrom === "verifying") mutableTask.fixLoopCount = 0;
    // Clearing the gate here lets a human resume bypass a still-open circuit_breaker gate.
    mutableTask.gate = null;
  });
  const guidanceText = guidance ? `${specDecisionForAgent(guidance)}\n\n` : "";
  // The decision text is prepended to the standing instruction so one message carries both guidance and next step.
  tell(ctx, runId, implementerId, `${guidanceText}${resumeInstruction.hint}`, {
    taskId,
    awaitTool: resumeInstruction.awaitTool,
    from: "pipeline",
    summary: `task resumed (${resumeFrom})`,
  });
  ctx.logEvent(runId, { taskId, from: "pipeline", to: implementerId, kind: "task.resumed", summary: guidance ?? "resumed", outcome: "delivered" });
}
