// Recursive parent-child agent hierarchy traversal and bottom-up cascade archival across Paseo worktrees.
import type { AgentRecord, Run } from "../../shared/state";
import { isPipelineLeadRole } from "../../shared/roles";
import { deleteRunLocalPipelineBranches, removeWorktreeAndDeleteBranch } from "../git/git";
import { archiveAgentLogged, type PipelineContext } from "./context";

// Prevent overlapping agent.archived events and sweeper ticks from running duplicate cascade archives for the same subtree.
const archivingSubtreeKeys = new Set<string>();

// Role depth ensures leaf peers close before Leads and Leads close before Supervisor.
const ROLE_ARCHIVE_PRIORITY: Readonly<Record<string, number>> = {
  peer: 0,
  master_lead: 1,
  qa_lead: 1,
  supervisor: 2,
};

function hasMasterLeadRecord(run: Run): boolean {
  return Object.values(run.agents).some((agentRecord) => isPipelineLeadRole(agentRecord.role));
}

function hasStageLeadRecord(run: Run, peerRecord: AgentRecord): boolean {
  const peerPipelineId = peerRecord.pipelineId;
  if (!peerPipelineId || !peerRecord.stageId) return false;
  // A stage peer is only considered orphaned when no Lead record exists for its pipeline or stage.
  return Object.values(run.agents).some(
    (candidateRecord) =>
      isPipelineLeadRole(candidateRecord.role)
      && candidateRecord.pipelineId === peerPipelineId
      && (candidateRecord.stageId === peerRecord.stageId || run.pipelines[peerPipelineId]?.leadAgentId === candidateRecord.agentId),
  );
}

// Resolve direct children of a parent agent using both explicit parentAgentId links and structural role/stage ownership.
export function directChildAgentsOf(run: Run, parentAgentId: string): AgentRecord[] {
  const parentRecord = run.agents[parentAgentId];
  const isSupervisorParent = parentRecord?.role === "supervisor" || run.supervisorAgentId === parentAgentId;
  const isMasterLeadParent = isPipelineLeadRole(parentRecord?.role) || run.masterLeadAgentId === parentAgentId;
  const directChildren: AgentRecord[] = [];
  const seenChildIds = new Set<string>();

  const registerChild = (candidateRecord: AgentRecord): void => {
    if (candidateRecord.agentId === parentAgentId || seenChildIds.has(candidateRecord.agentId)) return;
    seenChildIds.add(candidateRecord.agentId);
    directChildren.push(candidateRecord);
  };

  for (const candidateRecord of Object.values(run.agents)) {
    if (candidateRecord.agentId === parentAgentId) continue;
    // Explicit parent links take precedence whenever persisted at creation or updated during revival.
    if (candidateRecord.parentAgentId === parentAgentId) {
      registerChild(candidateRecord);
      continue;
    }
    if (isSupervisorParent) {
      // Lead sessions belong directly under the Supervisor even in older snapshots without parentAgentId.
      if (
        isPipelineLeadRole(candidateRecord.role)
        && (!candidateRecord.parentAgentId || !run.agents[candidateRecord.parentAgentId])
      ) {
        registerChild(candidateRecord);
        continue;
      }
      if (candidateRecord.role === "peer" && !hasMasterLeadRecord(run) && !hasStageLeadRecord(run, candidateRecord)) {
        registerChild(candidateRecord);
      }
      continue;
    }
    if (isMasterLeadParent) {
      if (
        candidateRecord.role === "peer"
        && (!candidateRecord.parentAgentId || !run.agents[candidateRecord.parentAgentId])
      ) {
        if (
          parentRecord?.pipelineId &&
          candidateRecord.pipelineId === parentRecord.pipelineId
        ) {
          registerChild(candidateRecord);
          continue;
        }
        if (run.masterLeadAgentId === parentAgentId && !hasStageLeadRecord(run, candidateRecord)) {
          registerChild(candidateRecord);
        }
      }
    }
  }
  return directChildren;
}

