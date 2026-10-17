// Real temporary git repositories for the pipeline simulation: the pipeline's git helpers run
// real `git`, so the fixture must be a genuine repository rather than a mock.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function runGitSync(workingDirectory: string, gitArguments: string[]): string {
  return execFileSync("git", gitArguments, { cwd: workingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface GitFixture {
  repoPath: string;
  baseBranch: string;
}

export function createGitRepository(repoPath: string): GitFixture {
  mkdirSync(repoPath, { recursive: true });
  runGitSync(repoPath, ["init", "-b", "main"]);
  // identity lives in the repo-local config so no global git state is touched
  runGitSync(repoPath, ["config", "user.email", "slp-test@example.invalid"]);
  runGitSync(repoPath, ["config", "user.name", "SLP Test"]);
  runGitSync(repoPath, ["config", "commit.gpgsign", "false"]);
  writeWorkingFiles(repoPath, { "README.md": "# fixture\n", "src/index.ts": "export const base = 1;\n" });
  runGitSync(repoPath, ["add", "-A"]);
  runGitSync(repoPath, ["commit", "-m", "initial commit"]);
  return { repoPath, baseBranch: "main" };
}

export function writeWorkingFiles(workingDirectory: string, fileContentsByPath: Record<string, string>): void {
  for (const [relativePath, fileContent] of Object.entries(fileContentsByPath)) {
    const absolutePath = join(workingDirectory, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, fileContent, "utf8");
  }
}

// What a stage peer does before calling slp_stage_report: write files and commit them.
export function commitFiles(workingDirectory: string, fileContentsByPath: Record<string, string>, message: string): void {
  writeWorkingFiles(workingDirectory, fileContentsByPath);
  runGitSync(workingDirectory, ["add", "-A"]);
  runGitSync(workingDirectory, ["commit", "-m", message]);
}

// What the Master Lead does after being told a task is ready: merge the task branch into dev.
export function mergeBranchInto(workingDirectory: string, branchToMerge: string): void {
  runGitSync(workingDirectory, ["merge", "--no-ff", "-m", `merge ${branchToMerge}`, branchToMerge]);
}
