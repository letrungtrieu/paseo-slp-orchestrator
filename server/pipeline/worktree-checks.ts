// Preconditions shared by feature-branch merges and QA pipeline closure.
import type { PipelineState } from "../../shared/pipeline";
import { runGit } from "../git/git";
import { ToolError } from "./tool-error";

export async function requireCleanWorktree(
  worktreePath: string,
  label: string,
  includeUntracked = true,
): Promise<void> {
  // Pipeline worktrees must commit all untracked files, whereas the main checkout may contain untracked .slp/*.md templates.
  const untrackedFlag = includeUntracked ? "--untracked-files=all" : "--untracked-files=no";
  const porcelainStatus = await runGit(worktreePath, ["status", "--porcelain=v1", untrackedFlag]);
  if (porcelainStatus.trim()) {
    throw new ToolError(
      includeUntracked
        ? `${label} has uncommitted or untracked files.`
        : `${label} has uncommitted tracked changes.`,
    );
  }
}

export function completedPipeline(pipeline: PipelineState): boolean {
  return pipeline.status === "completed"
    && pipeline.stages.length > 0
    && pipeline.stages.every((stage) => stage.status === "completed" && stage.result !== null);
}