// Recursively traverse the child subtree of rootAgentId and return unarchived descendants in bottom-up order.
export function collectDescendantAgentIds(run: Run, rootAgentId: string): string[] {
  const visitedAgentIds = new Set<string>([rootAgentId]);
  const discoveredDescendants: Array<{ agentRecord: AgentRecord; treeDepth: number }> = [];

  function visitSubtreeRecursively(currentParentId: string, currentDepth: number): void {
    for (const childRecord of directChildAgentsOf(run, currentParentId)) {
      if (visitedAgentIds.has(childRecord.agentId)) continue;
      visitedAgentIds.add(childRecord.agentId);
      // Recurse through already-archived intermediate leads so unarchived grandchild peers are still collected.
      visitSubtreeRecursively(childRecord.agentId, currentDepth + 1);
      if (!childRecord.archivedAt) {
        discoveredDescendants.push({ agentRecord: childRecord, treeDepth: currentDepth });
      }
    }
  }

  visitSubtreeRecursively(rootAgentId, 1);
  // Sort deepest leaves and lower-level roles first so child peers always archive before their parent leads.
  return discoveredDescendants
    .sort((leftEntry, rightEntry) => {
      const leftRolePriority = ROLE_ARCHIVE_PRIORITY[leftEntry.agentRecord.role] ?? 3;
      const rightRolePriority = ROLE_ARCHIVE_PRIORITY[rightEntry.agentRecord.role] ?? 3;
      if (leftRolePriority !== rightRolePriority) return leftRolePriority - rightRolePriority;
      return rightEntry.treeDepth - leftEntry.treeDepth;
    })
    .map((descendantEntry) => descendantEntry.agentRecord.agentId);
}

