// Run-level lifecycle for model-authored pipelines. Fixed task phases remain readable in old
// snapshots, but every new run advances through persisted PipelineState records instead.
import { randomUUID } from "node:crypto";
import { describeTicketRunBlocker, type BoardTicket } from "../../shared/board";
import { ROLE_LABELS, isPipelineLeadRole, type RunMode } from "../../shared/roles";
import type { ProviderChoices, Run } from "../../shared/state";
import { DEFAULT_ORCHESTRATION_SETTINGS, type OrchestrationSettings } from "../../shared/orchestration";
import { assertGitRepository, currentBranchName, mergeIntegrationIntoBase } from "../git/git";
import { openSupervisorWorkspace } from "../git/worktree";
import { loadProjectPrompts } from "../project-prompts/load";
import { validateProjectAgentSettings } from "../project-prompts/agent-settings";
import { reportForSupervisor, reworkNotice, supervisorBriefing } from "../prompts/messages";
import { qaReworkNotice } from "../prompts/qa-messages";
import { delegate, ensureActiveMasterLead } from "./delegation";
import { qaVerificationComplete, runHasQaLead } from "./qa/qa-phase-state";
import {
  archiveAgentSubtree,
  archiveOwnedWorkspaces,
  handleAgentArchived,
  handleSupervisorArchived,
} from "./agent-hierarchy";
import { archiveAgentLogged, type PipelineContext } from "./context";
import { releaseEndedRunTickets } from "./ticket-run-release";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

export { handleAgentArchived, handleSupervisorArchived };
// Delegation lives in its own module; re-exported so existing callers keep one lifecycle entry point.
export { delegate } from "./delegation";

export const DEFAULT_PROVIDER = "claude/claude-sonnet-5-5";

export interface StartRunInput {
  repoPath: string;
  name: string;
  baseBranch?: string;
  mode: RunMode;
  providers: Partial<ProviderChoices>;
  // Tests and RPC callers may pin the policy; otherwise the host settings at start time apply.
  orchestration?: OrchestrationSettings;
  // The prepared Kanban ticket this Run delivers.
  ticketId?: string;
}

// Refuses before any agent exists, so a ticket that is not ready cannot leave a half-started Run behind.
function requireReadyTicket(ctx: PipelineContext, ticketId: string, repoPath: string): BoardTicket {
  // A ticket still tied to an aborted Run would otherwise refuse every new Run.
  releaseEndedRunTickets(ctx, repoPath);
  const startingTicket = ctx.store.board.find(ticketId, repoPath);
  if (!startingTicket) throw new ToolError(`Kanban ticket '${ticketId}' was not found in this project.`);
  const runBlocker = describeTicketRunBlocker(startingTicket);
  if (runBlocker) throw new ToolError(runBlocker);
  return startingTicket;
}

async function currentOrchestrationSettings(ctx: PipelineContext): Promise<OrchestrationSettings> {
  try {
    return (await ctx.getSettings?.())?.orchestration ?? DEFAULT_ORCHESTRATION_SETTINGS;
  } catch {
    // An unreadable settings store must not block starting a run; the defaults are the safe policy.
    return DEFAULT_ORCHESTRATION_SETTINGS;
  }
}

export function allPipelinesIntegrated(run: Run): boolean {
  const pipelines = Object.values(run.pipelines);
  if (pipelines.length === 0 || !pipelines.every((pipeline) => pipeline.status === "integrated")) {
    return false;
  }
  // If any parallel Lead has not yet defined its pipeline, the run is still executing parallel tracks.
  const hasPendingLeadPlanning = Object.values(run.agents).some(
    (agentRecord) =>
      agentRecord.role === "master_lead" &&
      !agentRecord.archivedAt &&
      agentRecord.awaitingTool === "slp_define_pipeline",
  );
  return !hasPendingLeadPlanning;
}

