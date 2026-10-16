// Peer-to-peer and Lead-to-peer conversations (spec phase 4 and section 4): consultation,
// read-only sibling queries, escalation, decisions, and closing a merged task.
import { randomUUID } from "node:crypto";
import type { SlpRole } from "../../shared/roles";
import type { Question } from "../../shared/state";
import {
  allTasksMergedNotice,
  consultQuestion,
  questionAnswered,
  siblingQuestion,
  specDecisionForAgent,
} from "../prompts/messages";
import { agentIdForRole, archiveAgentLogged, requireTask, tell, updateTask, type PipelineContext } from "./context";
import { pauseForEscalation, resumeTask } from "./task-pause";
import { ToolError } from "./tool-error";

function openQuestion(
  ctx: PipelineContext,
  runId: string,
  kind: Question["kind"],
  fromAgentId: string,
  toAgentId: string,
  taskId: string,
  text: string,
): Question {
  // Short id: the agents have to echo it back through slp_answer, so it should be easy to copy.
  const question: Question = {
    id: randomUUID().slice(0, 8),
    kind,
    fromAgentId,
    toAgentId,
    taskId,
    text,
    answer: null,
    createdAt: new Date().toISOString(),
  };
  // Persisted so the sweeper and a reloaded daemon can still route the answer to the asker.
  ctx.store.mutate(runId, (run) => {
    run.questions.push(question);
  });
  return question;
}

function implementerOfTask(ctx: PipelineContext, runId: string, taskId: string): string {
  const task = requireTask(ctx.store.require(runId), taskId);
  // Peers always talk to the Implementer: it owns the worktree and is the only one who can answer for the code.
  const implementerId = agentIdForRole(task, "implementer");
  if (!implementerId) throw new ToolError(`Task '${taskId}' has no Implementer to ask.`);
  return implementerId;
}

export function consultPeer(ctx: PipelineContext, runId: string, askerAgentId: string, taskId: string, questionText: string): string {
  const implementerId = implementerOfTask(ctx, runId, taskId);
  const question = openQuestion(ctx, runId, "consult", askerAgentId, implementerId, taskId, questionText);
  // Delivered through the mailbox, so a busy Implementer receives it only after its current turn ends.
  tell(ctx, runId, implementerId, consultQuestion(question.id, taskId, questionText), {
    taskId,
    awaitTool: "slp_answer",
    from: askerAgentId,
    summary: `consult: ${questionText.slice(0, 120)}`,
  });
  return `Question ${question.id} sent to the Implementer of '${taskId}'. End your turn; the answer arrives as a new message.`;
}

// Rule 1: cross-worktree traffic is a read-only query; the wrapper text strips any authority to change code.
export function askSibling(
  ctx: PipelineContext,
  runId: string,
  askerAgentId: string,
  askerTaskId: string | null,
  targetTaskId: string,
  questionText: string,
): string {
  // Self-queries would deadlock: the asker's turn is ending while it waits for its own answer.
  if (targetTaskId === askerTaskId) throw new ToolError("Use your own context for questions about your own task.");
  const implementerId = implementerOfTask(ctx, runId, targetTaskId);
  const question = openQuestion(ctx, runId, "sibling", askerAgentId, implementerId, targetTaskId, questionText);
  tell(ctx, runId, implementerId, siblingQuestion(question.id, askerTaskId ?? "?", questionText), {
    taskId: targetTaskId,
    awaitTool: "slp_answer",
    from: askerAgentId,
    summary: `sibling query: ${questionText.slice(0, 120)}`,
  });
  return `Question ${question.id} queued for task '${targetTaskId}'. End your turn; the answer arrives as a new message.`;
}

