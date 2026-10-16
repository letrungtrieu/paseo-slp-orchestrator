// Stub of the Paseo SDK surface used by the pipeline (workspaces + agent timeline) and of the
// holder that hands it out. Worktrees are REAL `git worktree add` directories so the scope gate
// can run `git diff` against them.
import { join } from "node:path";
import type { PaseoApi } from "../../server/runtime/paseo-holder";
import { runGitSync } from "./git-fixture";

export interface WorkspaceCreateRequest {
  source: { kind: string; cwd: string; action: string; refName: string; branchName: string };
  title: string;
}

export interface TimelineAppendCall {
  agentId: string;
  item: { id: string; kind: string; data: { taskId: string; phase: string } };
}

export class FakePaseo {
  readonly openedRepositories: string[] = [];
  readonly createdWorkspaces: Array<{ request: WorkspaceCreateRequest; workspaceId: string; directory: string }> = [];
  readonly archivedWorkspaceIds: string[] = [];
  readonly timelineAppends: TimelineAppendCall[] = [];
  private workspaceCounter = 0;

  constructor(private readonly worktreeRootDirectory: string) {}

  asApi(): PaseoApi {
    // Aliased because the object literal below needs the instance while its arrows must not rebind `this`.
    const fakePaseo = this;
    return {
      workspaces: {
        open: async (repoPath: string) => {
          fakePaseo.openedRepositories.push(repoPath);
          return fakePaseo.buildHandle("ws-supervisor", repoPath);
        },
        create: async (request: WorkspaceCreateRequest) => fakePaseo.createWorktreeWorkspace(request),
        ref: (workspaceId: string) => fakePaseo.buildHandle(workspaceId, null),
        archive: async (workspaceId: string) => {
          fakePaseo.archivedWorkspaceIds.push(workspaceId);
        },
      },
      agents: {
        ref: (agentId: string) => ({
          timeline: {
            append: async (item: TimelineAppendCall["item"]) => {
              fakePaseo.timelineAppends.push({ agentId, item });
            },
          },
        }),
      },
    // Only the surface the pipeline touches is faked, so the cast is the honest way to satisfy the full SDK type.
    } as unknown as PaseoApi;
  }

  cardsForTask(taskId: string): TimelineAppendCall["item"]["data"][] {
    return this.timelineAppends.filter((append) => append.item.id === `task-${taskId}`).map((append) => append.item.data);
  }

  private buildHandle(workspaceId: string, directory: string | null) {
    // Matches the real handle: `directory` can be null until refresh, which is why the pipeline always refreshes first.
    return { id: workspaceId, directory, refresh: async () => undefined };
  }

  private createWorktreeWorkspace(request: WorkspaceCreateRequest) {
    this.workspaceCounter += 1;
    const workspaceId = `ws-${this.workspaceCounter}`;
    const directory = join(this.worktreeRootDirectory, `worktree-${this.workspaceCounter}`);
    // same call Paseo makes for action "branch-off": a new branch cut from refName
    runGitSync(request.source.cwd, ["worktree", "add", "-b", request.source.branchName, directory, request.source.refName]);
    this.createdWorkspaces.push({ request, workspaceId, directory });
    return this.buildHandle(workspaceId, directory);
  }
}

// Same public surface as PaseoHolder, without the 30 s wait for a first hook event.
export class FakePaseoHolder {
  readonly captures: unknown[] = [];
  // flips to false to emulate a plugin restart where no hook has delivered the SDK handle yet
  ready = true;

  constructor(private readonly paseo: PaseoApi) {}

  capture(capturedPaseo: unknown): void {
    this.captures.push(capturedPaseo);
  }

  async get(): Promise<PaseoApi> {
    return this.paseo;
  }

  isReady(): boolean {
    return this.ready;
  }
}
