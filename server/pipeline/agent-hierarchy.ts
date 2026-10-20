// Recursive parent-child agent hierarchy traversal and bottom-up cascade archival across Paseo worktrees.
import type { AgentRecord, Run } from "../../shared/state";
import { deleteRunLocalPipelineBranches, removeWorktreeAndDeleteBranch } from "../git/git";
import { archiveAgentLogged, type PipelineContext } from "./context";

// Prevent overlapping agent.archived events and sweeper ticks from running duplicate cascade archives for the same subtree.
const archivingSubtreeKeys = new Set<string>();

// Role depth ensures leaf peers close before stage coordinators and stage coordinators close before Master Lead.
const ROLE_ARCHIVE_PRIORITY: Readonly<Record<string, number>> = {
  peer: 0,
  base_peer: 0,
  forked_lead: 1,
  master_lead: 2,
  supervisor: 3,
};

function hasMasterLeadRecord(run: Run): boolean {
  return Object.values(run.agents).some((agentRecord) => agentRecord.role === "master_lead");
}

function hasStageForkedLeadRecord(run: Run, peerRecord: AgentRecord): boolean {
  if (!peerRecord.pipelineId || !peerRecord.stageId) return false;
  // A stage peer is only considered orphaned when no Forked Lead record exists for its stage.
  return Object.values(run.agents).some(
    (candidateRecord) =>
      candidateRecord.role === "forked_lead"
      && candidateRecord.pipelineId === peerRecord.pipelineId
      && candidateRecord.stageId === peerRecord.stageId,
  );
}

