// Phase 3 of the spec: scope gate after implementation, verification rounds, the intra-worktree
// fix loop with its circuit breaker, and the persisted acceptance report that makes a worktree mergeable.
import { FIX_LOOP_LIMIT, SCOPE_VIOLATION_LIMIT } from "../../shared/roles";
import type { VerdictRecord } from "../../shared/state";
import { AcceptanceReportSchema, type AcceptanceReport } from "../../shared/reports";
import { QA_WRITABLE_SCOPE, checkScope } from "../git/scope";
import { listChangedFiles } from "../git/git";
import {
  documentationRequest,
  fixRequest,
  readyForMergeNotice,
  scopeViolationMessage,
  verificationRequest,
} from "../prompts/messages";
import { agentIdForRole, requireTask, tell, updateTask, type PipelineContext } from "./context";
import { openGateIfRequired } from "./gates";
import { pauseForCircuitBreaker, pauseForEscalation } from "./task-pause";
import { ToolError } from "./tool-error";
import { peerRole } from "../project-prompts/defaults";
import { reviewerAgentKey, reviewerCapability } from "./peer-assignments";

// ---------- implementation done -> scope gate ----------

export async function onStageDone(ctx: PipelineContext, runId: string, taskId: string, summary: string): Promise<string> {
  const run = ctx.store.require(runId);
  const task = requireTask(run, taskId);
  // Only the two writing phases can end in a stage report; a late or duplicate call must not restart review.
  if (task.phase !== "implementing" && task.phase !== "fixing") {
    throw new ToolError(`Stage report not expected now: task is in phase '${task.phase}'.`);
  }
  if (!task.workspace) throw new ToolError("Task has no worktree.");
  const changedFiles = await listChangedFiles(task.workspace.cwd, run.integrationBranch);
  // QA's earlier test files from a previous round remain in the diff, so they stay allowed
  // Scope is judged on the git diff against the integration branch, not on what the agent says it touched, so shell writes are caught too.
  const scopeOutcome = checkScope({ changedFiles, writableScope: task.writableScope, additionalAllowedScope: QA_WRITABLE_SCOPE });
  // Specs live in SQLite now; writing an obsolete pipeline document is a scope violation.
  const hasViolation = scopeOutcome.outOfScopeFiles.length > 0 || scopeOutcome.protectedFileTouched.length > 0;
  // Out-of-scope work never reaches QA: rejecting here is cheaper than a full review round on a diff that cannot merge.
  if (hasViolation) return rejectOutOfScope(ctx, runId, taskId, scopeOutcome.outOfScopeFiles, scopeOutcome.protectedFileTouched);
  // A clean pass resets the counter so only consecutive violations trip the pause.
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.phase = "verifying";
    mutableTask.scopeViolations = 0;
    mutableTask.implementationSummary = summary;
  });
  ctx.logEvent(runId, { taskId, from: "pipeline", to: "implementer", kind: "scope.ok", summary: `${changedFiles.length} changed file(s) inside scope`, outcome: "delivered" });
  // The gate is a continuation: we return now and the gate's approval handler resumes verification later.
  if (openGateIfRequired(ctx, runId, taskId, "after_implementation")) {
    return "Stage accepted by the scope gate. Waiting for the Supreme Manager's approval before review. End your turn.";
  }
  // Review is fire-and-forget so the tool reply returns immediately and the Implementer's turn can end; failures pause the task instead of hanging the call.
  void startVerification(ctx, runId, taskId).catch((verifyError) => logPipelineError(ctx, runId, taskId, verifyError));
  return "Stage accepted by the scope gate. QA/Security review starts now. End your turn.";
}

