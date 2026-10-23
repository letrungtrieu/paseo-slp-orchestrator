// Safely archives active SLP runs without destroying worktrees and restores archived runs back into execution.
import { existsSync } from "node:fs";
import { ROLE_LABELS } from "../../shared/roles";
import type { Run, RunStatus } from "../../shared/state";
import { configureLocalOnlyPipelineBranch, localBranchExists, runGit } from "../git/git";
import { openSupervisorWorkspace } from "../git/worktree";
import { delegationMessage, reportForSupervisor, supervisorBriefing } from "../prompts/messages";
import { archiveAgentSubtree } from "./agent-hierarchy";
import { reviveMasterLead } from "./agent-revival";
import { archiveAgentLogged, type PipelineContext } from "./context";
import { recoverPipelines } from "./stage-engine";
import { stageMail } from "./stage-mail";
import { ToolError } from "./tool-error";
import { reviveQaLeadForPreparation } from "./qa/qa-lead-provisioning";
import { isQaPhaseActive, qaPipelinesOf, qaVerificationComplete } from "./qa/qa-phase-state";

export interface RestoreRunResult {
  ok: boolean;
  runId: string;
  supervisorAgentId: string;
  supervisorWorkspaceId: string;
  status: RunStatus;
}

function canUseLivePaseoWorkspaces(ctx: PipelineContext): boolean {
  return (
    typeof ctx.holder?.get === "function" &&
    (typeof ctx.holder.isReady !== "function" || ctx.holder.isReady())
  );
}

// Determine which active workflow status an archived run should resume when restored.
export function inferRestoredRunStatus(run: Run): RunStatus {
  const savedActiveStatus =
    run.archivedFromStatus && !["completed", "aborted"].includes(run.archivedFromStatus)
      ? run.archivedFromStatus
      : null;
  if (!run.criteria) {
    return "delegating";
  }
  const existingPipelines = Object.values(run.pipelines);
  if (existingPipelines.length === 0) {
    return "planning";
  }
  if (run.supervisorReport !== null || savedActiveStatus === "awaiting_user") {
    return "awaiting_user";
  }
  if (run.finalReport !== null || savedActiveStatus === "reporting") {
    return "reporting";
  }
  // Right after the QA handover (or a rework) the QA Lead still owes its QA pipeline, which only planning makes it owe.
  const hasActiveQaPipeline = qaPipelinesOf(run).some((pipeline) => !["integrated", "failed"].includes(pipeline.status));
  if (isQaPhaseActive(run) && !hasActiveQaPipeline && !qaVerificationComplete(run)) {
    return "planning";
  }
  return "running";
}

// Ensure a Lead or pipeline git worktree exists on disk and has an active Paseo workspace handle.
export async function ensureRestoredWorktreeWorkspace(
  ctx: PipelineContext,
  runId: string,
  worktreePath: string,
  branchName: string | null,
  fallbackWorkspaceId: string,
): Promise<{ workspaceId: string; cwd: string }> {
  const currentRun = ctx.store.require(runId);
  const hasRealRepositoryCheckout = existsSync(currentRun.repoPath);

  // If Paseo removed the worktree directory when archiving a workspace row, re-attach it from the preserved local branch.
  if (hasRealRepositoryCheckout && worktreePath && !existsSync(worktreePath) && branchName) {
    await runGit(currentRun.repoPath, ["worktree", "prune"]).catch(() => undefined);
    const branchStillExists = await localBranchExists(currentRun.repoPath, branchName);
    if (branchStillExists) {
      await runGit(currentRun.repoPath, ["worktree", "add", worktreePath, branchName]);
    } else {
      await runGit(currentRun.repoPath, [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        currentRun.integrationBranch,
      ]);
    }
    await configureLocalOnlyPipelineBranch(currentRun.repoPath, branchName).catch(() => undefined);
  }

  if (!canUseLivePaseoWorkspaces(ctx) || !worktreePath || !existsSync(worktreePath)) {
    return { workspaceId: fallbackWorkspaceId, cwd: worktreePath };
  }

  const paseo = await ctx.holder.get();
  if (typeof paseo?.workspaces?.open !== "function") {
    return { workspaceId: fallbackWorkspaceId, cwd: worktreePath };
  }

  const reopenedWorkspace = await paseo.workspaces.open(worktreePath);
  await reopenedWorkspace.refresh?.();
  const resolvedWorktreeCwd = reopenedWorkspace.directory ?? worktreePath;

  // Update the persisted workspace map so subsequent stage spawns use the live Paseo workspace id.
  ctx.store.mutate(runId, (mutableRun) => {
    for (const [existingKey, existingWorkspace] of Object.entries(mutableRun.pipelineWorkspaces)) {
      if (
        existingKey !== reopenedWorkspace.id &&
        (existingWorkspace.cwd === resolvedWorktreeCwd ||
          (branchName !== null && existingWorkspace.branch === branchName))
      ) {
        delete mutableRun.pipelineWorkspaces[existingKey];
      }
    }
    if (branchName) {
      mutableRun.pipelineWorkspaces[reopenedWorkspace.id] = {
        workspaceId: reopenedWorkspace.id,
        cwd: resolvedWorktreeCwd,
        branch: branchName,
        owned: true,
      };
    }
  });

  return { workspaceId: reopenedWorkspace.id, cwd: resolvedWorktreeCwd };
}

