// Paseo workspace/worktree creation for a run: the Supervisor's main checkout, the integration
// ("dev") worktree and one hidden worktree per task.
import type { Run, Task } from "../../shared/state";
import type { PaseoApi } from "../runtime/paseo-holder";

export interface CreatedWorkspace {
  workspaceId: string;
  cwd: string;
}

// The Supervisor lives in the user's own checkout; `open` reuses an existing workspace for it.
export async function openSupervisorWorkspace(paseo: PaseoApi, repoPath: string): Promise<CreatedWorkspace> {
  // reuses the user's workspace if Paseo already tracks it, so the Supervisor does not get a duplicate entry in the sidebar.
  const workspace = await paseo.workspaces.open(repoPath);
  await workspace.refresh();
  return { workspaceId: workspace.id, cwd: workspace.directory ?? repoPath };
}

async function createWorktreeWorkspace(
  paseo: PaseoApi,
  repoPath: string,
  fromRef: string,
  branchName: string,
  title: string,
): Promise<CreatedWorkspace> {
  const workspace = await paseo.workspaces.create({
    // Branching from the integration branch makes it the merge base the scope gate diffs against (listChangedFiles).
    source: { kind: "worktree", cwd: repoPath, action: "branch-off", refName: fromRef, branchName },
    title,
  });
  // the handle returned by create may not carry the directory until the first refresh
  await workspace.refresh();
  if (!workspace.directory) throw new Error(`Workspace for branch ${branchName} has no directory`);
  return { workspaceId: workspace.id, cwd: workspace.directory };
}

export function createIntegrationWorkspace(paseo: PaseoApi, run: Pick<Run, "repoPath" | "baseBranch" | "integrationBranch" | "title">) {
  return createWorktreeWorkspace(paseo, run.repoPath, run.baseBranch, run.integrationBranch, `SLP dev: ${run.title}`);
}

export function taskBranchName(run: Pick<Run, "id">, task: Pick<Task, "id">): string {
  // The short run id prefix keeps branch names unique across runs on the same repo.
  return `slp/${run.id.slice(0, 8)}/${task.id}`;
}

export async function createTaskWorkspace(paseo: PaseoApi, run: Run, task: Task) {
  // Background (hidden) workspaces only exist in unreleased Paseo, so on 0.11.4 these are visible.
  // The workspace title labels the peers that share this task's worktree in Paseo's sidebar.
  const createdWorkspace = await createWorktreeWorkspace(
    paseo,
    run.repoPath,
    run.integrationBranch,
    taskBranchName(run, task),
    `SLP peers · ${taskBranchName(run, task)}: ${task.title}`,
  );
  return { ...createdWorkspace, branch: taskBranchName(run, task) };
}