function rejectOutOfScope(ctx: PipelineContext, runId: string, taskId: string, outOfScopeFiles: string[], protectedFiles: string[]): string {
  // Counted in the store (not in memory) so the tally survives a daemon reload between attempts.
  const violationCount = requireTask(ctx.store.require(runId), taskId).scopeViolations + 1;
  updateTask(ctx, runId, taskId, (task) => {
    task.scopeViolations = violationCount;
  });
  const rejectedFiles = [...outOfScopeFiles, ...protectedFiles];
  ctx.logEvent(runId, { taskId, from: "pipeline", to: "implementer", kind: "scope.violation", summary: rejectedFiles.join(", "), outcome: "blocked", reason: `violation ${violationCount}/${SCOPE_VIOLATION_LIMIT}` });
  // Repeated violations mean the Implementer is not converging, so escalate to the Master Lead instead of looping forever.
  if (violationCount >= SCOPE_VIOLATION_LIMIT) {
    // the Master Lead must hear about it, otherwise nobody can decide and the task stays paused forever
    pauseForEscalation(ctx, runId, taskId, `Repeated scope violations: ${rejectedFiles.join(", ")}`);
    return "Stage rejected again; the task is paused for the Master Lead.";
  }
  // Thrown (not returned) so the Implementer's tool call is marked as an error and it must fix the diff.
  throw new ToolError(scopeViolationMessage(outOfScopeFiles, protectedFiles));
}

// ---------- verification ----------

export async function startVerification(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  const task = requireTask(ctx.store.require(runId), taskId);
  // A task may be configured without reviewers; skip straight to documentation.
  if (task.verifiers.length === 0) {
    await afterVerificationPassed(ctx, runId, taskId);
    return;
  }
  // Parallel wakes everyone at once; sequential wakes only the first and queues the rest.
  const verifiersToWakeNow = task.verifyParallel ? [...task.verifiers] : [task.verifiers[0]];
  updateTask(ctx, runId, taskId, (mutableTask) => {
    // Verdicts are per round: clearing them stops a previous round's APPROVED from satisfying this one.
    mutableTask.phase = "verifying";
    mutableTask.roundVerdicts = {};
    mutableTask.verifierQueue = mutableTask.verifyParallel ? [] : mutableTask.verifiers.slice(1);
  });
  for (const verifierRole of verifiersToWakeNow) await wakeVerifier(ctx, runId, taskId, verifierRole);
}

async function wakeVerifier(ctx: PipelineContext, runId: string, taskId: string, verifierRole: string): Promise<void> {
  const run = ctx.store.require(runId);
  const task = requireTask(run, taskId);
  const projectReviewer = peerRole(run.promptConfig, verifierRole);
  const capability = reviewerCapability(task, verifierRole);
  // The same expertise may be used read-only here and with test-writing access in a different task.
  const verificationPrompt = verificationRequest(task, capability, task.fixLoopCount + 1);
  const participantKey = reviewerAgentKey(verifierRole);
  const existingVerifierId = agentIdForRole(task, participantKey);
  // Verifiers are reused across rounds so they keep their context of what they already flagged.
  if (existingVerifierId) {
    tell(ctx, runId, existingVerifierId, verificationPrompt, { taskId, awaitTool: "slp_verdict", from: "pipeline", summary: `verify round ${task.fixLoopCount + 1}` });
    return;
  }
  if (!task.workspace) throw new Error(`Task '${taskId}' has no worktree`);
  const createdVerifier = await ctx.gateway.createAgent({
    runId,
    role: capability,
    projectRole: projectReviewer.role,
    taskId,
    provider: run.providers.peer,
    thinkingOptionId: run.providers.peerThinkingOptionId ?? undefined,
    permissionModeId: run.providers.peerPermissionModeId ?? undefined,
    peerWorktreePath: task.workspace.cwd,
    workspaceId: task.workspace.workspaceId,
    // Role and task identity lead the title so parallel reviewers are easy to tell apart.
    title: `[${projectReviewer.name}] [${task.id} · ${task.title}]`,
    initialPrompt: verificationPrompt,
    awaitTool: "slp_verdict",
  });
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.agentIds[participantKey] = createdVerifier.agentId;
  });
}