// Pause and archive an active SLP run while preserving all git worktrees, branches, and pipeline states for later restoration.
export async function archiveRunSafely(ctx: PipelineContext, runId: string): Promise<void> {
  const initialRun = ctx.store.require(runId);
  const archivedTimestamp = new Date().toISOString();

  // Persist the archived state before closing agent sessions so the sweeper and stage creators stop immediately.
  ctx.store.mutate(runId, (mutableRun) => {
    if (!["completed", "aborted"].includes(mutableRun.status)) {
      mutableRun.archivedFromStatus = mutableRun.status;
    }
    mutableRun.archivedAt = archivedTimestamp;
    mutableRun.archiveWarningPending = false;
    mutableRun.status = "aborted";
    mutableRun.mailbox = [];
    for (const mutablePipeline of Object.values(mutableRun.pipelines)) {
      if (["queued", "starting", "running"].includes(mutablePipeline.status)) {
        mutableRun.pipelines[mutablePipeline.id].status = "paused";
        mutableRun.pipelines[mutablePipeline.id].pausedReason ??=
          "Paused and archived by the Supreme Manager; restore in SLP Orchestrator to continue.";
        mutableRun.pipelines[mutablePipeline.id].updatedAt = archivedTimestamp;
      }
    }
    for (const agentRecord of Object.values(mutableRun.agents)) {
      agentRecord.awaitingTool = null;
      agentRecord.awaitingSince = null;
    }
  });

  // Archive all active child sessions and the Supervisor without touching owned git worktrees or local branches.
  await archiveAgentSubtree(ctx, runId, initialRun.supervisorAgentId, { includeRoot: true });
  for (const remainingAgent of Object.values(ctx.store.require(runId).agents)) {
    if (!remainingAgent.archivedAt) {
      await archiveAgentLogged(ctx, runId, null, remainingAgent.agentId);
    }
  }
  ctx.logEvent(runId, {
    taskId: null,
    from: "manager",
    to: "pipeline",
    kind: "run.archived",
    summary: "Run archived with worktrees preserved for later restoration",
    outcome: "info",
  });
}

// Clear the unexpected-archive warning flag when the user chooses to keep the interrupted run in the archive list.
export function dismissArchiveWarning(ctx: PipelineContext, runId: string): void {
  ctx.store.mutate(runId, (mutableRun) => {
    mutableRun.archiveWarningPending = false;
  });
}

