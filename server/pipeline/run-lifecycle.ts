// Run-level lifecycle for model-authored pipelines. Fixed task phases remain readable in old
// snapshots, but every new run advances through persisted PipelineState records instead.
import { randomUUID } from "node:crypto";
import { ROLE_LABELS, type RunMode } from "../../shared/roles";
import type { ProviderChoices, Run } from "../../shared/state";
import { assertGitRepository, currentBranchName, mergeIntegrationIntoBase } from "../git/git";
import { createIntegrationWorkspace, openSupervisorWorkspace } from "../git/worktree";
import { loadProjectPrompts } from "../project-prompts/load";
import { validateProjectAgentSettings } from "../project-prompts/agent-settings";
import {
  delegationMessage,
  reportForSupervisor,
  reworkNotice,
  supervisorBriefing,
} from "../prompts/messages";
import { archiveAgentLogged, type PipelineContext } from "./context";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

export const DEFAULT_PROVIDER = "claude/claude-sonnet-5-5";

export interface StartRunInput {
  repoPath: string;
  title?: string;
  baseBranch?: string;
  mode: RunMode;
  providers: Partial<ProviderChoices>;
}
function allPipelinesIntegrated(run: Run): boolean {
  const pipelines = Object.values(run.pipelines);
  return pipelines.length > 0 && pipelines.every((pipeline) => pipeline.status === "integrated");
}

export async function startRun(ctx: PipelineContext, input: StartRunInput) {
  await assertGitRepository(input.repoPath);
  // Fail before creating anything: a non-repo path would otherwise leave orphan workspaces behind.
  const baseBranch = input.baseBranch ?? (await currentBranchName(input.repoPath));
  // Reject bad Markdown before creating worktrees or agents; all children use this same project-root snapshot.
  const promptConfig = await loadProjectPrompts(input.repoPath);
  const runId = randomUUID();
  // Branch names use the short run id so concurrent runs on one repo never collide on slp/<run>/dev.
  const runMetadata: Pick<Run, "repoPath" | "baseBranch" | "integrationBranch" | "title"> = {
    repoPath: input.repoPath,
    baseBranch,
    integrationBranch: `slp/${runId.slice(0, 8)}/dev`,
    title: input.title?.trim() || `SLP ${runId.slice(0, 8)}`,
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
  const paseo = await ctx.holder.get();
  // The Supervisor works in the user's own checkout; only the Master Lead gets an isolated integration worktree.
  const supervisorWorkspace = await openSupervisorWorkspace(paseo, input.repoPath);
  const integrationWorkspace = await createIntegrationWorkspace(paseo, runMetadata);
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
    criteria: null,
    masterSpec: null,
    promptConfig,
    supervisorAgentId: "",
    supervisorWorkspaceId: supervisorWorkspace.workspaceId,
    masterLeadAgentId: "",
    devWorkspaceId: integrationWorkspace.workspaceId,
    devCwd: integrationWorkspace.cwd,
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
    createdAt: now,
    updatedAt: now,
  });
  // Create both run-level agents before prompting either one, so delegation cannot target a missing Lead.
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
  const masterLead = await ctx.gateway.createAgent({
    runId,
    role: "master_lead",
    taskId: null,
    provider: providers.lead,
    thinkingOptionId: providers.leadThinkingOptionId ?? undefined,
    permissionModeId: providers.leadPermissionModeId ?? undefined,
    parentAgentId: supervisor.agentId,
    workspaceId: integrationWorkspace.workspaceId,
    title: `[${ROLE_LABELS.master_lead}] [${runMetadata.title}]`,
    awaitTool: null,
  });
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterLeadAgentId = masterLead.agentId;
    mutableRun.supervisorAgentId = supervisor.agentId;
    mutableRun.status = "delegating";
  });
  // The Supervisor's real delegation starts planning; there is no READY-only Lead warmup turn.
  await ctx.gateway.prompt(supervisor.agentId, supervisorBriefing());
  ctx.logEvent(runId, { taskId: null, from: "manager", to: supervisor.agentId, kind: "run.started", summary: `${runMetadata.title} (${input.mode})`, outcome: "info" });
  return { runId, supervisorAgentId: supervisor.agentId, supervisorWorkspaceId: supervisorWorkspace.workspaceId };
}

