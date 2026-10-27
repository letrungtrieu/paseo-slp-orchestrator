// Supervisor delegation: provisions the QA worktree and QA Lead, then one dedicated feature Lead per delegated
// feature, and briefs each with the full roster so parallel work aligns before it merges into the QA branch.
import type { DelegatedFeature, DelegationSubmission } from "../../shared/pipeline";
import { ROLE_LABELS } from "../../shared/roles";
import type { Run } from "../../shared/state";
import { delegationMessage, type SiblingLeadSummary } from "../prompts/messages";
import { qaLeadPreparationBriefing } from "../prompts/qa-messages";
import type { PipelineContext } from "./context";
import { createPipelineWorktree, openPipelineWorktree } from "./pipeline-workspaces";
import { provisionQaWorkspace, spawnQaLead } from "./qa/qa-lead-provisioning";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";

// Normalize single-string or multi-feature Supervisor delegation input into a uniform task list and overall criteria.
function normalizeDelegationSubmission(
  run: Run,
  rawInput: string | DelegationSubmission,
): { overallCriteria: string; overallProductSpec: string | null; sharedContext?: string; tasks: DelegatedFeature[] } {
  // A plain string is the follow-up path (rework after completion), which always means one cohesive feature.
  if (typeof rawInput === "string") {
    const trimmedCriteria = rawInput.trim();
    return {
      overallCriteria: trimmedCriteria,
      overallProductSpec: null,
      tasks: [{ name: run.title || "feature", acceptanceCriteria: trimmedCriteria }],
    };
  }
  const tasks =
    rawInput.tasks && rawInput.tasks.length > 0
      ? rawInput.tasks
      : [
          {
            name: run.title || "feature",
            acceptanceCriteria: (rawInput.acceptanceCriteria ?? "").trim(),
            productSpec: rawInput.productSpec,
          },
        ];
  // Without overall criteria the per-feature criteria together define what the QA Lead must verify.
  const overallCriteria =
    rawInput.acceptanceCriteria?.trim()
    || tasks.map((task) => `${task.name}: ${task.acceptanceCriteria}`).join("\n");
  // The run keeps every feature's spec together so the QA Lead and the Supervisor see one complete contract.
  const featureSpecs = tasks.filter((task) => task.productSpec).map((task) => `## ${task.name}\n${task.productSpec}`);
  return {
    overallCriteria,
    overallProductSpec: rawInput.productSpec?.trim() || (featureSpecs.length > 0 ? featureSpecs.join("\n\n") : null),
    sharedContext: rawInput.sharedContext?.trim() || undefined,
    tasks,
  };
}

// Provision or open a dedicated Git worktree for a Lead so the Lead and its stage Peers share the exact same cwd.
async function provisionLeadWorktree(
  ctx: PipelineContext,
  runId: string,
  featureName: string,
  explicitWorktreePath?: string,
) {
  let targetWorktreePath = explicitWorktreePath?.trim() ?? "";
  // The Supervisor may name an existing checkout; otherwise a fresh slp/* branch forks from the QA branch.
  if (!targetWorktreePath) {
    const createdWorktreePayload = JSON.parse(
      await createPipelineWorktree(ctx, runId, featureName, { allowDuringDelegation: true }),
    ) as { cwd: string };
    targetWorktreePath = createdWorktreePayload.cwd;
  }
  const latestRun = ctx.store.require(runId);
  return openPipelineWorktree(ctx, latestRun, targetWorktreePath);
}