export async function startRun(ctx: PipelineContext, input: StartRunInput) {
  await assertGitRepository(input.repoPath);
  const startingTicket = input.ticketId ? requireReadyTicket(ctx, input.ticketId, input.repoPath) : null;
  // Always detect the currently checked-out branch of the project repository as the base branch.
  const baseBranch = await currentBranchName(input.repoPath);
  // Reject bad Markdown before creating worktrees or agents; all children use this same project-root snapshot.
  const promptConfig = await loadProjectPrompts(input.repoPath);
  const runId = randomUUID();
  // Sequence numbers are derived from the total run count ever persisted (including archived runs),
  // so re-running the same project name never collides with a prior run's display title.
  const runSequence = ctx.store.list().length + 1;
  // Both Supervisor and Master Lead work directly on baseBranch in the main checkout; only pipeline peers use separate worktree branches.
  const runMetadata: Pick<Run, "repoPath" | "baseBranch" | "integrationBranch" | "title"> = {
    repoPath: input.repoPath,
    baseBranch,
    integrationBranch: baseBranch,
    // The name is a required field now; the "#<sequence>" suffix keeps repeated run names distinguishable in lists and agent titles.
    title: `${input.name.trim()} #${runSequence}`,
  };
  // Each role can use a different provider so the user can mix a strong Lead with cheaper peers.
  const providers: ProviderChoices = {
    supervisor: input.providers.supervisor ?? DEFAULT_PROVIDER,
    lead: input.providers.lead ?? DEFAULT_PROVIDER,
    peer: input.providers.peer ?? DEFAULT_PROVIDER,
    supervisorThinkingOptionId: input.providers.supervisorThinkingOptionId ?? null,
    leadThinkingOptionId: input.providers.leadThinkingOptionId ?? null,
    peerThinkingOptionId: input.providers.peerThinkingOptionId ?? null,
    supervisorPermissionModeId: input.providers.supervisorPermissionModeId ?? null,
    leadPermissionModeId: input.providers.leadPermissionModeId ?? null,
    peerPermissionModeId: input.providers.peerPermissionModeId ?? null,
  };
  validateProjectAgentSettings(promptConfig, providers);
  // Snapshot the orchestration policy so changing host settings mid-run never changes how this run forks or caps rework.
  const orchestration = input.orchestration ?? await currentOrchestrationSettings(ctx);
  const paseo = await ctx.holder.get();
  // Supervisor, Master Lead, and Forked Leads share the main checkout so finalized pipeline branches merge straight into baseBranch.
  const supervisorWorkspace = await openSupervisorWorkspace(paseo, input.repoPath);
  const now = new Date().toISOString();
  // Initialize dynamic collections explicitly so SQLite snapshots are immediately self-describing.
  ctx.store.insert({
    id: runId,
    ...runMetadata,
    mode: input.mode,
    status: "initializing",
    // The explicit marker keeps the sweeper from reviving pre-pipeline runs whose records happen
    // to contain an empty task set after migration.
    engineVersion: "dynamic-stages-v1",
    providers,
    orchestration,
    criteria: null,
    masterSpec: null,
    productSpec: null,
    promptConfig,
    supervisorAgentId: "",
    supervisorWorkspaceId: supervisorWorkspace.workspaceId,
    masterLeadAgentId: "",
    qaLeadAgentId: "",
    devWorkspaceId: supervisorWorkspace.workspaceId,
    devCwd: supervisorWorkspace.cwd,
    tasks: {},
    pipelines: {},
    pipelineWorkspaces: {},
    agents: {},
    mailbox: [],
    questions: [],
    gate: null,
    finalReport: null,
    supervisorReport: null,
    peerReports: [],
    forkDegradedReason: null,
    archivedAt: null,
    archivedFromStatus: null,
    archiveWarningPending: false,
    createdAt: now,
    updatedAt: now,
  });
  // Only spawn the Supervisor at session startup; Master Lead is created lazily when the Supervisor delegates work.
  const supervisor = await ctx.gateway.createAgent({
    runId,
    role: "supervisor",
    taskId: null,
    provider: providers.supervisor,
    thinkingOptionId: providers.supervisorThinkingOptionId ?? undefined,
    permissionModeId: providers.supervisorPermissionModeId ?? undefined,
    workspaceId: supervisorWorkspace.workspaceId,
    title: `[${ROLE_LABELS.supervisor}] [${runMetadata.title}]`,
    awaitTool: null,
  });
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.supervisorAgentId = supervisor.agentId;
    mutableRun.status = "delegating";
    // The Spec is the human-approved contract, so delegation inherits it even when the Supervisor does not repeat it.
    if (startingTicket) mutableRun.productSpec = startingTicket.specRevisions.at(-1)?.content ?? null;
  });
  // Binding before the briefing means the Supervisor's first board read already finds its ticket.
  if (startingTicket) ctx.store.board.bindRun(startingTicket.id, input.repoPath, runId);
  // Prompt only the Supervisor at startup so no idle Master Lead session clutters the workspace before delegation.
  await ctx.gateway.prompt(supervisor.agentId, supervisorBriefing(startingTicket));
  ctx.logEvent(runId, { taskId: null, from: "manager", to: supervisor.agentId, kind: "run.started", summary: `${runMetadata.title} (${input.mode})`, outcome: "info" });
  return { runId, supervisorAgentId: supervisor.agentId, supervisorWorkspaceId: supervisorWorkspace.workspaceId };
}

