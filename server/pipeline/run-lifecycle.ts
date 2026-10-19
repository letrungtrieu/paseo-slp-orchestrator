// Run-level lifecycle for model-authored pipelines. Fixed task phases remain readable in old
// snapshots, but every new run advances through persisted PipelineState records instead.
import { randomUUID } from "node:crypto";
import { ROLE_LABELS, type RunMode } from "../../shared/roles";
import type { ProviderChoices, Run } from "../../shared/state";
import { assertGitRepository, currentBranchName, mergeIntegrationIntoBase } from "../git/git";
import { openSupervisorWorkspace } from "../git/worktree";
import { loadProjectPrompts } from "../project-prompts/load";
import { validateProjectAgentSettings } from "../project-prompts/agent-settings";
import {
  delegationMessage,
  reportForSupervisor,
  reworkNotice,
  supervisorBriefing,
} from "../prompts/messages";
import {
  archiveAgentSubtree,
  archiveOwnedWorkspaces,
  handleAgentArchived,
  handleSupervisorArchived,
} from "./agent-hierarchy";
import { archiveAgentLogged, type PipelineContext } from "./context";
import { ToolError } from "./tool-error";
import { stageMail } from "./stage-mail";

export { handleAgentArchived, handleSupervisorArchived };

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
  // Always detect the currently checked-out branch of the project repository as the base branch.
  const baseBranch = await currentBranchName(input.repoPath);
  // Reject bad Markdown before creating worktrees or agents; all children use this same project-root snapshot.
  const promptConfig = await loadProjectPrompts(input.repoPath);
  const runId = randomUUID();
  // Both Supervisor and Master Lead work directly on baseBranch in the main checkout; only pipeline peers use separate worktree branches.
  const runMetadata: Pick<Run, "repoPath" | "baseBranch" | "integrationBranch" | "title"> = {
    repoPath: input.repoPath,
    baseBranch,
    integrationBranch: baseBranch,
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
    criteria: null,
    masterSpec: null,
    promptConfig,
    supervisorAgentId: "",
    supervisorWorkspaceId: supervisorWorkspace.workspaceId,
    masterLeadAgentId: "",
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
  });
  // Prompt only the Supervisor at startup so no idle Master Lead session clutters the workspace before delegation.
  await ctx.gateway.prompt(supervisor.agentId, supervisorBriefing());
  ctx.logEvent(runId, { taskId: null, from: "manager", to: supervisor.agentId, kind: "run.started", summary: `${runMetadata.title} (${input.mode})`, outcome: "info" });
  return { runId, supervisorAgentId: supervisor.agentId, supervisorWorkspaceId: supervisorWorkspace.workspaceId };
}

// Reuse an unarchived Master Lead when available, or spawn a fresh Master Lead in the shared base workspace when starting or resuming delegation.
async function ensureActiveMasterLead(ctx: PipelineContext, runId: string): Promise<string> {
  const initialRun = ctx.store.require(runId);
  const existingMasterLeadRecord = initialRun.masterLeadAgentId
    ? initialRun.agents[initialRun.masterLeadAgentId]
    : undefined;
  if (existingMasterLeadRecord && !existingMasterLeadRecord.archivedAt) {
    return existingMasterLeadRecord.agentId;
  }
  const spawnedMasterLead = await ctx.gateway.createAgent({
    runId,
    role: "master_lead",
    taskId: null,
    provider: initialRun.providers.lead,
    thinkingOptionId: initialRun.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: initialRun.providers.leadPermissionModeId ?? undefined,
    parentAgentId: initialRun.supervisorAgentId || undefined,
    workspaceId: initialRun.devWorkspaceId,
    title: `[${ROLE_LABELS.master_lead}] [${initialRun.title}]`,
    awaitTool: null,
  });
  const latestRun = ctx.store.require(runId);
  if (latestRun.status === "aborted") {
    await ctx.gateway.archive(spawnedMasterLead.agentId).catch(() => undefined);
    throw new ToolError("This run has finished.");
  }
  return spawnedMasterLead.agentId;
}

export async function delegate(ctx: PipelineContext, runId: string, acceptanceCriteria: string): Promise<string> {
  const run = ctx.store.require(runId);
  // Delegating twice during an active cycle would reset the Master Lead mid-plan; allow fresh delegation once a prior cycle completed.
  if (run.criteria !== null && run.status !== "delegating" && run.status !== "completed") {
    throw new ToolError("The project was already delegated. Use slp_request_rework for changes.");
  }
  const activeMasterLeadId = await ensureActiveMasterLead(ctx, runId);
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterLeadAgentId = activeMasterLeadId;
    mutableRun.criteria = acceptanceCriteria;
    mutableRun.status = "planning";
    // Delegation and its assignment must survive reload together; a saved plan state alone cannot wake the Lead.
    mutableRun.mailbox.push(stageMail(activeMasterLeadId, delegationMessage(acceptanceCriteria), "slp_define_pipeline"));
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

export async function requestRework(ctx: PipelineContext, runId: string, feedback: string): Promise<string> {
  const run = ctx.store.require(runId);
  // Allow rework during initial reporting, at the final approval gate, or when follow-up changes are requested after completion.
  if (run.status !== "reporting" && run.status !== "awaiting_user" && run.status !== "completed") {
    throw new ToolError(`Cannot request rework while run is '${run.status}'.`);
  }
  const activeMasterLeadId = await ensureActiveMasterLead(ctx, runId);
  // Integrated pipelines are immutable history; rework starts a new Lead-authored pipeline instead of reopening a closed stage.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.masterLeadAgentId = activeMasterLeadId;
    mutableRun.status = "planning";
    mutableRun.gate = null;
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
      `${reworkNotice(feedback)}\nDefine a fresh pipeline with slp_define_pipeline; do not reopen an integrated pipeline.`, "slp_define_pipeline"));
  });
  return "Sent back to the Master Lead. End your turn while it defines a fresh pipeline.";
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
  // Recursively archive dependent peers and leads bottom-up before closing the root Supervisor session.
  await archiveAgentSubtree(ctx, runId, run.supervisorAgentId, { includeRoot: true });
  for (const remainingAgent of Object.values(ctx.store.require(runId).agents)) {
    if (!remainingAgent.archivedAt) {
      await archiveAgentLogged(ctx, runId, null, remainingAgent.agentId);
    }
  }
  await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
  ctx.logEvent(runId, { taskId: null, from: "manager", to: "pipeline", kind: "run.aborted", summary: "aborted by the Supreme Manager", outcome: "info" });
}