// Immediately archive an integrated pipeline's owned Paseo workspace, remove its git worktree, and delete its local pipeline branch.
export async function retireIntegratedPipelineWorkspace(
  ctx: PipelineContext,
  runId: string,
  pipelineId: string,
  willAllPipelinesBeIntegrated: boolean,
): Promise<void> {
  const currentRun = ctx.store.require(runId);
  const integratedPipeline = currentRun.pipelines[pipelineId];
  if (!integratedPipeline) return;
  const runBranchPrefix = `slp/${runId.slice(0, 8)}/`;
  const matchingWorkspaceRecord = (integratedPipeline.workspaceId
    ? currentRun.pipelineWorkspaces[integratedPipeline.workspaceId]
    : undefined)
    ?? Object.values(currentRun.pipelineWorkspaces).find(
      (candidateWorkspace) =>
        candidateWorkspace.cwd === integratedPipeline.worktree
        || (integratedPipeline.branch !== null && candidateWorkspace.branch === integratedPipeline.branch),
    );
  const isOwnedPipelineCheckout = Boolean(
    matchingWorkspaceRecord?.owned
    || integratedPipeline.branch?.startsWith(runBranchPrefix),
  );
  if (!isOwnedPipelineCheckout) return;

  const targetWorkspaceId = matchingWorkspaceRecord?.workspaceId ?? integratedPipeline.workspaceId;
  // Keep the Paseo workspace open while an unarchived Lead still runs inside this checkout so archiving the workspace
  // does not cascade-archive the Lead mid-turn before it calls slp_report; archiveOwnedWorkspaces retires it at run end.
  const hasActiveLeadInWorkspace = Object.values(currentRun.agents).some(
    (agentRecord) =>
      isPipelineLeadRole(agentRecord.role) &&
      !agentRecord.archivedAt &&
      ((targetWorkspaceId !== null && agentRecord.workspaceId === targetWorkspaceId) ||
        agentRecord.worktreePath === integratedPipeline.worktree),
  );
  const canUsePaseoSdk = typeof ctx.holder?.get === "function"
    && (typeof ctx.holder.isReady !== "function" || ctx.holder.isReady());
  if (
    !hasActiveLeadInWorkspace
    && canUsePaseoSdk
    && targetWorkspaceId
    && targetWorkspaceId !== currentRun.supervisorWorkspaceId
    && targetWorkspaceId !== currentRun.devWorkspaceId
  ) {
    const paseo = await ctx.holder.get();
    await paseo.workspaces.archive(targetWorkspaceId).catch(() => undefined);
  }
  // Detach HEAD when the Lead stays alive in this directory, or remove the worktree registration before deleting the local branch.
  await removeWorktreeAndDeleteBranch(currentRun.repoPath, {
    worktreePath: integratedPipeline.worktree,
    branchName: integratedPipeline.branch,
    protectedWorktrees: [currentRun.repoPath, currentRun.devCwd],
    protectedBranches: [currentRun.baseBranch, currentRun.integrationBranch],
    keepWorktreeDirectory: hasActiveLeadInWorkspace,
  });
  if (!hasActiveLeadInWorkspace && targetWorkspaceId && ctx.store.find(runId)) {
    try {
      ctx.store.mutate(runId, (mutableRun) => {
        delete mutableRun.pipelineWorkspaces[targetWorkspaceId];
      });
    } catch {
      // Ignore mutations that arrive after the SQLite store is closed during plugin or test teardown.
    }
  }
  if (willAllPipelinesBeIntegrated) {
    // Once all pipelines are integrated, retire any unused owned pipeline worktrees and sweep remaining slp/<runId8>/* local branches.
    const latestRun = ctx.store.find(runId);
    const activePipelines = latestRun
      ? Object.values(latestRun.pipelines).filter(
          (candidatePipeline) => candidatePipeline.id !== pipelineId && !["integrated", "failed"].includes(candidatePipeline.status),
        )
      : [];
    const activePipelineBranches = activePipelines
      .map((candidatePipeline) => candidatePipeline.branch)
      .filter((branchName): branchName is string => Boolean(branchName));
    const activePipelineWorktrees = new Set(activePipelines.map((candidatePipeline) => candidatePipeline.worktree));
    const activeLeadWorkspaceIds = new Set(
      latestRun
        ? Object.values(latestRun.agents)
            .filter((agentRecord) => isPipelineLeadRole(agentRecord.role) && !agentRecord.archivedAt && agentRecord.workspaceId)
            .map((agentRecord) => agentRecord.workspaceId as string)
        : [],
    );
    const activeLeadWorktrees = new Set(
      latestRun
        ? Object.values(latestRun.agents)
            .filter((agentRecord) => isPipelineLeadRole(agentRecord.role) && !agentRecord.archivedAt && agentRecord.worktreePath)
            .map((agentRecord) => agentRecord.worktreePath as string)
        : [],
    );
    const unusedOwnedWorkspaces = latestRun
      ? Object.values(latestRun.pipelineWorkspaces).filter(
          (candidateWorkspace) =>
            candidateWorkspace.owned &&
            !activePipelineWorktrees.has(candidateWorkspace.cwd) &&
            !activePipelineBranches.includes(candidateWorkspace.branch) &&
            !activeLeadWorkspaceIds.has(candidateWorkspace.workspaceId) &&
            !activeLeadWorktrees.has(candidateWorkspace.cwd),
        )
      : [];
    for (const unusedWorkspace of unusedOwnedWorkspaces) {
      if (
        canUsePaseoSdk &&
        unusedWorkspace.workspaceId !== currentRun.supervisorWorkspaceId &&
        unusedWorkspace.workspaceId !== currentRun.devWorkspaceId
      ) {
        const paseo = await ctx.holder.get();
        await paseo.workspaces.archive(unusedWorkspace.workspaceId).catch(() => undefined);
      }
      await removeWorktreeAndDeleteBranch(currentRun.repoPath, {
        worktreePath: unusedWorkspace.cwd,
        branchName: unusedWorkspace.branch,
        protectedWorktrees: [currentRun.repoPath, currentRun.devCwd],
        protectedBranches: [currentRun.baseBranch, currentRun.integrationBranch, ...activePipelineBranches],
      });
    }
    if (unusedOwnedWorkspaces.length > 0 && ctx.store.find(runId)) {
      try {
        ctx.store.mutate(runId, (mutableRun) => {
          for (const unusedWorkspace of unusedOwnedWorkspaces) {
            delete mutableRun.pipelineWorkspaces[unusedWorkspace.workspaceId];
          }
        });
      } catch {
        // Ignore mutations that arrive after the SQLite store is closed during plugin or test teardown.
      }
    }
    await deleteRunLocalPipelineBranches(currentRun.repoPath, runId, {
      preservedBranches: [currentRun.baseBranch, currentRun.integrationBranch, ...activePipelineBranches],
    });
  }
}