export function report(ctx: PipelineContext, runId: string, summary: string, callerAgentId?: string): string {
  const run = ctx.store.require(runId);
  // A QA Lead from a retired cycle must not report on the current cycle's QA branch.
  if (runHasQaLead(run) && callerAgentId && callerAgentId !== run.qaLeadAgentId) {
    throw new ToolError("Only this run's current QA Lead can report to the Supervisor.");
  }
  const pipelineStatuses = Object.values(run.pipelines).map((pipeline) => `${pipeline.name}:${pipeline.status}`).join(", ") || "none";
  // Merged-but-unverified code is exactly what the QA phase exists to prevent from reaching the Supervisor;
  // checking it first gives the QA Lead the concrete missing step instead of a generic integration error.
  if (runHasQaLead(run) && (run.status !== "running" || !qaVerificationComplete(run))) {
    throw new ToolError(`Cannot report until a QA pipeline has verified the QA branch after the last feature merge and been closed with slp_finalize_pipeline. Current pipelines: ${pipelineStatuses}.`);
  }
  // Reporting before every pipeline is integrated would let the Supervisor approve an incomplete branch.
  if (run.status !== "running" || !allPipelinesIntegrated(run)) {
    throw new ToolError(`Cannot report until every pipeline is integrated. Current pipelines: ${pipelineStatuses}.`);
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.finalReport = summary;
    mutableRun.status = "reporting";
    for (const agentRecord of Object.values(mutableRun.agents)) {
      if (isPipelineLeadRole(agentRecord.role) && agentRecord.awaitingTool === "slp_report") {
        agentRecord.awaitingTool = null;
        agentRecord.awaitingSince = null;
        agentRecord.nudges = 0;
      }
    }
    mutableRun.mailbox.push(stageMail(mutableRun.supervisorAgentId,
      reportForSupervisor(summary, mutableRun.baseBranch, mutableRun.integrationBranch), "slp_present_to_manager"));
  });
  return "Report sent to the Supervisor. End your turn.";
}