// Reuse an unarchived Lead when available, or spawn a fresh Lead inside a dedicated worktree when starting or resuming delegation.
export async function ensureActiveMasterLead(
  ctx: PipelineContext,
  runId: string,
  featureName?: string,
  explicitWorktreePath?: string,
): Promise<{
  agentId: string;
  workspace: Awaited<ReturnType<typeof openPipelineWorktree>>;
}> {
  const initialRun = ctx.store.require(runId);
  const existingMasterLeadRecord = initialRun.masterLeadAgentId
    ? initialRun.agents[initialRun.masterLeadAgentId]
    : undefined;
  const workspace = await provisionLeadWorktree(
    ctx,
    runId,
    featureName ?? initialRun.title ?? "feature",
    explicitWorktreePath,
  );
  // After a QA handover masterLeadAgentId names the QA Lead, which must never be reused as a feature Lead.
  if (existingMasterLeadRecord && !existingMasterLeadRecord.archivedAt && existingMasterLeadRecord.role === "master_lead") {
    return { agentId: existingMasterLeadRecord.agentId, workspace };
  }
  const spawnedMasterLead = await ctx.gateway.createAgent({
    runId,
    role: "master_lead",
    taskId: null,
    provider: initialRun.providers.lead,
    thinkingOptionId: initialRun.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: initialRun.providers.leadPermissionModeId ?? undefined,
    parentAgentId: initialRun.supervisorAgentId || undefined,
    workspaceId: workspace.workspaceId,
    peerWorktreePath: workspace.cwd,
    title: `[${ROLE_LABELS.master_lead}] [${featureName ?? initialRun.title}]`,
    awaitTool: null,
  });
  const latestRun = ctx.store.require(runId);
  // An abort can land while the SDK creates the session; close the late arrival instead of leaking it.
  if (latestRun.status === "aborted") {
    await ctx.gateway.archive(spawnedMasterLead.agentId).catch(() => undefined);
    throw new ToolError("This run has finished.");
  }
  return { agentId: spawnedMasterLead.agentId, workspace };
}

