// Delegation-time setup of the QA phase: one QA worktree that becomes the run's integration branch, and the
// QA Lead that lives in it. Feature Leads are provisioned afterwards so their branches fork from the QA branch.
import { ROLE_LABELS } from "../../../shared/roles";
import { runOrchestration } from "../../../shared/orchestration";
import type { PipelineWorkspace } from "../../../shared/state";
import type { SiblingLeadSummary } from "../../prompts/messages";
import { qaLeadPreparationBriefing } from "../../prompts/qa-messages";
import type { AgentLiveStatus } from "../../runtime/agent-gateway";
import type { PipelineContext } from "../context";
import { createPipelineWorktree } from "../pipeline-workspaces";
import { stageMail } from "../stage-mail";
import { ToolError } from "../tool-error";
import { isQaPhaseActive, runHasQaLead } from "./qa-phase-state";

export interface QaWorkspace {
  workspaceId: string;
  cwd: string;
  branch: string;
}

export async function provisionQaWorkspace(ctx: PipelineContext, runId: string): Promise<QaWorkspace> {
  // A follow-up delegation after a completed cycle must branch from the updated base, not the retired QA branch.
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.integrationBranch = mutableRun.baseBranch;
    mutableRun.devCwd = mutableRun.repoPath;
    mutableRun.devWorkspaceId = mutableRun.supervisorWorkspaceId;
    mutableRun.qaLeadAgentId = "";
  });
  const runBeforeCreation = ctx.store.require(runId);
  // When worktree spawning is disabled, QA runs directly on baseBranch inside the main repository checkout.
  if (!runOrchestration(runBeforeCreation).spawnWorktrees) {
    return {
      workspaceId: runBeforeCreation.supervisorWorkspaceId,
      cwd: runBeforeCreation.repoPath,
      branch: runBeforeCreation.baseBranch,
    };
  }
  // Each delegation cycle gets its own branch name because the previous cycle's QA branch may still be deleting.
  const qaCycleNumber = Object.values(runBeforeCreation.agents).filter((agentRecord) => agentRecord.role === "qa_lead").length + 1;
  const createdWorkspace = JSON.parse(
    await createPipelineWorktree(ctx, runId, `qa-cycle-${qaCycleNumber}`, { allowDuringDelegation: true }),
  ) as PipelineWorkspace;
  ctx.store.mutate(runId, (mutableRun) => {
    // The QA checkout is tracked as the dev workspace, not a pipeline workspace, so per-pipeline cleanup never retires it.
    delete mutableRun.pipelineWorkspaces[createdWorkspace.workspaceId];
    mutableRun.integrationBranch = createdWorkspace.branch;
    mutableRun.devCwd = createdWorkspace.cwd;
    mutableRun.devWorkspaceId = createdWorkspace.workspaceId;
  });
  return { workspaceId: createdWorkspace.workspaceId, cwd: createdWorkspace.cwd, branch: createdWorkspace.branch };
}

export async function spawnQaLead(ctx: PipelineContext, runId: string, qaWorkspace: QaWorkspace): Promise<string> {
  const run = ctx.store.require(runId);
  // The QA Lead shares the Lead provider so the peers it forks can resume its session in the same QA worktree.
  const qaLead = await ctx.gateway.createAgent({
    runId,
    role: "qa_lead",
    taskId: null,
    provider: run.providers.lead,
    thinkingOptionId: run.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: run.providers.leadPermissionModeId ?? undefined,
    parentAgentId: run.supervisorAgentId || undefined,
    workspaceId: qaWorkspace.workspaceId,
    peerWorktreePath: qaWorkspace.cwd,
    title: `[${ROLE_LABELS.qa_lead}] [${run.title}]`,
    awaitTool: null,
  });
  if (ctx.store.require(runId).status === "aborted") {
    await ctx.gateway.archive(qaLead.agentId).catch(() => undefined);
    throw new ToolError("This run has finished.");
  }
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.qaLeadAgentId = qaLead.agentId;
    const qaLeadRecord = mutableRun.agents[qaLead.agentId];
    if (qaLeadRecord) {
      qaLeadRecord.workspaceId = qaWorkspace.workspaceId;
      qaLeadRecord.worktreePath = qaWorkspace.cwd;
      // Roster reads (slp_get_run) list Leads by feature name, so the QA Lead gets a recognisable one.
      qaLeadRecord.featureName = "qa";
    }
  });
  return qaLead.agentId;
}

// Restore only covers the preparation phase: once the QA Lead is accountable, reviveMasterLead already replaces it.
export async function reviveQaLeadForPreparation(
  ctx: PipelineContext,
  runId: string,
  liveStatuses: Map<string, AgentLiveStatus>,
): Promise<void> {
  const run = ctx.store.require(runId);
  if (!runHasQaLead(run) || isQaPhaseActive(run) || !["planning", "running"].includes(run.status)) return;
  const qaLeadRecord = run.agents[run.qaLeadAgentId];
  // Paseo's sidebar archive may not have reached SQLite yet, so the live directory counts as proof of death too.
  const isQaLeadDead = !qaLeadRecord || Boolean(qaLeadRecord.archivedAt) || Boolean(liveStatuses.get(run.qaLeadAgentId)?.archived);
  if (!isQaLeadDead) return;
  const replacementQaLeadId = await spawnQaLead(ctx, runId, {
    workspaceId: run.devWorkspaceId,
    cwd: run.devCwd,
    branch: run.integrationBranch,
  });
  // Registering it as idle lets the restore's own mailbox flush deliver the briefing immediately.
  liveStatuses.set(replacementQaLeadId, { agentId: replacementQaLeadId, status: "idle", pendingPermissions: [], archived: false });
  ctx.store.mutate(runId, (mutableRun) => {
    // The roster is rebuilt from live feature Leads because the original briefing died with the old session.
    const featureLeads: SiblingLeadSummary[] = Object.values(mutableRun.agents)
      .filter((agentRecord) => agentRecord.role === "master_lead" && !agentRecord.archivedAt && agentRecord.featureName)
      .map((agentRecord) => ({
        agentId: agentRecord.agentId,
        featureName: agentRecord.featureName ?? "feature",
        worktreePath: agentRecord.worktreePath,
        branch: Object.values(mutableRun.pipelineWorkspaces).find((workspace) => workspace.cwd === agentRecord.worktreePath)?.branch ?? null,
        acceptanceCriteria: agentRecord.featureCriteria ?? mutableRun.criteria ?? "",
        productSpec: agentRecord.featureSpec,
      }));
    mutableRun.mailbox.push(stageMail(replacementQaLeadId, qaLeadPreparationBriefing({
      acceptanceCriteria: mutableRun.criteria ?? "",
      qaWorktreePath: mutableRun.devCwd,
      qaBranch: mutableRun.integrationBranch,
      featureLeads,
    }), null));
  });
}
