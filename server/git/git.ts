// Thin git wrappers used by the pipeline. All calls go through execCommand so the daemon's
// process helpers handle quoting and platform differences.
import { execCommand } from "@getpaseo/plugin/server";

export async function runGit(workingDirectory: string, gitArguments: string[]): Promise<string> {
  // Goes through execCommand rather than child_process so quoting and platform differences stay the daemon's problem.
  const { stdout } = await execCommand("git", gitArguments, {
    cwd: workingDirectory,
    // Large diffs of generated files would overflow the default 1 MB buffer and look like a git failure.
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

export async function currentBranchName(repoPath: string): Promise<string> {
  const branchName = (await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // a detached HEAD cannot be a merge target, so fail early with a readable message
  if (branchName === "HEAD") throw new Error(`Repository ${repoPath} is in detached HEAD state`);
  return branchName;
}

export async function assertGitRepository(repoPath: string): Promise<void> {
  const insideWorkTree = (await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (insideWorkTree !== "true") throw new Error(`${repoPath} is not a git work tree`);
}

// Parses `git status --porcelain=v1 -z`: "XY path\0", where renames add one extra "orig\0" entry.
function parsePorcelainPaths(porcelainOutput: string): string[] {
  const changedPaths: string[] = [];
  const statusEntries = porcelainOutput.split("\0").filter((entry) => entry.length > 0);
  for (let index = 0; index < statusEntries.length; index += 1) {
    const statusEntry = statusEntries[index];
    changedPaths.push(statusEntry.slice(3));
    // Renames carry the old path as an extra entry; skipping it keeps the changed-file list free of phantom paths.
    const isRenameOrCopy = statusEntry[0] === "R" || statusEntry[0] === "C";
    if (isRenameOrCopy) index += 1;
  }
  return changedPaths;
}

// Everything a peer changed relative to the integration branch: commits, staged, unstaged, untracked.
export async function listChangedFiles(
  worktreePath: string,
  integrationBranch: string,
): Promise<string[]> {
  const committedOutput = await runGit(worktreePath, [
    "diff",
    "--name-only",
    "-z",
    // Three dots diff from the merge base, so commits that landed on the integration branch meanwhile are not blamed on the peer.
    `${integrationBranch}...HEAD`,
  ]);
  const committedPaths = committedOutput.split("\0").filter((entry) => entry.length > 0);
  // Uncommitted and untracked files count too: the gate must see writes a stage peer never committed (shell edits, generated files).
  const uncommittedPaths = parsePorcelainPaths(
    await runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  return [...new Set([...committedPaths, ...uncommittedPaths])];
}

// Final approval: merge the integration branch into the base branch checked out in the repo.
export async function mergeIntegrationIntoBase(
  repoPath: string,
  baseBranch: string,
  integrationBranch: string,
): Promise<string> {
  const checkedOutBranch = await currentBranchName(repoPath);
  // Refuses to merge into whatever happens to be checked out: the human may have switched branches since the run started.
  if (checkedOutBranch !== baseBranch) {
    throw new Error(`Repository is on '${checkedOutBranch}', expected base branch '${baseBranch}'`);
  }
  // Untracked files are ignored on purpose; only tracked changes can conflict with the merge.
  const dirtyStatus = (await runGit(repoPath, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirtyStatus) throw new Error("Base branch has uncommitted changes; commit or stash them first");
  // When Leads share the Supervisor's checkout, pipeline branches are already merged directly into baseBranch during finalization.
  if (integrationBranch === baseBranch) {
    return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
  }
  // --no-ff keeps one merge commit per run so the whole SLP result can be reverted in one step.
  try {
    await runGit(repoPath, ["merge", "--no-ff", "-m", `SLP: merge ${integrationBranch}`, integrationBranch]);
  } catch (mergeError) {
    // a conflicted merge leaves MERGE_HEAD in the human's own checkout; undo it before reporting the failure
    await runGit(repoPath, ["merge", "--abort"]).catch(() => undefined);
    throw mergeError;
  }
  return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
}

const LOCAL_ONLY_PIPELINE_REMOTE = "slp-local-only";
const LOCAL_ONLY_PIPELINE_REMOTE_URL = "/dev/null/slp-temporary-branch-do-not-push";

// Bind a pipeline branch to a non-pushable pseudo-remote so accidental `git push` calls fail locally instead of publishing temporary branches.
export async function configureLocalOnlyPipelineBranch(
  repoPath: string,
  pipelineBranchName: string,
): Promise<void> {
  await runGit(repoPath, ["config", `remote.${LOCAL_ONLY_PIPELINE_REMOTE}.url`, LOCAL_ONLY_PIPELINE_REMOTE_URL]).catch(() => undefined);
  await runGit(repoPath, ["config", `remote.${LOCAL_ONLY_PIPELINE_REMOTE}.pushurl`, LOCAL_ONLY_PIPELINE_REMOTE_URL]).catch(() => undefined);
  await runGit(repoPath, ["config", `branch.${pipelineBranchName}.pushRemote`, LOCAL_ONLY_PIPELINE_REMOTE]).catch(() => undefined);
}

export interface WorktreeAndBranchCleanupOptions {
  worktreePath?: string | null;
  branchName?: string | null;
  protectedWorktrees?: readonly string[];
  protectedBranches?: readonly string[];
}

// Unregister a temporary pipeline worktree before deleting its local branch because Git refuses to delete a branch checked out in an active worktree.
export async function removeWorktreeAndDeleteBranch(
  repoPath: string,
  cleanupOptions: WorktreeAndBranchCleanupOptions,
): Promise<void> {
  const protectedWorktreeSet = new Set(
    [repoPath, ...(cleanupOptions.protectedWorktrees ?? [])].filter((candidatePath): candidatePath is string => Boolean(candidatePath)),
  );
  const targetWorktreePath = cleanupOptions.worktreePath?.trim() || null;
  if (targetWorktreePath && !protectedWorktreeSet.has(targetWorktreePath)) {
    // Force-remove the worktree checkout if Paseo has not already removed it, then prune stale git worktree administrative entries.
    await runGit(repoPath, ["worktree", "remove", "--force", targetWorktreePath]).catch(() => undefined);
    await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
  }
  const protectedBranchSet = new Set(
    (cleanupOptions.protectedBranches ?? []).filter((candidateBranch): candidateBranch is string => Boolean(candidateBranch)),
  );
  const targetBranchName = cleanupOptions.branchName?.trim() || null;
  if (targetBranchName && !protectedBranchSet.has(targetBranchName)) {
    // Delete the merged local pipeline branch so temporary slp/* branches never accumulate locally or get pushed to remote.
    await runGit(repoPath, ["branch", "-D", targetBranchName]).catch(() => undefined);
  }
}

// Sweep all local `slp/<runId8>/*` branches belonging to a run unless explicitly preserved for a still-active pipeline or base branch.
export async function deleteRunLocalPipelineBranches(
  repoPath: string,
  runId: string,
  sweepOptions?: { preservedBranches?: readonly string[] },
): Promise<string[]> {
  const runBranchPrefix = `slp/${runId.slice(0, 8)}/`;
  const preservedBranchSet = new Set(
    (sweepOptions?.preservedBranches ?? []).filter((candidateBranch): candidateBranch is string => Boolean(candidateBranch)),
  );
  const rawBranchListOutput = await runGit(repoPath, [
    "for-each-ref",
    "--format=%(refname:strip=2)",
    `refs/heads/${runBranchPrefix}`,
  ]).catch(() => "");
  const matchingRunBranches = rawBranchListOutput
    .split("\n")
    .map((branchLine) => branchLine.trim())
    .filter((branchName) => branchName.startsWith(runBranchPrefix) && !preservedBranchSet.has(branchName));
  if (matchingRunBranches.length === 0) return [];
  // Prune stale worktree registrations first so Git allows deleting branches whose directories were already removed.
  await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
  const deletedBranchNames: string[] = [];
  for (const stalePipelineBranch of matchingRunBranches) {
    const deletedSuccessfully = await runGit(repoPath, ["branch", "-D", stalePipelineBranch])
      .then(() => true)
      .catch(() => false);
    if (deletedSuccessfully) {
      deletedBranchNames.push(stalePipelineBranch);
    }
  }
  return deletedBranchNames;
}