export function delegate(ctx: PipelineContext, runId: string, acceptanceCriteria: string): string {
  const run = ctx.store.require(runId);
  // Delegating twice would reset the Master Lead mid-plan; rework uses a fresh pipeline instead.
  if (run.criteria !== null && run.status !== "delegating") {
    throw new ToolError("The project was already delegated. Use slp_request_rework for changes.");
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.criteria = acceptanceCriteria;
    mutableRun.status = "planning";
    // Delegation and its assignment must survive reload together; a saved plan state alone cannot wake the Lead.
    mutableRun.mailbox.push(stageMail(mutableRun.masterLeadAgentId, delegationMessage(acceptanceCriteria), "slp_define_pipeline"));
  });
  return "Delegated to the Master Lead. Tell the Supreme Manager in Vietnamese that work has started, then end your turn.";
}

export function report(ctx: PipelineContext, runId: string, summary: string): string {
  const run = ctx.store.require(runId);
  // Reporting before every pipeline is integrated would let the Supervisor approve an incomplete branch.
  if (run.status !== "running" || !allPipelinesIntegrated(run)) {
    const statuses = Object.values(run.pipelines).map((pipeline) => `${pipeline.name}:${pipeline.status}`).join(", ") || "none";
    throw new ToolError(`Cannot report until every pipeline is integrated. Current pipelines: ${statuses}.`);
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.finalReport = summary;
    mutableRun.status = "reporting";
    const masterLeadRecord = mutableRun.agents[mutableRun.masterLeadAgentId];
    if (masterLeadRecord?.awaitingTool === "slp_report") {
      masterLeadRecord.awaitingTool = null;
      masterLeadRecord.awaitingSince = null;
      masterLeadRecord.nudges = 0;
    }
    mutableRun.mailbox.push(stageMail(mutableRun.supervisorAgentId,
      reportForSupervisor(summary, mutableRun.baseBranch, mutableRun.integrationBranch), "slp_present_to_manager"));
  });
  return "Report sent to the Supervisor. End your turn.";
}

export function requestRework(ctx: PipelineContext, runId: string, feedback: string): string {
  const run = ctx.store.require(runId);
  if (run.status !== "reporting") throw new ToolError(`Cannot request rework while run is '${run.status}'.`);
  // Integrated pipelines are immutable history; rework starts a new Lead-authored pipeline instead of reopening a closed stage.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "planning";
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
    mutableRun.mailbox.push(stageMail(mutableRun.masterLeadAgentId,
      `${reworkNotice(feedback)}\nDefine a fresh pipeline with slp_define_pipeline; do not reopen an integrated pipeline.`, "slp_define_pipeline"));
  });
  return "Sent back to the Master Lead. End your turn while it defines a fresh pipeline.";
}

export function presentToManager(ctx: PipelineContext, runId: string, assessment: string): string {
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
    mutableRun.gate = {
      kind: "final_approval",
      openedAt: new Date().toISOString(),
      note: "Result verified by the Supervisor. Approve to merge the integration branch into the base branch.",
    };
  });
  return "Result presented. Give the Supreme Manager your short Vietnamese report in chat, then end your turn.";
}

// Prevent concurrent agent.archived events and sweeper ticks from running duplicate cascade archives for the same run.
const archivingSupervisorRuns = new Set<string>();

function orderedDependentAgentIds(run: Run): string[] {
  // Archive stage peers before Forked Leads and Master Lead so child sessions close cleanly before their parent coordinators.
  const roleArchiveOrder: Record<string, number> = {
    peer: 0,
    forked_lead: 1,
    master_lead: 2,
  };
  return Object.values(run.agents)
    .filter((agentRecord) => agentRecord.role !== "supervisor" && !agentRecord.archivedAt)
    .sort((leftAgent, rightAgent) => (roleArchiveOrder[leftAgent.role] ?? 3) - (roleArchiveOrder[rightAgent.role] ?? 3))
    .map((agentRecord) => agentRecord.agentId);
}

async function archiveOwnedWorkspaces(ctx: PipelineContext, run: Run): Promise<void> {
  // Unit fixtures that stub only the gateway may not initialize a live Paseo SDK handle.
  if (typeof ctx.holder?.get !== "function" || (typeof ctx.holder.isReady === "function" && !ctx.holder.isReady())) {
    return;
  }
  const paseo = await ctx.holder.get();
  const workspaceIds = new Set<string>([run.devWorkspaceId]);
  for (const workspace of Object.values(run.pipelineWorkspaces)) {
    if (workspace.owned) workspaceIds.add(workspace.workspaceId);
  }
  for (const workspaceId of workspaceIds) {
    // Workspace cleanup is best effort because a user can close an external Paseo workspace first.
    await paseo.workspaces.archive(workspaceId).catch(() => undefined);
  }
}

