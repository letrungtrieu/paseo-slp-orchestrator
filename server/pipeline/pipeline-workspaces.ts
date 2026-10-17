// Worktree creation is the boundary where a Lead receives a real shared checkout.
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { PaseoApi } from "../runtime/paseo-holder";
import type { PipelineContext } from "./context";
import type { PipelineWorkspace, Run } from "../../shared/state";
import { currentBranchName, runGit } from "../git/git";
import { ToolError } from "./tool-error";

type WorkspaceHandle = Awaited<ReturnType<PaseoApi["workspaces"]["create"]>>;
interface RegisteredWorktree { cwd: string; branch: string; }
interface ValidatedCheckout { cwd: string; branch: string; baseCommit: string; }

// A single process can receive duplicate tool calls before the first SDK request completes.
const creatingBranches = new Map<string, Promise<string>>();

function branchForName(runId: string, name: string): string {
  // Branch names are generated centrally so the recovery lookup and the original request agree.
  const branchSlug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  if (!branchSlug) throw new ToolError("Choose a worktree name containing letters or digits.");
  return `slp/${runId.slice(0, 8)}/${branchSlug}`;
}

function worktreeLockKey(runId: string, branch: string): string {
  return `${runId}\u0000${branch}`;
}

function assertWorktreeCreationAllowed(run: Run): void {
  if (run.status !== "planning" && run.status !== "running") {
    throw new ToolError("Worktrees can be created while planning or running.");
  }
}

async function gitCommonDirectory(checkoutPath: string): Promise<string> {
  const commonDirectory = (await runGit(checkoutPath, ["rev-parse", "--git-common-dir"])).trim();
  return realpath(resolve(checkoutPath, commonDirectory));
}

async function validateCheckout(
  run: Run,
  checkoutPath: string,
  expectedBranch: string | null,
): Promise<ValidatedCheckout> {
  const cwd = await realpath(checkoutPath);
  const rootPath = await realpath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
  // A nested directory is not a safe writable boundary because peers could escape its intended scope.
  if (rootPath !== cwd) throw new ToolError("pipeline.worktree must be the root of a git worktree.");

  const repositoryRoot = await realpath(run.repoPath);
  const [checkoutCommon, repositoryCommon] = await Promise.all([
    gitCommonDirectory(cwd),
    gitCommonDirectory(run.repoPath),
  ]);
  // Git worktrees share a common directory; this rejects a path from another repository even if its branch matches.
  if (checkoutCommon !== repositoryCommon) throw new ToolError("Pipeline worktree must belong to this run's repository.");

  const integrationRoot = await realpath(run.devCwd).catch(() => null);
  if (cwd === repositoryRoot || cwd === integrationRoot) {
    throw new ToolError("Give peers a separate worktree; use slp_create_worktree for the pipeline checkout.");
  }

  const branch = await currentBranchName(cwd);
  if (expectedBranch && branch !== expectedBranch) {
    throw new ToolError(`Worktree is on '${branch}', expected '${expectedBranch}'.`);
  }
  // Sharing the integration or base branch would let peers modify a merge target directly.
  if (branch === run.integrationBranch || branch === run.baseBranch) {
    throw new ToolError("Pipeline worktree must use a branch separate from the integration and base branches.");
  }
  const baseCommit = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
  return { cwd, branch, baseCommit };
}

async function registeredWorktreeForBranch(repoPath: string, branch: string): Promise<RegisteredWorktree | null> {
  // Null separators preserve checkout paths containing newlines, non-ASCII text or Git quoting characters.
  const porcelain = await runGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
  let currentWorktree: { cwd: string; branch: string | null } | null = null;
  const inspectCurrent = (): RegisteredWorktree | null => (
    currentWorktree?.branch === branch && currentWorktree.cwd
      ? { cwd: currentWorktree.cwd, branch }
      : null
  );

  for (const line of porcelain.split("\0")) {
    if (line.startsWith("worktree ")) {
      const registered = inspectCurrent();
      if (registered) return registered;
      currentWorktree = { cwd: line.slice("worktree ".length), branch: null };
    } else if (currentWorktree && line.startsWith("branch refs/heads/")) {
      currentWorktree.branch = line.slice("branch refs/heads/".length);
    }
  }
  return inspectCurrent();
}

