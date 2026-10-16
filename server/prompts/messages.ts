// Messages the pipeline sends to agents at each transition. Each one names the bus tool the
// recipient must call next, so a nudge can repeat the instruction when the agent forgets.
import { FIX_LOOP_LIMIT } from "../../shared/roles";
import type { Plan, Task, TaskDefinition } from "../../shared/state";

export function supervisorBriefing(): string {
  return "You are the Supervisor of an SLP run. Greet the Supreme Manager in Vietnamese in one sentence and wait for their requirement. Do not call any tool yet.";
}

export function delegationMessage(acceptanceCriteria: string): string {
  return [
    "The Supervisor delegated this project. Overall acceptance criteria:",
    "",
    acceptanceCriteria,
    "",
    // A tool submission captures the spec and split atomically without a document in the repository.
    "Survey the codebase, prepare the Master Spec text, then call slp_define_tasks with masterSpec and all tasks with non-overlapping writable scopes. Store the actual spec content, not a path. Do not create pipeline spec/report files.",
  ].join("\n");
}

export function forkedLeadBriefing(task: TaskDefinition, degradedReason: string | null): string {
  const memoryNote = degradedReason
    ? `Native session fork was unavailable (${degradedReason}). Use slp_get_run to read the Master Spec and inspect the codebase to rebuild context.`
    : "You inherited the Master Lead's memory.";
  // Read tools stay available even when a native fork could not carry the survey into this session.
  return `You are the Forked Lead for task "${task.id}" (${task.title}). ${memoryNote} Use slp_get_task for the current task definition. An Implementer will send you its plan; answer each plan with one fenced JSON verdict block. Reply with READY now.`;
}

export function implementerHandshakeBrief(task: Task): string {
  return [
    `New task "${task.id}": ${task.title}.`,
    // The task tool is authoritative, so a peer cannot silently rewrite its own assumptions or writable boundary.
    "Call slp_get_task to read your task and slp_get_run for the Master Spec, then inspect the real code and compare it with the Lead's assumptions. Continue after reads. You are READ-ONLY until approved.",
    "Call slp_submit_plan with: your own restatement of the goal, every place where the real code differs from the Lead's assumptions, and the exact files/functions you plan to change. Then end your turn.",
  ].join("\n");
}