export async function archiveOwnedWorkspaces(ctx: PipelineContext, run: Run): Promise<void> {
  const ownedWorkspaceIds = new Set<string>();
  const ownedWorktreeCheckouts: Array<{ worktreePath: string; branchName: string | null }> = [];
  const runBranchPrefix = `slp/${run.id.slice(0, 8)}/`;
  // Never archive the user's primary repository workspace when Master Lead and Supervisor share the same workspace.
  if (run.devWorkspaceId && run.devWorkspaceId !== run.supervisorWorkspaceId) {
    ownedWorkspaceIds.add(run.devWorkspaceId);
    ownedWorktreeCheckouts.push({ worktreePath: run.devCwd, branchName: run.integrationBranch });
  }
  for (const pipelineWorkspace of Object.values(run.pipelineWorkspaces)) {
    if (pipelineWorkspace.owned) {
      ownedWorkspaceIds.add(pipelineWorkspace.workspaceId);
      ownedWorktreeCheckouts.push({ worktreePath: pipelineWorkspace.cwd, branchName: pipelineWorkspace.branch });
    }
  }
  for (const pipelineRecord of Object.values(run.pipelines)) {
    if (pipelineRecord.branch?.startsWith(runBranchPrefix)) {
      ownedWorktreeCheckouts.push({ worktreePath: pipelineRecord.worktree, branchName: pipelineRecord.branch });
    }
  }
  // Unit fixtures that stub only the gateway and have no owned checkouts do not initialize a live Paseo SDK handle or git repo.
  const canUsePaseoSdk = typeof ctx.holder?.get === "function"
    && (typeof ctx.holder.isReady !== "function" || ctx.holder.isReady());
  if (!canUsePaseoSdk && ownedWorktreeCheckouts.length === 0) {
    return;
  }
  if (canUsePaseoSdk) {
    const paseo = await ctx.holder.get();
    for (const workspaceId of ownedWorkspaceIds) {
      // Workspace cleanup is best effort because a user can close an external Paseo workspace first.
      await paseo.workspaces.archive(workspaceId).catch(() => undefined);
    }
  }
  // Paseo's workspace archive removes the worktree directory but leaves local branches in refs/heads/; delete both here.
  for (const ownedCheckout of ownedWorktreeCheckouts) {
    await removeWorktreeAndDeleteBranch(run.repoPath, {
      worktreePath: ownedCheckout.worktreePath,
      branchName: ownedCheckout.branchName,
      protectedWorktrees: [run.repoPath],
      protectedBranches: [run.baseBranch],
    });
  }
  await deleteRunLocalPipelineBranches(run.repoPath, run.id, {
    preservedBranches: [run.baseBranch],
  });
  // Remove retired pipeline workspaces from the persisted map so follow-up pipelines never reuse an archived handle.
  if (ownedWorkspaceIds.size > 0 && ctx.store.find(run.id)) {
    try {
      ctx.store.mutate(run.id, (mutableRun) => {
        for (const archivedWorkspaceId of ownedWorkspaceIds) {
          delete mutableRun.pipelineWorkspaces[archivedWorkspaceId];
        }
      });
    } catch {
      // Ignore mutations that arrive after the SQLite store is closed during plugin or test teardown.
    }
  }
}