export async function requestRework(ctx: PipelineContext, runId: string, feedback: string): Promise<string> {
  const run = ctx.store.require(runId);
  // Allow rework during initial reporting, at the final approval gate, or when follow-up changes are requested after completion.
  if (run.status !== "reporting" && run.status !== "awaiting_user" && run.status !== "completed") {
    throw new ToolError(`Cannot request rework while run is '${run.status}'.`);
  }
  // The QA Lead owns the verified QA branch, so fixes and re-verification stay there instead of opening new feature worktrees.
  if (runHasQaLead(run)) {
    // After completion the QA branch is merged and deleted, so a follow-up is a new cycle with fresh Leads and a fresh QA Lead.
    return run.status === "completed" ? delegate(ctx, runId, feedback) : requestQaRework(ctx, runId, feedback);
  }
  const { agentId: activeMasterLeadId, workspace } = await ensureActiveMasterLead(ctx, runId, "rework");
  // Integrated pipelines are immutable history; rework starts a new Lead-authored pipeline instead of reopening a closed stage.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterLeadAgentId = activeMasterLeadId;
    mutableRun.status = "planning";
    mutableRun.gate = null;
    if (!Object.hasOwn(mutableRun.pipelineWorkspaces, workspace.workspaceId)) {
      mutableRun.pipelineWorkspaces[workspace.workspaceId] = { ...workspace, owned: false };
    }
    const leadRecord = mutableRun.agents[activeMasterLeadId];
    if (leadRecord) {
      leadRecord.workspaceId = workspace.workspaceId;
      leadRecord.worktreePath = workspace.cwd;
      leadRecord.pipelineId = null;
    }
    const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
    if (supervisorRecord) {
      supervisorRecord.awaitingTool = null;
      supervisorRecord.awaitingSince = null;
      supervisorRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === mutableRun.supervisorAgentId && queuedMessage.awaitTool === "slp_present_to_manager"),
    );
    // A rework request is a new pipeline assignment, so its message belongs to the same durable transition.
    mutableRun.mailbox.push(stageMail(activeMasterLeadId,
      `${reworkNotice(feedback)}\nYour checkout is \`${workspace.cwd}\` (branch \`${workspace.branch}\`). Define a fresh pipeline with slp_define_pipeline; do not reopen an integrated pipeline.`, "slp_define_pipeline"));
  });
  return "Sent back to the Lead. End your turn while it defines a fresh pipeline.";
}

function requestQaRework(ctx: PipelineContext, runId: string, feedback: string): string {
  ctx.store.mutate(runId, (mutableRun) => {
    // Planning makes slp_define_pipeline the QA Lead's owed tool, which recovery and nudges then enforce.
    mutableRun.status = "planning";
    mutableRun.gate = null;
    mutableRun.masterLeadAgentId = mutableRun.qaLeadAgentId;
    const qaLeadRecord = mutableRun.agents[mutableRun.qaLeadAgentId];
    if (qaLeadRecord) {
      qaLeadRecord.pipelineId = null;
      qaLeadRecord.stageId = null;
    }
    const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
    if (supervisorRecord) {
      supervisorRecord.awaitingTool = null;
      supervisorRecord.awaitingSince = null;
      supervisorRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === mutableRun.supervisorAgentId && queuedMessage.awaitTool === "slp_present_to_manager"),
    );
    mutableRun.mailbox.push(stageMail(mutableRun.qaLeadAgentId, qaReworkNotice(feedback, mutableRun), "slp_define_pipeline"));
  });
  return "Sent back to the QA Lead. End your turn while it defines fix and re-verification stages.";
}

export async function presentToManager(ctx: PipelineContext, runId: string, assessment: string): Promise<string> {
  const run = ctx.store.require(runId);
  if (run.status !== "reporting") throw new ToolError("There is no Master Lead report to present yet.");
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "awaiting_user";
    mutableRun.supervisorReport = assessment;
    const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
    if (supervisorRecord) {
      supervisorRecord.awaitingTool = null;
      supervisorRecord.awaitingSince = null;
      supervisorRecord.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) => !(queuedMessage.toAgentId === mutableRun.supervisorAgentId && queuedMessage.awaitTool === "slp_present_to_manager"),
    );
  });
  // Autonomous SLP runs merge the verified integration branch directly into baseBranch when the Supervisor accepts the result.
  try {
    const mergeSummary = await approveMain(ctx, runId);
    return `${mergeSummary}. Result presented and merged into ${run.baseBranch}. Give the Supreme Manager your short Vietnamese report in chat, then end your turn.`;
  } catch (autoMergeError) {
    const failureNote = autoMergeError instanceof Error ? autoMergeError.message : String(autoMergeError);
    ctx.store.mutate(runId, (mutableRun) => {
      if (mutableRun.status === "awaiting_user") {
        mutableRun.gate = {
          kind: "final_approval",
          openedAt: new Date().toISOString(),
          note: `Auto-merge into '${mutableRun.baseBranch}' was blocked (${failureNote}). Clean the base checkout and approve to merge.`,
        };
      }
    });
    return `Result verified, but auto-merge into ${run.baseBranch} was blocked: ${failureNote}. Inform the Supreme Manager in Vietnamese, then end your turn.`;
  }
}