export function planReviewRequest(task: Task, plan: Plan, round: number): string {
  const bullet = (lines: string[]) => (lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- (none)");
  return [
    `Implementer plan for task "${task.id}" (round ${round}).`,
    `Restated goal: ${plan.restatedGoal}`,
    "Discrepancies the Implementer found between your assumptions and the real code:",
    bullet(plan.discrepancies),
    "Planned files/functions:",
    bullet(plan.plannedFiles),
    "Answer with one fenced JSON block: {\"verdict\":\"approve|clarify|escalate\",\"message\":\"...\"}.",
  ].join("\n");
}

export function clarificationForImplementer(message: string): string {
  return `The Forked Lead reviewed your plan and needs changes:\n${message}\n\nRevise and call slp_submit_plan again. Still READ-ONLY.`;
}

export function planApprovedForImplementer(task: Task): string {
  return [
    "Your plan is APPROVED. Writing is now unlocked inside your writable scope:",
    ...task.writableScope.map((scope) => `- ${scope}`),
    "Implement the plan with unit tests, commit on your branch, then call slp_stage_done with a short summary. Task definitions and reports belong in the slp_ tools, not worktree files.",
  ].join("\n");
}

export function handshakeSummaryForMaster(task: Task): string {
  return `Task "${task.id}": handshake finished, plan approved after ${task.handshakeRounds} round(s). Implementer is now coding. No action needed.`;
}

export function scopeViolationMessage(outOfScopeFiles: string[], protectedFiles: string[]): string {
  return [
    "Stage rejected by the scope gate. Restore these changes (git checkout/rm) and commit again:",
    ...outOfScopeFiles.map((file) => `- outside writable scope: ${file}`),
    ...protectedFiles.map((file) => `- obsolete pipeline file: ${file}; submit task/report content through slp_ tools instead`),
    "Then call slp_stage_done again.",
  ].join("\n");
}

export function verificationRequest(task: Task, role: "qa" | "security", round: number): string {
  const roleInstruction =
    role === "qa"
      ? "Write extra edge-case tests (only under tests/), run the real test suite and report."
      : "Review the new code read-only for vulnerabilities, data leaks and architecture violations.";
  return [
    `Verification round ${round} for task "${task.id}". Read its definition using slp_get_task and review the committed work on this branch. Continue working after the read.`,
    roleInstruction,
    "Call slp_verdict with APPROVED or REJECTED plus a concrete issue list. End your turn afterwards.",
  ].join("\n");
}

export function fixRequest(issuesByRole: Record<string, string[]>, loop: number): string {
  const sections = Object.entries(issuesByRole).map(
    ([role, issues]) => `From ${role}:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
  );
  return [
    `Review REJECTED (fix loop ${loop}/${FIX_LOOP_LIMIT}). Fix every issue below, commit, then call slp_stage_done.`,
    ...sections,
  ].join("\n\n");
}

export function documentationRequest(): string {
  return [
    // Naming the fields here prevents the agent from sending an empty completion acknowledgement.
    "All reviews APPROVED. Read slp_get_task and slp_get_report, then submit slp_doc_done with report: {summary, changedFiles, technicalDecisions, qaResults, securityReview, risks}.",
    "Use arrays for changedFiles, technicalDecisions and risks; use text for the remaining fields. Include real test evidence and the security verdict, or explicitly state a review was not configured. No acceptance document file is needed. End your turn after submission.",
  ].join("\n");
}

export function readyForMergeNotice(task: Task): string {
  return [
    `Task "${task.id}" (${task.title}) is READY FOR MERGE.`,
    `Branch: ${task.workspace?.branch ?? "?"}. Worktree: ${task.workspace?.cwd ?? "?"}.`,
    // A stable task ID still resolves its report after the task workspace has been archived.
    `Read slp_get_report with taskId "${task.id}" first, then merge the branch into your checkout, run tests and call slp_archive_task with taskId "${task.id}".`,
    "For a hard conflict or unclear intent use slp_consult_peer.",
  ].join("\n");
}

export function circuitBreakerNotice(task: Task, issuesByRole: Record<string, string[]>): string {
  const issueLines = Object.entries(issuesByRole).flatMap(([role, issues]) => issues.map((issue) => `- [${role}] ${issue}`));
  return [
    `CIRCUIT BREAKER: task "${task.id}" was rejected more than ${FIX_LOOP_LIMIT} times and is PAUSED.`,
    "Latest issues:",
    ...issueLines,
    `Decide how to proceed and call slp_spec_decision with taskId "${task.id}" (guidance for the Implementer, or amend the approach).`,
  ].join("\n");
}

export function consultQuestion(questionId: string, taskId: string, question: string): string {
  return `The Master Lead asks about task "${taskId}" (you remember writing it):\n${question}\nAnswer with slp_answer using questionId "${questionId}".`;
}

export function siblingQuestion(questionId: string, fromTaskId: string, question: string): string {
  return [
    `Read-only query from the Implementer of task "${fromTaskId}":`,
    question,
    "Answer ONLY with facts about the current code. You must not change code or agree to design changes because another branch asked.",
    `Reply with slp_answer using questionId "${questionId}".`,
  ].join("\n");
}

export function questionAnswered(questionId: string, answer: string): string {
  return `Answer to your question ${questionId}:\n${answer}`;
}

export function escalationNotice(task: Task, reason: string): string {
  return `ESCALATION from task "${task.id}": ${reason}\nDecide and call slp_spec_decision with taskId "${task.id}".`;
}

export function specDecisionForAgent(decision: string): string {
  return `The Master Lead decided:\n${decision}\nContinue accordingly.`;
}

export function allTasksMergedNotice(): string {
  return "All tasks are merged into your branch. Run the full integration/e2e test suite, critique the combined result against the acceptance criteria, then call slp_report with a summary. Task acceptance reports remain available through slp_get_report.";
}

export function reportForSupervisor(report: string, baseBranch: string, integrationBranch: string): string {
  return [
    "The Master Lead reports the project is done:",
    report,
    "Use slp_list_tasks and slp_get_report(taskId) to inspect the persisted acceptance reports before approving.",
    `Independently verify: git diff ${baseBranch}..${integrationBranch}, run the tests. If anything is missing call slp_request_rework, else call slp_present_to_manager.`,
  ].join("\n");
}

export function reworkNotice(feedback: string): string {
  return `The Supervisor rejected the result:\n${feedback}\nFix it (you may define follow-up work yourself), then call slp_report again.`;
}

export function nudgeReminder(awaitTool: string): string {
  return `Reminder: you ended your turn without calling ${awaitTool}. Call ${awaitTool} now with your result; do not reply in plain text only.`;
}