export function onVerdict(
  ctx: PipelineContext,
  runId: string,
  taskId: string,
  verifierRole: string,
  verdictRecord: VerdictRecord,
): string {
  const task = requireTask(ctx.store.require(runId), taskId);
  if (task.phase !== "verifying") throw new ToolError(`Verdict not expected now: task is in phase '${task.phase}'.`);
  if (!task.verifiers.includes(verifierRole)) throw new ToolError(`Role '${verifierRole}' is not assigned to review this task.`);
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.roundVerdicts[verifierRole] = verdictRecord;
  });
  const updatedTask = requireTask(ctx.store.require(runId), taskId);
  const nextQueuedRole = updatedTask.verifierQueue[0];
  // sequential stage: an approval hands over to the next verifier, a rejection ends the round early
  // A rejection must not wake later reviewers: the diff is going to change anyway, so their review would be wasted.
  if (nextQueuedRole && verdictRecord.verdict === "APPROVED") {
    updateTask(ctx, runId, taskId, (mutableTask) => {
      mutableTask.verifierQueue.shift();
    });
    void wakeVerifier(ctx, runId, taskId, nextQueuedRole).catch((wakeError) => logPipelineError(ctx, runId, taskId, wakeError));
    return "Verdict recorded. The next reviewer was woken. End your turn.";
  }
  // A parallel round waits for every verdict so the Implementer gets all issues in one fix request.
  // Business role IDs are user-defined; an inherited object property is never an actual review verdict.
  const everyVerifierAnswered = updatedTask.verifiers.every((role) => Object.hasOwn(updatedTask.roundVerdicts, role));
  const roundRejected = verdictRecord.verdict === "REJECTED";
  if (everyVerifierAnswered || (roundRejected && !updatedTask.verifyParallel)) {
    void closeVerificationRound(ctx, runId, taskId).catch((roundError) => logPipelineError(ctx, runId, taskId, roundError));
  }
  return "Verdict recorded. End your turn.";
}

async function closeVerificationRound(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  const task = requireTask(ctx.store.require(runId), taskId);
  const rejectedIssuesByRole: Record<string, string[]> = {};
  for (const [verifierRole, verdictRecord] of Object.entries(task.roundVerdicts)) {
    if (verdictRecord.verdict === "REJECTED") rejectedIssuesByRole[verifierRole] = verdictRecord.issues;
  }
  if (Object.keys(rejectedIssuesByRole).length === 0) {
    await afterVerificationPassed(ctx, runId, taskId);
    return;
  }
  const nextFixLoopCount = task.fixLoopCount + 1;
  // The counter is bumped before the limit check so the breaker trips on the first round beyond FIX_LOOP_LIMIT.
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.fixLoopCount = nextFixLoopCount;
    mutableTask.phase = "fixing";
  });
  // Circuit breaker: further automatic rounds are burning tokens; hand the decision to the Master Lead.
  if (nextFixLoopCount > FIX_LOOP_LIMIT) {
    pauseForCircuitBreaker(ctx, runId, taskId, rejectedIssuesByRole);
    return;
  }
  const implementerId = agentIdForRole(task, "implementer");
  if (!implementerId) throw new Error(`Task '${taskId}' has no Implementer`);
  tell(ctx, runId, implementerId, fixRequest(rejectedIssuesByRole, nextFixLoopCount), {
    taskId,
    awaitTool: "slp_stage_done",
    from: "pipeline",
    summary: `fix loop ${nextFixLoopCount}/${FIX_LOOP_LIMIT}`,
  });
}

async function afterVerificationPassed(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  // A gate between verification and documentation lets the human inspect the reviewed code before it is documented.
  if (openGateIfRequired(ctx, runId, taskId, "after_verification")) return;
  await startDocumentation(ctx, runId, taskId);
}

// ---------- acceptance report ----------