export async function delegate(
  ctx: PipelineContext,
  runId: string,
  rawInput: string | DelegationSubmission,
): Promise<string> {
  const run = ctx.store.require(runId);
  // Delegating twice during an active cycle would reset Leads mid-plan; allow fresh delegation once a prior cycle completed.
  if (run.criteria !== null && run.status !== "delegating" && run.status !== "completed") {
    throw new ToolError("The project was already delegated. Use slp_request_rework for changes.");
  }
  const { overallCriteria, overallProductSpec, sharedContext, tasks } = normalizeDelegationSubmission(run, rawInput);
  // The QA branch must exist first: feature worktrees fork from the run's integration branch, which it becomes.
  const qaWorkspace = await provisionQaWorkspace(ctx, runId);
  const provisionedLeads: Array<{
    agentId: string;
    task: DelegatedFeature;
    workspace: Awaited<ReturnType<typeof openPipelineWorktree>>;
  }> = [];

  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex];
    // A single feature reuses a still-live feature Lead so a delegation retry does not spawn a duplicate.
    if (taskIndex === 0 && tasks.length === 1) {
      const { agentId, workspace } = await ensureActiveMasterLead(ctx, runId, task.name, task.worktree);
      provisionedLeads.push({ agentId, task, workspace });
      continue;
    }
    const workspace = await provisionLeadWorktree(ctx, runId, task.name, task.worktree);
    const currentRun = ctx.store.require(runId);
    const spawnedLead = await ctx.gateway.createAgent({
      runId,
      role: "master_lead",
      taskId: null,
      provider: currentRun.providers.lead,
      thinkingOptionId: currentRun.providers.leadThinkingOptionId ?? undefined,
      permissionModeId: currentRun.providers.leadPermissionModeId ?? undefined,
      parentAgentId: currentRun.supervisorAgentId || undefined,
      workspaceId: workspace.workspaceId,
      peerWorktreePath: workspace.cwd,
      title: `[${ROLE_LABELS.master_lead}] [${task.name}]`,
      awaitTool: null,
    });
    if (ctx.store.require(runId).status === "aborted") {
      await ctx.gateway.archive(spawnedLead.agentId).catch(() => undefined);
      throw new ToolError("This run has finished.");
    }
    provisionedLeads.push({ agentId: spawnedLead.agentId, task, workspace });
  }
  // Spawned with the feature Leads so it can plan verification while they build, as the human asked.
  const qaLeadAgentId = await spawnQaLead(ctx, runId, qaWorkspace);
  const featureLeadRoster: SiblingLeadSummary[] = provisionedLeads.map(({ agentId, task, workspace }) => ({
    agentId,
    featureName: task.name,
    worktreePath: workspace.cwd,
    branch: workspace.branch,
    acceptanceCriteria: task.acceptanceCriteria,
    productSpec: task.productSpec ?? null,
  }));
  const qaLeadContact = { agentId: qaLeadAgentId, worktreePath: qaWorkspace.cwd, branch: qaWorkspace.branch };

  ctx.store.mutate(runId, (mutableRun) => {
    // The first feature Lead is accountable until the QA handover repoints this at the QA Lead.
    mutableRun.masterLeadAgentId = provisionedLeads[0].agentId;
    mutableRun.criteria = overallCriteria;
    mutableRun.productSpec = overallProductSpec;
    mutableRun.status = "planning";
    for (const { agentId, task, workspace } of provisionedLeads) {
      if (!Object.hasOwn(mutableRun.pipelineWorkspaces, workspace.workspaceId)) {
        mutableRun.pipelineWorkspaces[workspace.workspaceId] = { ...workspace, owned: false };
      }
      const leadRecord = mutableRun.agents[agentId];
      if (leadRecord) {
        leadRecord.workspaceId = workspace.workspaceId;
        leadRecord.worktreePath = workspace.cwd;
        leadRecord.featureName = task.name;
        leadRecord.featureCriteria = task.acceptanceCriteria;
        leadRecord.featureSpec = task.productSpec ?? null;
      }
      // Persist each delegated feature as a project-scoped Kanban ticket in the SPEC column.
      ctx.store.board.saveSpec({
        repoPath: mutableRun.repoPath,
        title: task.name,
        acceptanceCriteria: task.acceptanceCriteria,
        specContent: task.productSpec ?? overallProductSpec ?? task.acceptanceCriteria,
        author: "supervisor",
        summary: "Delegated feature specification",
        activeRunId: runId,
        leadAgentId: agentId,
      });
    }
    // Deliver each Lead's assignment alongside the full roster of sibling Leads so parallel features stay aligned.
    for (const currentLead of provisionedLeads) {
      const siblingLeads = featureLeadRoster.filter((candidate) => candidate.agentId !== currentLead.agentId);
      const hasMultipleFeatures = provisionedLeads.length > 1 || Boolean(sharedContext);
      const messageBody = delegationMessage(
        overallCriteria,
        hasMultipleFeatures
          ? {
              featureName: currentLead.task.name,
              featureCriteria: currentLead.task.acceptanceCriteria,
              productSpec: currentLead.task.productSpec,
              worktreePath: currentLead.workspace.cwd,
              branch: currentLead.workspace.branch,
              sharedContext,
              siblingLeads,
              qaLead: qaLeadContact,
            }
          : {
              productSpec: currentLead.task.productSpec,
              worktreePath: currentLead.workspace.cwd,
              branch: currentLead.workspace.branch,
              qaLead: qaLeadContact,
            },
      );
      mutableRun.mailbox.push(stageMail(currentLead.agentId, messageBody, "slp_define_pipeline"));
    }
    // Preparation owes no tool: slp_define_pipeline is only accepted after every feature branch is merged.
    mutableRun.mailbox.push(stageMail(qaLeadAgentId, qaLeadPreparationBriefing({
      acceptanceCriteria: overallCriteria,
      sharedContext,
      qaWorktreePath: qaWorkspace.cwd,
      qaBranch: qaWorkspace.branch,
      featureLeads: featureLeadRoster,
    }), null));
  });
  return provisionedLeads.length === 1
    ? "Delegated to the Lead in its dedicated worktree, with a QA Lead preparing verification of the merged result. Tell the Supreme Manager in Vietnamese that work has started, then end your turn."
    : `Delegated ${provisionedLeads.length} parallel features to dedicated Leads in isolated worktrees, with a QA Lead preparing verification of the merged result. Tell the Supreme Manager in Vietnamese that work has started, then end your turn.`;
}