// Archive all unarchived descendants of rootAgentId in bottom-up order, including late in-flight creations.
export async function archiveAgentSubtree(
  ctx: PipelineContext,
  runId: string,
  rootAgentId: string,
  options?: { includeRoot?: boolean },
): Promise<string[]> {
  const archivedSubtreeIds: string[] = [];
  const initialDescendantIds = collectDescendantAgentIds(ctx.store.require(runId), rootAgentId);
  for (const descendantAgentId of initialDescendantIds) {
    await archiveAgentLogged(ctx, runId, null, descendantAgentId);
    archivedSubtreeIds.push(descendantAgentId);
  }
  // Catch any stage child whose in-flight SDK creation finished while earlier descendants were being archived.
  for (const lateDescendantAgentId of collectDescendantAgentIds(ctx.store.require(runId), rootAgentId)) {
    await archiveAgentLogged(ctx, runId, null, lateDescendantAgentId);
    archivedSubtreeIds.push(lateDescendantAgentId);
  }
  if (options?.includeRoot) {
    const rootRecord = ctx.store.require(runId).agents[rootAgentId];
    if (rootRecord && !rootRecord.archivedAt) {
      await archiveAgentLogged(ctx, runId, null, rootAgentId);
      archivedSubtreeIds.push(rootAgentId);
    }
  }
  return archivedSubtreeIds;
}