async function refreshedDirectory(workspace: WorkspaceHandle): Promise<string> {
  // The SDK may populate directory only after refresh; use the refreshed payload when available.
  const refreshed = await workspace.refresh();
  const directory = refreshed?.workspaceDirectory ?? workspace.directory;
  if (!directory) throw new ToolError("Paseo created a worktree without a directory.");
  return directory;
}

async function archiveCreatedWorkspace(
  ctx: PipelineContext,
  runId: string,
  workspace: WorkspaceHandle,
  reason: string,
): Promise<void> {
  try {
    const archiveResult = await workspace.archive();
    if (archiveResult.error) throw new Error(archiveResult.error);
  } catch (archiveError) {
    // Cleanup is best effort, but recording failure makes a leaked SDK workspace actionable after an abort.
    if (ctx.store.find(runId)) {
      ctx.logEvent(runId, {
        taskId: null,
        from: "pipeline",
        to: workspace.id,
        kind: "workspace.archive_failed",
        summary: reason,
        outcome: "error",
        reason: archiveError instanceof Error ? archiveError.message : String(archiveError),
      });
    }
  }
}

function persistOwnedWorkspace(ctx: PipelineContext, runId: string, workspace: PipelineWorkspace): void {
  const run = ctx.store.require(runId);
  assertWorktreeCreationAllowed(run);
  ctx.store.mutate(runId, (mutableRun) => {
    // The per-branch lock handles local races; this guard also protects a record restored during a restart.
    const branchOwner = Object.values(mutableRun.pipelineWorkspaces).find((knownWorkspace) => knownWorkspace.branch === workspace.branch);
    if (branchOwner && branchOwner.workspaceId !== workspace.workspaceId) {
      throw new ToolError(`Branch '${workspace.branch}' is already registered as worktree '${branchOwner.workspaceId}'.`);
    }
    mutableRun.pipelineWorkspaces[workspace.workspaceId] = workspace;
  });
}

async function recoverRegisteredWorktree(
  ctx: PipelineContext,
  runId: string,
  branch: string,
  registeredWorktree: RegisteredWorktree,
): Promise<string> {
  const run = ctx.store.require(runId);
  assertWorktreeCreationAllowed(run);
  const paseo = await ctx.holder.get();
  // Opening the existing checkout avoids asking Git/Paseo to create a branch that already exists after a crash.
  const workspace = await paseo.workspaces.open(registeredWorktree.cwd);
  const directory = await refreshedDirectory(workspace);
  const checkout = await validateCheckout(run, directory, branch);
  // A branch discovered after an SDK error belongs to this generated request; remove it if abort won the race.
  if (ctx.store.require(runId).status !== "planning" && ctx.store.require(runId).status !== "running") {
    await archiveCreatedWorkspace(ctx, runId, workspace, "recovered worktree belongs to an aborted run");
    throw new ToolError("Run stopped while the worktree was being recovered.");
  }
  const recoveredWorkspace: PipelineWorkspace = {
    workspaceId: workspace.id,
    cwd: checkout.cwd,
    branch: checkout.branch,
    // The generated branch is the plugin's idempotency key; external paths passed to definePipeline stay unowned.
    owned: true,
  };
  persistOwnedWorkspace(ctx, runId, recoveredWorkspace);
  return JSON.stringify(recoveredWorkspace);
}