// Resolve direct children of a parent agent using both explicit parentAgentId links and structural role/stage ownership.
export function directChildAgentsOf(run: Run, parentAgentId: string): AgentRecord[] {
  const parentRecord = run.agents[parentAgentId];
  const isSupervisorParent = parentRecord?.role === "supervisor" || run.supervisorAgentId === parentAgentId;
  const isMasterLeadParent = parentRecord?.role === "master_lead" || run.masterLeadAgentId === parentAgentId;
  const isForkedLeadParent = parentRecord?.role === "forked_lead";
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
      // Master Lead sessions belong directly under the Supervisor even in older snapshots without parentAgentId.
      if (
        candidateRecord.role === "master_lead"
        && (!candidateRecord.parentAgentId || !run.agents[candidateRecord.parentAgentId])
      ) {
        registerChild(candidateRecord);
        continue;
      }
      // Attach orphaned stage leads or peers if a partial fixture omitted the intermediate Master Lead record.
      if (candidateRecord.role === "forked_lead" && !hasMasterLeadRecord(run)) {
        registerChild(candidateRecord);
        continue;
      }
      if (candidateRecord.role === "peer" && !hasMasterLeadRecord(run) && !hasStageForkedLeadRecord(run, candidateRecord)) {
        registerChild(candidateRecord);
      }
      continue;
    }
    if (isMasterLeadParent && run.masterLeadAgentId === parentAgentId) {
      // Every Forked Lead without an explicit live parent belongs to the current Master Lead.
      if (
        candidateRecord.role === "forked_lead"
        && (!candidateRecord.parentAgentId || !run.agents[candidateRecord.parentAgentId])
      ) {
        registerChild(candidateRecord);
        continue;
      }
      // Attach stage peers directly if their stage's Forked Lead record was omitted from the store.
      if (candidateRecord.role === "peer" && !hasStageForkedLeadRecord(run, candidateRecord)) {
        registerChild(candidateRecord);
      }
      continue;
    }
    if (
      isForkedLeadParent
      && candidateRecord.role === "peer"
      && (!candidateRecord.parentAgentId || !run.agents[candidateRecord.parentAgentId])
      && parentRecord.pipelineId !== null
      && parentRecord.stageId !== null
      && candidateRecord.pipelineId === parentRecord.pipelineId
      && candidateRecord.stageId === parentRecord.stageId
    ) {
      const owningStage = run.pipelines[parentRecord.pipelineId]?.stages.find(
        (stageCandidate) => stageCandidate.id === parentRecord.stageId,
      );
      // Peers without an explicit parent link belong to their stage's active Forked Lead coordinator.
      if (!owningStage || owningStage.forkedLeadAgentId === parentAgentId) {
        registerChild(candidateRecord);
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
  const canUsePaseoSdk = typeof ctx.holder?.get === "function"
    && (typeof ctx.holder.isReady !== "function" || ctx.holder.isReady());
  if (
    canUsePaseoSdk
    && targetWorkspaceId
    && targetWorkspaceId !== currentRun.supervisorWorkspaceId
    && targetWorkspaceId !== currentRun.devWorkspaceId
  ) {
    const paseo = await ctx.holder.get();
    await paseo.workspaces.archive(targetWorkspaceId).catch(() => undefined);
  }
  // Remove the worktree registration before deleting the local branch because Git blocks deleting a checked-out branch.
  await removeWorktreeAndDeleteBranch(currentRun.repoPath, {
    worktreePath: integratedPipeline.worktree,
    branchName: integratedPipeline.branch,
    protectedWorktrees: [currentRun.repoPath, currentRun.devCwd],
    protectedBranches: [currentRun.baseBranch, currentRun.integrationBranch],
  });
  if (targetWorkspaceId && ctx.store.find(runId)) {
    try {
      ctx.store.mutate(runId, (mutableRun) => {
        delete mutableRun.pipelineWorkspaces[targetWorkspaceId];
      });
    } catch {
      // Ignore mutations that arrive after the SQLite store is closed during plugin or test teardown.
    }
  }
  if (willAllPipelinesBeIntegrated) {
    // Once all pipelines are integrated, sweep any remaining slp/<runId8>/* local branches that are not bound to an active pipeline.
    const latestRun = ctx.store.find(runId);
    const activePipelineBranches = latestRun
      ? Object.values(latestRun.pipelines)
          .filter((candidatePipeline) => candidatePipeline.id !== pipelineId && !["integrated", "failed"].includes(candidatePipeline.status))
          .map((candidatePipeline) => candidatePipeline.branch)
          .filter((branchName): branchName is string => Boolean(branchName))
      : [];
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
      // Persist the aborted status before awaiting SDK archive calls so in-flight creations and sweeper ticks stop immediately.
      ctx.store.mutate(runId, (mutableRun) => {
        const supervisorRecord = mutableRun.agents[archivedAgentId] ?? mutableRun.agents[mutableRun.supervisorAgentId];
        if (supervisorRecord) {
          supervisorRecord.archivedAt ??= effectiveArchivedAt;
        }
        if (!["completed", "aborted"].includes(mutableRun.status)) {
          mutableRun.status = "aborted";
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
      const archivedDescendants = await archiveAgentSubtree(ctx, runId, archivedAgentId);
      if (wasActiveRun || archivedDescendants.length > 0) {
        await archiveOwnedWorkspaces(ctx, ctx.store.require(runId));
        ctx.logEvent(runId, {
          taskId: null,
          from: archivedAgentId || "supervisor",
          to: "pipeline",
          kind: "supervisor.archived",
          summary: `Supervisor archived; archived ${archivedDescendants.length} dependent lead/peer agent(s)`,
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
      if (targetRecord.role === "master_lead") {
        // Pause active pipelines without queueing a resume prompt so the sweeper does not respawn archived stage cohorts.
        for (const mutablePipeline of Object.values(mutableRun.pipelines)) {
          if (["queued", "peer_understand", "starting", "running"].includes(mutablePipeline.status)) {
            mutablePipeline.status = "paused";
            mutablePipeline.pausedReason ??= "Master Lead was archived; dependent stage leads and peers were archived.";
            mutablePipeline.updatedAt = effectiveArchivedAt;
          }
        }
      } else if (targetRecord.role === "forked_lead" && targetRecord.pipelineId) {
        const mutablePipeline = mutableRun.pipelines[targetRecord.pipelineId];
        const currentStage = mutablePipeline?.stages[mutablePipeline.currentStageIndex];
        // Pause when the archived Forked Lead owns either the active peer_understand phase or the currently running stage.
        const ownsActivePeerUnderstand = Boolean(
          mutablePipeline?.status === "peer_understand"
          && mutablePipeline.peerUnderstand.forkedLeadAgentId === archivedAgentId
          && ["pending", "starting", "running"].includes(mutablePipeline.peerUnderstand.status),
        );
        const ownsActiveStage = Boolean(
          mutablePipeline
          && ["queued", "starting", "running"].includes(mutablePipeline.status)
          && currentStage?.id === targetRecord.stageId
          && ["pending", "starting", "running"].includes(currentStage.status),
        );
        if (mutablePipeline && (ownsActivePeerUnderstand || ownsActiveStage)) {
          mutablePipeline.status = "paused";
          mutablePipeline.pausedReason ??= `Stage Lead (${archivedAgentId}) was archived; child peers were archived.`;
          mutablePipeline.updatedAt = effectiveArchivedAt;
        }
      }
    });

    const archivedDescendants = await archiveAgentSubtree(ctx, runId, archivedAgentId);
    if (targetRecord.role === "master_lead" || targetRecord.role === "forked_lead") {
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
