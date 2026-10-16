// Readback handshake (spec phase 2, step 4): the Implementer's plan goes to the Forked Lead,
// whose verdict either unlocks coding, loops back for clarification, or escalates to the Master Lead.
import { HANDSHAKE_ROUND_LIMIT } from "../../shared/roles";
import type { Plan } from "../../shared/state";
import {
  clarificationForImplementer,
  handshakeSummaryForMaster,
  planApprovedForImplementer,
  planReviewRequest,
} from "../prompts/messages";
import { agentIdForRole, archiveAgentLogged, requireTask, tell, updateTask, type PipelineContext } from "./context";
import { openGateIfRequired } from "./gates";
import { waitUntilIdle } from "./idle";
import { ToolError } from "./tool-error";
import { pauseForEscalation } from "./task-pause";
import { parseForkedLeadVerdict } from "./verdict-parser";

// Generous because a forked session replays the Master Lead's whole context before it can answer.
// "<runId>:<taskId>" of plans currently being judged by a Forked Lead
const reviewsInFlight = new Set<string>();

const FORKED_LEAD_TURN_TIMEOUT_MS = 10 * 60_000;

export function onPlanSubmitted(ctx: PipelineContext, runId: string, taskId: string, plan: Plan): string {
  const task = requireTask(ctx.store.require(runId), taskId);
  // A plan outside the handshake would restart review of a task that is already approved or running.
  if (task.phase !== "handshaking") {
    throw new ToolError(`Plan not expected now: task is in phase '${task.phase}'.`);
  }
  // Rounds are counted at submission, not at verdict, so a review that crashes still consumes the clarification budget.
  // two plans in one turn would start two concurrent reviews and unlock the Implementer twice
  const reviewKey = `${runId}:${taskId}`;
  if (reviewsInFlight.has(reviewKey)) {
    throw new ToolError("Your previous plan is still under review. End your turn and wait for the verdict.");
  }
  reviewsInFlight.add(reviewKey);
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.plan = plan;
    mutableTask.handshakeRounds += 1;
  });
  // the Forked Lead's reply can take minutes, so the tool call returns right away
  void reviewPlan(ctx, runId, taskId).catch((reviewError) => {
    const failureReason = reviewError instanceof Error ? reviewError.message : String(reviewError);
    ctx.logEvent(runId, { taskId, from: "pipeline", to: "forked_lead", kind: "handshake.error", summary: failureReason, outcome: "error" });
    pauseForEscalation(ctx, runId, taskId, `handshake review failed: ${failureReason}`);
  }).finally(() => reviewsInFlight.delete(reviewKey));
  return "Plan received. The Forked Lead is reviewing it. End your turn; you will get the verdict as a new message.";
}

async function reviewPlan(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  const task = requireTask(ctx.store.require(runId), taskId);
  const forkedLeadId = agentIdForRole(task, "forked_lead");
  const implementerId = agentIdForRole(task, "implementer");
  if (!forkedLeadId || !implementerId || !task.plan) throw new Error("handshake participants are missing");
  // the Forked Lead may still be answering its READY briefing; do not interrupt that turn
  await waitUntilIdle(ctx, forkedLeadId, FORKED_LEAD_TURN_TIMEOUT_MS);
  const reviewPrompt = planReviewRequest(task, task.plan, task.handshakeRounds);
  // runTurn is synchronous here because the pipeline needs the verdict text itself, unlike tools which only notify.
  let forkedLeadReply = await ctx.gateway.runTurn(forkedLeadId, reviewPrompt, FORKED_LEAD_TURN_TIMEOUT_MS);
  let handshakeVerdict = parseForkedLeadVerdict(forkedLeadReply.lastMessage);
  if (!handshakeVerdict) {
    // one repair attempt: models occasionally answer in prose despite the fenced JSON contract
    forkedLeadReply = await ctx.gateway.runTurn(
      forkedLeadId,
      'Your last reply had no valid verdict. Answer again with ONLY one fenced JSON block: {"verdict":"approve|clarify|escalate","message":"..."}.',
      FORKED_LEAD_TURN_TIMEOUT_MS,
    );
    handshakeVerdict = parseForkedLeadVerdict(forkedLeadReply.lastMessage);
  }
  // Never default to approve on garbage: unlocking writes on an unreviewed plan defeats the handshake.
  if (!handshakeVerdict) {
    pauseForEscalation(ctx, runId, taskId, "Forked Lead returned no parseable verdict");
    return;
  }
  ctx.logEvent(runId, {
    taskId,
    from: forkedLeadId,
    to: implementerId,
    kind: `handshake.${handshakeVerdict.verdict}`,
    summary: handshakeVerdict.message.slice(0, 300),
    outcome: "delivered",
  });
  // After the round limit a clarify is treated like an escalation (see below) instead of looping forever.
  const roundsExhausted = task.handshakeRounds >= HANDSHAKE_ROUND_LIMIT;
  if (handshakeVerdict.verdict === "clarify" && !roundsExhausted) {
    tell(ctx, runId, implementerId, clarificationForImplementer(handshakeVerdict.message), {
      taskId,
      awaitTool: "slp_submit_plan",
      from: forkedLeadId,
      summary: "handshake clarification",
    });
    return;
  }
  if (handshakeVerdict.verdict === "approve") {
    await completeHandshake(ctx, runId, taskId);
    return;
  }
  // an unresolved clarification loop is itself a sign the spec is the problem
  const escalationReason = handshakeVerdict.verdict === "escalate" ? handshakeVerdict.message : `handshake did not converge after ${task.handshakeRounds} rounds: ${handshakeVerdict.message}`;
  pauseForEscalation(ctx, runId, taskId, escalationReason);
}

async function completeHandshake(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  const run = ctx.store.require(runId);
  const task = requireTask(run, taskId);
  // spec step 5: brief the Master Lead, then retire the Forked Lead so it stops consuming resources
  // The Master Lead is briefed before any gate so the human sees a consistent picture when approving.
  tell(ctx, runId, run.masterLeadAgentId, handshakeSummaryForMaster(task), {
    taskId,
    awaitTool: null,
    from: "pipeline",
    summary: "handshake summary",
  });
  const forkedLeadId = agentIdForRole(task, "forked_lead");
  if (forkedLeadId) {
    // Archived and forgotten so neither the sweeper nor the mailbox targets the retired Forked Lead.
    await archiveAgentLogged(ctx, runId, taskId, forkedLeadId);
    updateTask(ctx, runId, taskId, (mutableTask) => {
      delete mutableTask.agentIds.forked_lead;
    });
  }
  // With an after_handshake gate the unlock waits for the human; approveGate re-enters through unlockImplementation.
  if (openGateIfRequired(ctx, runId, taskId, "after_handshake")) return;
  unlockImplementation(ctx, runId, taskId);
}

export function unlockImplementation(ctx: PipelineContext, runId: string, taskId: string): void {
  // Flipping the phase is the unlock itself: the permission hook decides writes by role and phase.
  updateTask(ctx, runId, taskId, (task) => {
    task.phase = "implementing";
  });
  const task = requireTask(ctx.store.require(runId), taskId);
  const implementerId = agentIdForRole(task, "implementer");
  if (!implementerId) throw new Error(`Task '${taskId}' has no Implementer`);
  tell(ctx, runId, implementerId, planApprovedForImplementer(task), {
    taskId,
    awaitTool: "slp_stage_done",
    from: "pipeline",
    summary: "plan approved, writes unlocked",
  });
}