// Restore an archived SLP run by re-opening its workspaces, respawning its Supervisor/Leads/Peers, and resuming execution.
export async function restoreRun(ctx: PipelineContext, runId: string): Promise<RestoreRunResult> {
  const initialRun = ctx.store.require(runId);
  if (initialRun.engineVersion !== "dynamic-stages-v1") {
    throw new ToolError("Legacy runs are read-only and cannot be restored.");
  }
  if (initialRun.status === "completed") {
    throw new ToolError("Completed runs have already been merged into the base branch.");
  }

  // Re-open the main repository workspace so the Supervisor session is attached to a live Paseo workspace handle.
  let supervisorWorkspaceId = initialRun.supervisorWorkspaceId;
  // Once delegated, devCwd is the QA worktree, which must never become the Supervisor's checkout.
  let supervisorWorkspaceCwd = initialRun.devWorkspaceId === initialRun.supervisorWorkspaceId
    ? initialRun.devCwd || initialRun.repoPath
    : initialRun.repoPath;
  if (canUseLivePaseoWorkspaces(ctx) && existsSync(initialRun.repoPath)) {
    const paseo = await ctx.holder.get();
    if (typeof paseo?.workspaces?.open === "function") {
      const openedSupervisorWorkspace = await openSupervisorWorkspace(paseo, initialRun.repoPath);
      supervisorWorkspaceId = openedSupervisorWorkspace.workspaceId;
      supervisorWorkspaceCwd = openedSupervisorWorkspace.cwd;
    }
  }

  const liveStatuses = await ctx.gateway.liveStatuses(runId);
  const existingSupervisorRecord = initialRun.agents[initialRun.supervisorAgentId];
  const existingSupervisorLive = liveStatuses.get(initialRun.supervisorAgentId);
  const isSupervisorDead =
    !existingSupervisorRecord ||
    Boolean(existingSupervisorRecord.archivedAt) ||
    Boolean(existingSupervisorLive?.archived);

  let activeSupervisorAgentId = initialRun.supervisorAgentId;
  if (isSupervisorDead) {
    // Spawn a replacement Supervisor in the main workspace when the previous Supervisor was archived via the x button.
    const spawnedSupervisor = await ctx.gateway.createAgent({
      runId,
      role: "supervisor",
      taskId: null,
      provider: initialRun.providers.supervisor,
      thinkingOptionId: initialRun.providers.supervisorThinkingOptionId ?? undefined,
      permissionModeId: initialRun.providers.supervisorPermissionModeId ?? undefined,
      workspaceId: supervisorWorkspaceId,
      title: `[${ROLE_LABELS.supervisor}] [${initialRun.title}]`,
      awaitTool: null,
    });
    activeSupervisorAgentId = spawnedSupervisor.agentId;
    liveStatuses.set(activeSupervisorAgentId, {
      agentId: activeSupervisorAgentId,
      status: "idle",
      pendingPermissions: [],
      archived: false,
    });
  }

  // Re-open or recreate every Lead and pipeline worktree before resuming pipeline execution.
  const currentSnapshot = ctx.store.require(runId);
  for (const pipelineRecord of Object.values(currentSnapshot.pipelines)) {
    if (["integrated", "failed"].includes(pipelineRecord.status)) continue;
    const restoredWorkspace = await ensureRestoredWorktreeWorkspace(
      ctx,
      runId,
      pipelineRecord.worktree,
      pipelineRecord.branch,
      pipelineRecord.workspaceId ?? supervisorWorkspaceId,
    );
    ctx.store.mutate(runId, (mutableRun) => {
      const mutablePipeline = mutableRun.pipelines[pipelineRecord.id];
      if (mutablePipeline) {
        mutablePipeline.workspaceId = restoredWorkspace.workspaceId;
        mutablePipeline.worktree = restoredWorkspace.cwd;
      }
      for (const agentRecord of Object.values(mutableRun.agents)) {
        if (agentRecord.pipelineId === pipelineRecord.id || agentRecord.worktreePath === pipelineRecord.worktree) {
          agentRecord.workspaceId = restoredWorkspace.workspaceId;
          agentRecord.worktreePath = restoredWorkspace.cwd;
        }
      }
    });
  }

  // Also ensure any planning Lead that has not defined a pipeline yet has an open worktree workspace.
  const primaryLeadRecord = currentSnapshot.agents[currentSnapshot.masterLeadAgentId];
  if (primaryLeadRecord?.worktreePath) {
    const matchingWorkspace = Object.values(currentSnapshot.pipelineWorkspaces).find(
      (candidateWorkspace) => candidateWorkspace.cwd === primaryLeadRecord.worktreePath,
    );
    const restoredLeadWorkspace = await ensureRestoredWorktreeWorkspace(
      ctx,
      runId,
      primaryLeadRecord.worktreePath,
      matchingWorkspace?.branch ?? null,
      primaryLeadRecord.workspaceId ?? supervisorWorkspaceId,
    );
    ctx.store.mutate(runId, (mutableRun) => {
      const mutableLead = mutableRun.agents[mutableRun.masterLeadAgentId];
      if (mutableLead) {
        mutableLead.workspaceId = restoredLeadWorkspace.workspaceId;
        mutableLead.worktreePath = restoredLeadWorkspace.cwd;
      }
    });
  }

  // The QA worktree is every feature Lead's merge target, so it must be live before any finalize or QA stage resumes.
  const qaPhaseSnapshot = ctx.store.require(runId);
  if (qaPhaseSnapshot.qaLeadAgentId && qaPhaseSnapshot.devWorkspaceId !== qaPhaseSnapshot.supervisorWorkspaceId) {
    const restoredQaWorkspace = await ensureRestoredWorktreeWorkspace(
      ctx,
      runId,
      qaPhaseSnapshot.devCwd,
      qaPhaseSnapshot.integrationBranch,
      qaPhaseSnapshot.devWorkspaceId,
    );
    ctx.store.mutate(runId, (mutableRun) => {
      mutableRun.devWorkspaceId = restoredQaWorkspace.workspaceId;
      mutableRun.devCwd = restoredQaWorkspace.cwd;
      for (const agentRecord of Object.values(mutableRun.agents)) {
        if (agentRecord.role === "qa_lead") agentRecord.workspaceId = restoredQaWorkspace.workspaceId;
      }
    });
  }

  const restoredRunStatus = inferRestoredRunStatus(ctx.store.require(runId));
  const restoredAt = new Date().toISOString();

  ctx.store.mutate(runId, (mutableRun) => {
    const previousSupervisorId = mutableRun.supervisorAgentId;
    mutableRun.supervisorAgentId = activeSupervisorAgentId;
    mutableRun.supervisorWorkspaceId = supervisorWorkspaceId;
    if (mutableRun.devWorkspaceId === initialRun.supervisorWorkspaceId) {
      mutableRun.devWorkspaceId = supervisorWorkspaceId;
      mutableRun.devCwd = supervisorWorkspaceCwd;
    }
    mutableRun.status = restoredRunStatus;
    mutableRun.archivedAt = null;
    mutableRun.archivedFromStatus = null;
    mutableRun.archiveWarningPending = false;

    // Re-parent direct Lead children to the active Supervisor so future hierarchy operations stay connected.
    for (const agentRecord of Object.values(mutableRun.agents)) {
      if (
        agentRecord.agentId !== activeSupervisorAgentId &&
        (agentRecord.parentAgentId === previousSupervisorId ||
          (agentRecord.role === "master_lead" && !agentRecord.parentAgentId))
      ) {
        agentRecord.parentAgentId = activeSupervisorAgentId;
      }
    }

    // Reopen paused pipelines that were interrupted by archival so recoverPipelines can respawn their stage cohorts.
    for (const mutablePipeline of Object.values(mutableRun.pipelines)) {
      if (mutablePipeline.status === "paused" && !mutablePipeline.gate) {
        mutablePipeline.status = "starting";
        mutablePipeline.pausedReason = null;
        mutablePipeline.updatedAt = restoredAt;
        const activeStage = mutablePipeline.stages[mutablePipeline.currentStageIndex];
        if (activeStage && activeStage.status !== "completed") {
          activeStage.status = "starting";
        }
      }
    }

    if (restoredRunStatus === "reporting" && mutableRun.finalReport) {
      mutableRun.mailbox.push(
        stageMail(
          activeSupervisorAgentId,
          reportForSupervisor(mutableRun.finalReport, mutableRun.baseBranch, mutableRun.integrationBranch),
          "slp_present_to_manager",
        ),
      );
    }
  });

  if (restoredRunStatus === "delegating") {
    if (isSupervisorDead) {
      await ctx.gateway.prompt(activeSupervisorAgentId, supervisorBriefing());
    }
  } else if (restoredRunStatus === "planning") {
    await reviveMasterLead(ctx, runId, "SLP run restored during planning", liveStatuses);
    // Also revive any parallel sibling Leads that were delegated features alongside the primary Lead.
    const postPrimaryRun = ctx.store.require(runId);
    const archivedSiblingLeads = Object.values(postPrimaryRun.agents).filter(
      (agentRecord) =>
        agentRecord.role === "master_lead" &&
        agentRecord.agentId !== postPrimaryRun.masterLeadAgentId &&
        Boolean(agentRecord.archivedAt) &&
        Boolean(agentRecord.featureName) &&
        !Object.values(postPrimaryRun.pipelines).some((pipeline) => pipeline.leadAgentId === agentRecord.agentId),
    );
    for (const archivedSiblingLead of archivedSiblingLeads) {
      const siblingWorkspace = archivedSiblingLead.worktreePath
        ? await ensureRestoredWorktreeWorkspace(
            ctx,
            runId,
            archivedSiblingLead.worktreePath,
            Object.values(postPrimaryRun.pipelineWorkspaces).find(
              (candidate) => candidate.cwd === archivedSiblingLead.worktreePath,
            )?.branch ?? null,
            archivedSiblingLead.workspaceId ?? supervisorWorkspaceId,
          )
        : { workspaceId: archivedSiblingLead.workspaceId ?? supervisorWorkspaceId, cwd: postPrimaryRun.devCwd };
      const replacementSiblingLead = await ctx.gateway.createAgent({
        runId,
        role: "master_lead",
        taskId: null,
        provider: postPrimaryRun.providers.lead,
        thinkingOptionId: postPrimaryRun.providers.leadThinkingOptionId ?? undefined,
        permissionModeId: postPrimaryRun.providers.leadPermissionModeId ?? undefined,
        parentAgentId: activeSupervisorAgentId,
        workspaceId: siblingWorkspace.workspaceId,
        peerWorktreePath: siblingWorkspace.cwd,
        title: `[${ROLE_LABELS.master_lead}] [${archivedSiblingLead.featureName}]`,
        awaitTool: null,
      });
      liveStatuses.set(replacementSiblingLead.agentId, {
        agentId: replacementSiblingLead.agentId,
        status: "idle",
        pendingPermissions: [],
        archived: false,
      });
      ctx.store.mutate(runId, (mutableRun) => {
        const replacementRecord = mutableRun.agents[replacementSiblingLead.agentId];
        if (replacementRecord) {
          replacementRecord.workspaceId = siblingWorkspace.workspaceId;
          replacementRecord.worktreePath = siblingWorkspace.cwd;
          replacementRecord.featureName = archivedSiblingLead.featureName;
          replacementRecord.featureCriteria = archivedSiblingLead.featureCriteria;
          replacementRecord.featureSpec = archivedSiblingLead.featureSpec;
        }
        const matchedBranch =
          Object.values(mutableRun.pipelineWorkspaces).find((candidate) => candidate.cwd === siblingWorkspace.cwd)
            ?.branch ?? mutableRun.integrationBranch;
        mutableRun.mailbox.push(
          stageMail(
            replacementSiblingLead.agentId,
            `${delegationMessage(mutableRun.criteria ?? "", {
              featureName: archivedSiblingLead.featureName ?? undefined,
              featureCriteria: archivedSiblingLead.featureCriteria ?? undefined,
              productSpec: archivedSiblingLead.featureSpec ?? undefined,
              worktreePath: siblingWorkspace.cwd,
              branch: matchedBranch,
            })}\nYour Lead session was restored in SLP Orchestrator. Call slp_define_pipeline now.`,
            "slp_define_pipeline",
          ),
        );
      });
    }
  } else if (restoredRunStatus === "running") {
    await reviveMasterLead(ctx, runId, "SLP run restored by the Supreme Manager", liveStatuses);
    await recoverPipelines(ctx, runId);
  }
  // A QA Lead archived while features were still being built is not the accountable Lead, so reviveMasterLead skips it.
  await reviveQaLeadForPreparation(ctx, runId, liveStatuses);

  // Inform a newly spawned Supervisor that the interrupted SLP run has been restored and is continuing.
  if (isSupervisorDead && ["planning", "running", "awaiting_user"].includes(restoredRunStatus)) {
    ctx.store.mutate(runId, (mutableRun) => {
      mutableRun.mailbox.push(
        stageMail(
          activeSupervisorAgentId,
          `[SLP Orchestrator] Tiến trình SLP '${mutableRun.title}' đã được khôi phục (Restore) về trạng thái '${restoredRunStatus}'. Các Lead/Peer và worktree vẫn được giữ nguyên. Dùng slp_get_run hoặc slp_list_pipelines nếu cần kiểm tra tiến độ.`,
          null,
        ),
      );
    });
  }

  await ctx.mailbox.flush(runId, await ctx.gateway.liveStatuses(runId));

  ctx.logEvent(runId, {
    taskId: null,
    from: "manager",
    to: activeSupervisorAgentId,
    kind: "run.restored",
    summary: `Restored SLP run '${initialRun.title}' to status '${restoredRunStatus}'`,
    outcome: "delivered",
  });

  return {
    ok: true,
    runId,
    supervisorAgentId: activeSupervisorAgentId,
    supervisorWorkspaceId,
    status: restoredRunStatus,
  };
}