async function retireRunResources(ctx: PipelineContext, runId: string): Promise<void> {
  const run = ctx.store.require(runId);
  // The Supervisor remains available for the Supreme Manager; every Lead and stage peer is retired in bottom-up order.
  for (const dependentAgentId of orderedDependentAgentIds(run)) {
    await archiveAgentLogged(ctx, runId, null, dependentAgentId);
  }
  await archiveOwnedWorkspaces(ctx, run);
}

// When the Supervisor is archived, cascade-archive all dependent Master Lead, Forked Lead and Peer sessions and stop the run.
export async function handleSupervisorArchived(
  ctx: PipelineContext,
  runId: string,
  archivedAt?: string,
): Promise<void> {
  if (archivingSupervisorRuns.has(runId)) return;
  archivingSupervisorRuns.add(runId);
  try {
    const initialRun = ctx.store.require(runId);
    const effectiveArchivedAt = archivedAt ?? new Date().toISOString();
    const dependentAgentIds = orderedDependentAgentIds(initialRun);
    const wasActiveRun = !["completed", "aborted"].includes(initialRun.status);
    // Persist the stopped run status before awaiting SDK archive calls so in-flight stage creation and sweeper recovery stop immediately.
    ctx.store.mutate(runId, (mutableRun) => {
      const supervisorRecord = mutableRun.agents[mutableRun.supervisorAgentId];
      if (supervisorRecord) {
        supervisorRecord.archivedAt ??= effectiveArchivedAt;
      }
      if (!["completed", "aborted"].includes(mutableRun.status)) {
        mutableRun.status = "aborted";
      }
      mutableRun.gate = null;
      mutableRun.mailbox = [];
      for (const agent of Object.values(mutableRun.agents)) {
        agent.awaitingTool = null;
        agent.awaitingSince = null;
        agent.waitingForAgentId = null;
        agent.deferredTool = null;
      }
    });
    for (const dependentAgentId of dependentAgentIds) {
      await archiveAgentLogged(ctx, runId, null, dependentAgentId);
    }
    // Catch any stage agent whose in-flight creation completed while earlier dependent agents were being archived.
    for (const lateDependentAgentId of orderedDependentAgentIds(ctx.store.require(runId))) {
      await archiveAgentLogged(ctx, runId, null, lateDependentAgentId);
    }
    if (wasActiveRun || dependentAgentIds.length > 0) {
      await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
      ctx.logEvent(runId, {
        taskId: null,
        from: initialRun.supervisorAgentId || "supervisor",
        to: "pipeline",
        kind: "supervisor.archived",
        summary: `Supervisor archived; archived ${dependentAgentIds.length} dependent lead/peer agent(s)`,
        outcome: "info",
      });
    }
  } finally {
    archivingSupervisorRuns.delete(runId);
  }
}

export async function approveMain(ctx: PipelineContext, runId: string): Promise<string> {
  const run = ctx.store.require(runId);
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
  });
  ctx.logEvent(runId, { taskId: null, from: "manager", to: run.baseBranch, kind: "run.merged_to_base", summary: mergeCommit, outcome: "delivered" });
  await retireRunResources(ctx, runId);
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
  const dependentAgentIds = orderedDependentAgentIds(run);
  const supervisorAgentIds = Object.values(run.agents)
    .filter((agentRecord) => agentRecord.role === "supervisor" && !agentRecord.archivedAt)
    .map((agentRecord) => agentRecord.agentId);
  // Mark the run closed before any SDK call so an in-flight stage creator sees the abort and stops.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.status = "aborted";
    mutableRun.mailbox = [];
    for (const agent of Object.values(mutableRun.agents)) {
      agent.awaitingTool = null;
      agent.awaitingSince = null;
      agent.waitingForAgentId = null;
      agent.deferredTool = null;
    }
  });
  // Archive dependent peers and leads before the Supervisor so every child session closes cleanly.
  for (const agentId of [...dependentAgentIds, ...supervisorAgentIds]) {
    await archiveAgentLogged(ctx, runId, null, agentId);
  }
  await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
  ctx.logEvent(runId, { taskId: null, from: "manager", to: "pipeline", kind: "run.aborted", summary: "aborted by the Supreme Manager", outcome: "info" });
}
