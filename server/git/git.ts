// Thin git wrappers used by the pipeline. All calls go through execCommand so the daemon's
// process helpers handle quoting and platform differences.
import { execCommand } from "@getpaseo/plugin/server";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

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
  // Uncommitted and untracked files count too: the gate must see writes the Implementer never committed (shell edits, generated files).
  const uncommittedPaths = parsePorcelainPaths(
    await runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  return [...new Set([...committedPaths, ...uncommittedPaths])];
}

// Keeps pipeline files (TASK_SPEC.md, .slp/) out of `git add -A` so they never reach a merge.
export async function excludeFromGit(workingDirectory: string, patterns: string[]): Promise<void> {
  // Uses info/exclude (per clone, never committed) so the ignore rule does not itself show up in the diff.
  const excludeRelativePath = (
    await runGit(workingDirectory, ["rev-parse", "--git-path", "info/exclude"])
  ).trim();
  const excludeFilePath = isAbsolute(excludeRelativePath)
    ? excludeRelativePath
    : join(workingDirectory, excludeRelativePath);
  await mkdir(dirname(excludeFilePath), { recursive: true });
  let existingExcludes = "";
  try {
    existingExcludes = await readFile(excludeFilePath, "utf8");
  } catch {
    // no exclude file yet; it is created by the append below
  }
  // Idempotent: a second run on the same repo must not append duplicate patterns.
  const missingPatterns = patterns.filter((pattern) => !existingExcludes.split("\n").includes(pattern));
  if (missingPatterns.length > 0) {
    await appendFile(excludeFilePath, `${missingPatterns.join("\n")}\n`, "utf8");
  }
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