export async function startDocumentation(ctx: PipelineContext, runId: string, taskId: string): Promise<void> {
  const run = ctx.store.require(runId);
  const task = requireTask(run, taskId);
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.phase = "documenting";
  });
  // The doc may be written by a dedicated peer or by the Implementer, which already knows the change.
  const useDocPeer = task.documentedBy !== "implementer";
  const existingDocPeerId = agentIdForRole(task, "doc");
  if (useDocPeer && !existingDocPeerId && task.workspace) {
    const documentationRole = peerRole(run.promptConfig, task.documentedBy);
    const createdDocPeer = await ctx.gateway.createAgent({
      runId,
      role: "doc",
      projectRole: documentationRole.role,
      taskId,
      provider: run.providers.peer,
      thinkingOptionId: run.providers.peerThinkingOptionId ?? undefined,
      permissionModeId: run.providers.peerPermissionModeId ?? undefined,
      peerWorktreePath: task.workspace.cwd,
      workspaceId: task.workspace.workspaceId,
      title: `[${documentationRole.name}] [${task.id} · ${task.title}]`,
      initialPrompt: documentationRequest(),
      awaitTool: "slp_doc_done",
    });
    updateTask(ctx, runId, taskId, (mutableTask) => {
      mutableTask.agentIds.doc = createdDocPeer.agentId;
    });
    // The new peer received the request as its initial prompt, so no extra tell is needed.
    return;
  }
  const reportAuthorId = (useDocPeer ? existingDocPeerId : null) ?? agentIdForRole(task, "implementer");
  if (!reportAuthorId) throw new Error(`Task '${taskId}' has no agent to submit the acceptance report`);
  tell(ctx, runId, reportAuthorId, documentationRequest(), { taskId, awaitTool: "slp_doc_done", from: "pipeline", summary: "submit acceptance report" });
}

export async function onDocDone(ctx: PipelineContext, runId: string, taskId: string, report: AcceptanceReport, agentId: string): Promise<string> {
  const task = requireTask(ctx.store.require(runId), taskId);
  if (task.phase !== "documenting" || !task.workspace) {
    throw new ToolError(`Doc report not expected now: task is in phase '${task.phase}'.`);
  }
  // Validate content before the same commit both saves the report and makes the task mergeable.
  const acceptedReport = AcceptanceReportSchema.parse(report);
  updateTask(ctx, runId, taskId, (mutableTask) => {
    mutableTask.acceptanceReport = { report: acceptedReport, submittedBy: agentId, submittedAt: new Date().toISOString() };
    mutableTask.phase = "ready_for_merge";
  });
  ctx.logEvent(runId, { taskId, from: "pipeline", to: "master_lead", kind: "task.ready_for_merge", summary: "Acceptance report stored in SQLite", outcome: "delivered" });
  // With a before_merge gate the Master Lead is only told once the human approves, so it cannot merge early.
  if (!openGateIfRequired(ctx, runId, taskId, "before_merge")) notifyMasterLeadReady(ctx, runId, taskId);
  return "Acceptance report saved. The task is ready for merge. End your turn.";
}

export function notifyMasterLeadReady(ctx: PipelineContext, runId: string, taskId: string): void {
  const run = ctx.store.require(runId);
  const task = requireTask(run, taskId);
  if (!task.workspace) return;
  tell(ctx, runId, run.masterLeadAgentId, readyForMergeNotice(task), {
    taskId,
    awaitTool: "slp_archive_task",
    from: "pipeline",
    summary: `${taskId} ready for merge`,
  });
}

function logPipelineError(ctx: PipelineContext, runId: string, taskId: string, failure: unknown): void {
  const failureReason = failure instanceof Error ? failure.message : String(failure);
  // Logged first so the pause reason is traceable in comm-log even if pausing itself fails.
  ctx.logEvent(runId, { taskId, from: "pipeline", to: "-", kind: "pipeline.error", summary: failureReason, outcome: "error" });
  pauseForEscalation(ctx, runId, taskId, `Pipeline error: ${failureReason}`);
}