export function answerQuestion(ctx: PipelineContext, runId: string, answererAgentId: string, questionId: string, answerText: string): string {
  // Only the addressed agent may answer, otherwise a third peer could close someone else's question with a guess.
  const question = ctx.store.require(runId).questions.find((candidate) => candidate.id === questionId);
  if (!question) throw new ToolError(`Unknown question '${questionId}'.`);
  if (question.toAgentId !== answererAgentId) throw new ToolError("That question was not addressed to you.");
  // Answers are single-shot so a retried tool call cannot overwrite what the asker already acted on.
  if (question.answer !== null) throw new ToolError("That question was already answered.");
  ctx.store.mutate(runId, (run) => {
    const storedQuestion = run.questions.find((candidate) => candidate.id === questionId);
    if (storedQuestion) storedQuestion.answer = answerText;
  });
  // The answer is mailed back as a new message rather than returned from the ask call, because the asker's turn has already ended.
  tell(ctx, runId, question.fromAgentId, questionAnswered(questionId, answerText), {
    taskId: question.taskId,
    awaitTool: null,
    from: answererAgentId,
    summary: `answer to ${questionId}`,
  });
  return "Answer delivered. End your turn.";
}

// Rule 2: peers never settle contract disputes among themselves; the task pauses and the Master Lead decides.
export function escalate(ctx: PipelineContext, runId: string, taskId: string | null, role: SlpRole, reason: string): string {
  if (!taskId) throw new ToolError("Only task peers can escalate.");
  // Pausing stops the fix loop and wakes the Master Lead; the peer must not keep working on a disputed contract.
  pauseForEscalation(ctx, runId, taskId, `${role}: ${reason}`);
  return "Escalated to the Master Lead; the task is paused. End your turn.";
}

export function specDecision(ctx: PipelineContext, runId: string, taskId: string, decision: string): string {
  const task = requireTask(ctx.store.require(runId), taskId);
  // A paused task resumes through the same tool, so the Master Lead has one verb for decisions.
  if (task.phase === "paused") {
    resumeTask(ctx, runId, taskId, decision);
    return `Task '${taskId}' resumed with your decision.`;
  }
  // not paused: the decision is guidance for a running Implementer, forwarded as-is
  const implementerId = implementerOfTask(ctx, runId, taskId);
  tell(ctx, runId, implementerId, specDecisionForAgent(decision), { taskId, awaitTool: null, from: "master_lead", summary: "spec decision" });
  return `Decision forwarded to the Implementer of '${taskId}'.`;
}

// Spec phase 4, step 4: after the merge the task's peers are retired and the worktree archived.
export async function archiveTask(ctx: PipelineContext, runId: string, taskId: string): Promise<string> {
  const task = requireTask(ctx.store.require(runId), taskId);
  if (task.phase !== "ready_for_merge") {
    throw new ToolError(`Task '${taskId}' is in phase '${task.phase}', not ready_for_merge.`);
  }
  // Retire peers before the worktree: archiving a workspace with a live agent in it would orphan the agent.
  for (const peerAgentId of Object.values(task.agentIds)) {
    await archiveAgentLogged(ctx, runId, taskId, peerAgentId);
  }
  if (task.workspace) {
    const paseo = await ctx.holder.get();
    // the branch survives workspace archive, so the merge commit keeps its history
    await paseo.workspaces.archive(task.workspace.workspaceId).catch(() => undefined);
  }
  // Agent ids are cleared so the sweeper and mailbox cannot target archived agents.
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.phase = "merged";
    mutableTask.agentIds = {};
  });
  const run = ctx.store.require(runId);
  // The Master Lead is told only when the last task merges, so it runs integration tests once over the complete result.
  // failed tasks were already reported to the Master Lead and must not hold the run back
  const workingTasks = Object.values(run.tasks).filter((candidate) => candidate.phase !== "failed");
  const everyTaskMerged = workingTasks.length > 0 && workingTasks.every((candidate) => candidate.phase === "merged");
  if (everyTaskMerged) {
    tell(ctx, runId, run.masterLeadAgentId, allTasksMergedNotice(), { taskId: null, awaitTool: "slp_report", from: "pipeline", summary: "all tasks merged" });
  }
  return everyTaskMerged
    ? `Task '${taskId}' archived. All tasks are merged: run the integration tests and call slp_report.`
    : `Task '${taskId}' archived.`;
}