async function createPipelineWorktreeLocked(
  ctx: PipelineContext,
  runId: string,
  name: string,
  branch: string,
): Promise<string> {
  const run = ctx.store.require(runId);
  assertWorktreeCreationAllowed(run);
  const persistedWorkspace = Object.values(run.pipelineWorkspaces).find((workspace) => workspace.branch === branch);
  if (persistedWorkspace) return JSON.stringify(persistedWorkspace);

  // A daemon crash can leave the Git checkout alive even though SQLite never received its workspace id.
  const registeredWorktree = await registeredWorktreeForBranch(run.repoPath, branch);
  if (registeredWorktree) return recoverRegisteredWorktree(ctx, runId, branch, registeredWorktree);

  const paseo = await ctx.holder.get();
  let createdWorkspace: WorkspaceHandle | null = null;
  let persisted = false;
  try {
    try {
      createdWorkspace = await paseo.workspaces.create({
        source: { kind: "worktree", cwd: run.repoPath, action: "branch-off", refName: run.integrationBranch, branchName: branch },
        title: `SLP pipeline · ${name}`,
      });
    } catch (creationError) {
      // The SDK may report an existing branch after its Git operation succeeded; inspect Git before failing the retry.
      const lateRegisteredWorktree = await registeredWorktreeForBranch(run.repoPath, branch);
      if (lateRegisteredWorktree) return recoverRegisteredWorktree(ctx, runId, branch, lateRegisteredWorktree);
      throw creationError;
    }

    const directory = await refreshedDirectory(createdWorkspace);
    const checkout = await validateCheckout(run, directory, branch);
    // abortRun marks the run before archiving known resources, so this check catches a late SDK completion.
    if (ctx.store.require(runId).status !== "planning" && ctx.store.require(runId).status !== "running") {
      throw new ToolError("Run stopped while the worktree was being created.");
    }
    const ownedWorkspace: PipelineWorkspace = {
      workspaceId: createdWorkspace.id,
      cwd: checkout.cwd,
      branch: checkout.branch,
      owned: true,
    };
    persistOwnedWorkspace(ctx, runId, ownedWorkspace);
    persisted = true;
    return JSON.stringify(ownedWorkspace);
  } finally {
    // Only this invocation may archive the SDK-created handle; recovered or user-supplied worktrees are never deleted here.
    if (createdWorkspace && !persisted) {
      await archiveCreatedWorkspace(ctx, runId, createdWorkspace, "worktree creation did not complete");
    }
  }
}

export async function createPipelineWorktree(ctx: PipelineContext, runId: string, name: string): Promise<string> {
  const run = ctx.store.require(runId);
  assertWorktreeCreationAllowed(run);
  const branch = branchForName(runId, name);
  if (branch === run.integrationBranch || branch === run.baseBranch) {
    throw new ToolError(`Worktree name '${name}' resolves to a protected branch; choose a different name.`);
  }
  const persistedWorkspace = Object.values(run.pipelineWorkspaces).find((workspace) => workspace.branch === branch);
  if (persistedWorkspace) return JSON.stringify(persistedWorkspace);

  const lockKey = worktreeLockKey(runId, branch);
  const existingCreation = creatingBranches.get(lockKey);
  if (existingCreation) return existingCreation;
  const creation = createPipelineWorktreeLocked(ctx, runId, name, branch);
  creatingBranches.set(lockKey, creation);
  try {
    return await creation;
  } finally {
    if (creatingBranches.get(lockKey) === creation) creatingBranches.delete(lockKey);
  }
}

function activePipelineUsingCheckout(ctx: PipelineContext, run: Run, checkout: ValidatedCheckout): string | null {
  for (const candidateRun of ctx.store.list()) {
    if (candidateRun.id === run.id
      || candidateRun.engineVersion !== "dynamic-stages-v1"
      || candidateRun.status === "completed"
      || candidateRun.status === "aborted") continue;
    const activePipeline = Object.values(candidateRun.pipelines).find(
      (pipeline) => !["integrated", "failed"].includes(pipeline.status)
        && pipeline.worktree === checkout.cwd,
    );
    if (activePipeline) return activePipeline.name;
  }
  return null;
}

export async function openPipelineWorktree(ctx: PipelineContext, run: Run, worktreePath: string) {
  const absolutePath = isAbsolute(worktreePath) ? worktreePath : resolve(run.repoPath, worktreePath);
  let cwd: string;
  try { cwd = await realpath(absolutePath); }
  catch { throw new ToolError(`Worktree '${absolutePath}' does not exist. Create it with slp_create_worktree first.`); }

  const checkout = await validateCheckout(run, cwd, null);
  const sameRunConflict = Object.values(run.pipelines).find(
    (pipeline) => !["integrated", "failed"].includes(pipeline.status)
      && (pipeline.worktree === checkout.cwd || pipeline.branch === checkout.branch),
  );
  if (sameRunConflict) throw new ToolError(`Worktree or branch is already assigned to pipeline '${sameRunConflict.name}'.`);
  const crossRunConflict = activePipelineUsingCheckout(ctx, run, checkout);
  if (crossRunConflict) throw new ToolError(`Worktree or branch is already assigned to active pipeline '${crossRunConflict}'.`);

  const paseo = await ctx.holder.get();
  const workspace = await paseo.workspaces.open(checkout.cwd);
  await workspace.refresh();
  // External worktrees are usable but remain unowned so abort/finalize cleanup cannot delete user resources.
  return { cwd: checkout.cwd, branch: checkout.branch, baseCommit: checkout.baseCommit, workspaceId: workspace.id };
}