// Recursively cascade an agent archive event to all of its child and grandchild sessions.
export async function handleAgentArchived(
  ctx: PipelineContext,
  runId: string,
  archivedAgentId: string,
  archivedAt?: string,
): Promise<void> {
  const initialRun = ctx.store.require(runId);
  const targetRecord = initialRun.agents[archivedAgentId];
  const isSupervisorTarget = targetRecord?.role === "supervisor" || initialRun.supervisorAgentId === archivedAgentId;
  const lockKey = isSupervisorTarget ? `${runId}:supervisor` : `${runId}:${archivedAgentId}`;
  if (archivingSubtreeKeys.has(lockKey)) return;
  archivingSubtreeKeys.add(lockKey);

  try {
    const effectiveArchivedAt = archivedAt ?? new Date().toISOString();
    const descendantAgentIds = collectDescendantAgentIds(initialRun, archivedAgentId);

    if (isSupervisorTarget) {
      const wasActiveRun = !["completed", "aborted"].includes(initialRun.status);
      // Persist the archived/aborted status before awaiting SDK archive calls so in-flight creations and sweeper ticks stop immediately.
      ctx.store.mutate(runId, (mutableRun) => {
        const supervisorRecord = mutableRun.agents[archivedAgentId] ?? mutableRun.agents[mutableRun.supervisorAgentId];
        if (supervisorRecord) {
          supervisorRecord.archivedAt ??= effectiveArchivedAt;
        }
        if (!["completed", "aborted"].includes(mutableRun.status)) {
          // Record the active phase before archiving so SLP Orchestrator can restore the run and alert the user.
          mutableRun.archivedFromStatus = mutableRun.status;
          mutableRun.archivedAt = effectiveArchivedAt;
          mutableRun.archiveWarningPending = true;
          mutableRun.status = "aborted";
        } else if (mutableRun.status === "aborted") {
          mutableRun.archivedAt ??= effectiveArchivedAt;
        }
        for (const mutablePipeline of Object.values(mutableRun.pipelines)) {
          if (["queued", "starting", "running"].includes(mutablePipeline.status)) {
            // Pause active pipelines without deleting their worktrees so restoration can resume the current stage.
            mutablePipeline.status = "paused";
            mutablePipeline.pausedReason ??= "SLP run was archived; restore the run in SLP Orchestrator to continue.";
            mutablePipeline.updatedAt = effectiveArchivedAt;
          }
        }
        mutableRun.gate = null;
        mutableRun.mailbox = [];
        for (const agentRecord of Object.values(mutableRun.agents)) {
          agentRecord.awaitingTool = null;
          agentRecord.awaitingSince = null;
          agentRecord.waitingForAgentId = null;
          agentRecord.deferredTool = null;
        }
      });
      // Archive child Leads and Peers so background sessions stop, but keep git worktrees and branches intact for restoration.
      const archivedDescendants = await archiveAgentSubtree(ctx, runId, archivedAgentId);
      if (wasActiveRun || archivedDescendants.length > 0) {
        ctx.logEvent(runId, {
          taskId: null,
          from: archivedAgentId || "supervisor",
          to: "pipeline",
          kind: "supervisor.archived",
          summary: `Supervisor archived; archived ${archivedDescendants.length} dependent lead/peer agent(s) and preserved worktrees for restore`,
          outcome: "info",
        });
      }
      return;
    }

    if (!targetRecord) return;
    const affectedAgentIds = new Set<string>([archivedAgentId, ...descendantAgentIds]);
    // Clear obligations and pause active pipelines owned by the archived Lead before awaiting child SDK archive calls.
    ctx.store.mutate(runId, (mutableRun) => {
      const mutableTarget = mutableRun.agents[archivedAgentId];
      if (mutableTarget) {
        mutableTarget.archivedAt ??= effectiveArchivedAt;
      }
      for (const agentRecord of Object.values(mutableRun.agents)) {
        if (affectedAgentIds.has(agentRecord.agentId)) {
          agentRecord.awaitingTool = null;
          agentRecord.awaitingSince = null;
          agentRecord.waitingForAgentId = null;
          agentRecord.deferredTool = null;
        } else if (agentRecord.waitingForAgentId && affectedAgentIds.has(agentRecord.waitingForAgentId)) {
          agentRecord.waitingForAgentId = null;
          agentRecord.deferredTool = null;
        }
      }
      mutableRun.mailbox = mutableRun.mailbox.filter(
        (queuedMessage) => !affectedAgentIds.has(queuedMessage.toAgentId),
      );
      if (isPipelineLeadRole(targetRecord.role)) {
        // Pause pipelines owned by the archived Lead or any child Lead in its archived subtree while leaving sibling Leads' pipelines running.
        const isPrimaryLead = archivedAgentId === mutableRun.masterLeadAgentId;
        for (const mutablePipeline of Object.values(mutableRun.pipelines)) {
          const ownsThisPipeline =
            mutablePipeline.id === targetRecord.pipelineId ||
            Boolean(mutablePipeline.leadAgentId && affectedAgentIds.has(mutablePipeline.leadAgentId)) ||
            (!mutablePipeline.leadAgentId && isPrimaryLead);
          if (ownsThisPipeline && ["queued", "starting", "running"].includes(mutablePipeline.status)) {
            mutablePipeline.status = "paused";
            mutablePipeline.pausedReason ??= `Lead (${archivedAgentId}) was archived; dependent peers were archived.`;
            mutablePipeline.updatedAt = effectiveArchivedAt;
          }
        }
        // An archived QA Lead is revived by recoverMasterLead; promoting a feature Lead would hand QA to the wrong role.
        if (isPrimaryLead && targetRecord.role === "master_lead") {
          // Promote an unarchived sibling Lead outside the archived subtree when parallel pipelines remain active.
          const survivingSiblingLead = Object.values(mutableRun.agents).find(
            (candidateRecord) =>
              candidateRecord.role === "master_lead" &&
              !affectedAgentIds.has(candidateRecord.agentId) &&
              !candidateRecord.archivedAt,
          );
          if (survivingSiblingLead) {
            mutableRun.masterLeadAgentId = survivingSiblingLead.agentId;
          }
        }
      }
    });

    const archivedDescendants = await archiveAgentSubtree(ctx, runId, archivedAgentId);
    if (isPipelineLeadRole(targetRecord.role)) {
      ctx.logEvent(runId, {
        taskId: null,
        from: archivedAgentId,
        to: "pipeline",
        kind: `${targetRecord.role}.archived`,
        summary: `${targetRecord.role} archived; recursively archived ${archivedDescendants.length} child agent(s)`,
        outcome: "info",
      });
    }
  } finally {
    archivingSubtreeKeys.delete(lockKey);
  }
}

export async function handleSupervisorArchived(
  ctx: PipelineContext,
  runId: string,
  archivedAt?: string,
): Promise<void> {
  const currentRun = ctx.store.require(runId);
  await handleAgentArchived(ctx, runId, currentRun.supervisorAgentId, archivedAt);
}