async function retireRunResources(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // The Supervisor remains available for the Supreme Manager; Master Lead, Forked Leads and stage peers are retired bottom-up.
  await archiveAgentSubtree(ctx, runId, run.supervisorAgentId);
  await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
}

export async function approveMain(ctx: PipelineContext, runId: string): Promise<string> {
  const run = ctx.store.require(runId);
  if (run.status === "completed") {
    return `Already merged ${run.integrationBranch} into ${run.baseBranch}`;
  }
  if (run.status !== "awaiting_user") throw new Error(`Run is '${run.status}', not awaiting approval`);
  if (!allPipelinesIntegrated(run)) throw new ToolError("Every pipeline must be integrated before final approval.");
  // Merge happens before the status change so a conflict leaves the run awaiting approval and the human can retry.
  const mergeCommit = await mergeIntegrationIntoBase(run.repoPath, run.baseBranch, run.integrationBranch);
  ctx.store.mutate(runId, (mutableRun) => {
    // An abort may overlap git's subprocess; record the actual merge below without reopening the stopped run.
    if (mutableRun.status === "aborted") return;
    mutableRun.status = "completed";
    mutableRun.gate = null;
    mutableRun.mailbox = [];
    for (const agent of Object.values(mutableRun.agents)) {
      agent.awaitingTool = null;
      agent.awaitingSince = null;
    }
    // Move all Kanban tickets belonging to this completed run into the DONE column.
    for (const completedTicket of ctx.store.board.listByRun(runId)) {
      ctx.store.board.setColumn(completedTicket.id, "done", mutableRun.repoPath);
    }
  });
  ctx.logEvent(runId, { taskId: null, from: "manager", to: run.baseBranch, kind: "run.merged_to_base", summary: mergeCommit, outcome: "delivered" });
  await retireRunResources(ctx, runId);
  // The QA worktree and branch are gone now; point integration back at the base checkout for any later cycle.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.integrationBranch = mutableRun.baseBranch;
    mutableRun.devCwd = mutableRun.repoPath;
    mutableRun.devWorkspaceId = mutableRun.supervisorWorkspaceId;
  });
  return `Merged ${run.integrationBranch} into ${run.baseBranch} (${mergeCommit.slice(0, 8)})`;
}

export async function approveRunGate(ctx: PipelineContext, runId: string, taskId: string | null): Promise<string> {
  const run = ctx.store.require(runId);
  // Dynamic pipeline gates have their own RPC; the run-level gate is only final approval.
  if (taskId || run.gate?.kind !== "final_approval") {
    throw new ToolError("This run uses dynamic pipeline gates; approve the pipeline gate or final run approval from its matching control.");
  }
  return approveMain(ctx, runId);
}

export async function abortRun(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // Mark the run closed before any SDK call so an in-flight stage creator sees the abort and stops.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "aborted";
    mutableRun.archivedAt = null;
    mutableRun.archivedFromStatus = null;
    mutableRun.archiveWarningPending = false;
    mutableRun.mailbox = [];
    for (const agent of Object.values(mutableRun.agents)) {
      agent.awaitingTool = null;
      agent.awaitingSince = null;
    }
  });
  // Recursively archive dependent peers and leads bottom-up before closing the root Supervisor session.
  await archiveAgentSubtree(ctx, runId, run.supervisorAgentId, { includeRoot: true });
  for (const remainingAgent of Object.values(ctx.store.require(runId).agents)) {
    if (!remainingAgent.archivedAt) {
      await archiveAgentLogged(ctx, runId, null, remainingAgent.agentId);
    }
  }
  await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
  // The feature goes back to the board so the human can start it again once the problem is fixed.
  ctx.store.board.releaseRun(runId);
  ctx.logEvent(runId, { taskId: null, from: "manager", to: "pipeline", kind: "run.aborted", summary: "aborted by the Supreme Manager", outcome: "info" });
}
