// Wires a real pipeline (real RunStore, real git, real mailbox) to a fake gateway and fake Paseo.
// Tests then drive it through the bus dispatcher exactly as the agents' tool calls would.
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { BusCaller, BusToolOutcome } from "../../server/bus/http-mcp";
import { claudeForker } from "../../server/fork/claude-forker";
import { ForkRegistry, type SessionForker } from "../../server/fork/session-forker";
import type { PipelineContext } from "../../server/pipeline/context";
import { createPipeline } from "../../server/pipeline/pipeline";
import { startRun } from "../../server/pipeline/run-lifecycle";
import { createBusDispatcher } from "../../server/pipeline/tool-handlers";
import type { AgentGateway } from "../../server/runtime/agent-gateway";
import type { PaseoHolder } from "../../server/runtime/paseo-holder";
import { RunStore } from "../../server/store/run-store";
import type { RunMode, SlpRole } from "../../shared/roles";
import type { MailboxMessage, Run, Task } from "../../shared/state";
import { FakeAgentGateway } from "./fake-gateway";
import { FakePaseo, FakePaseoHolder } from "./fake-paseo";
import { createGitRepository } from "./git-fixture";
import { useTemporaryDirectories } from "./temp-directory";

export type ForkerChoice = "claude" | "unwired" | "throwing";

export interface FlowOptions {
  mode: RunMode;
  forker?: ForkerChoice;
}

export interface Flow {
  ctx: PipelineContext;
  store: RunStore;
  gateway: FakeAgentGateway;
  paseo: FakePaseo;
  repoPath: string;
  baseBranch: string;
  databasePath: string;
  startRun(): Promise<string>;
  run(runId: string): Run;
  task(runId: string, taskId: string): Task;
  agentId(runId: string, role: string, taskId?: string | null): string;
  callAs(agentId: string, toolName: string, toolArguments: unknown): Promise<BusToolOutcome>;
  callAsRole(runId: string, role: string, taskId: string | null, toolName: string, toolArguments: unknown): Promise<BusToolOutcome>;
  mailTo(runId: string, agentId: string): MailboxMessage[];
  deliverMail(runId: string): Promise<number>;
}

// A forker that is registered but cannot fork: the degraded (stored-spec) path.
// Models a provider whose adapter exists but returns null, exercising the degraded stored-spec path.
const UNWIRED_CLAUDE_FORKER: SessionForker = { family: "claude", bind: async () => null };
const THROWING_CLAUDE_FORKER: SessionForker = {
  family: "claude",
  bind: async () => {
    throw new Error("fork adapter exploded");
  },
};

const FORKERS: Record<ForkerChoice, SessionForker> = {
  claude: claudeForker,
  unwired: UNWIRED_CLAUDE_FORKER,
  throwing: THROWING_CLAUDE_FORKER,
};

// Call once per test file; the returned factory creates isolated flows cleaned up after each test.
export function useFlowFixture(): (options: FlowOptions) => Promise<Flow> {
  const createTemporaryDirectory = useTemporaryDirectories();
  const createdStores: RunStore[] = [];

  afterEach(async () => {
    // Close SQLite before temporary directories disappear, including their WAL and shared-memory files.
    for (const createdStore of createdStores.splice(0)) createdStore.close();
    vi.restoreAllMocks();
  });

  return async (options: FlowOptions): Promise<Flow> => {
    const rootDirectory = await createTemporaryDirectory("flow");
    // A real git repository is needed because the scope gate shells out to git diff.
    const { repoPath, baseBranch } = createGitRepository(join(rootDirectory, "repo"));
    const databasePath = join(rootDirectory, "state", "orchestrator.sqlite3");
    const store = new RunStore(databasePath);
    createdStores.push(store);
    const gateway = new FakeAgentGateway(store);
    const paseo = new FakePaseo(join(rootDirectory, "worktrees"));
    const holder = new FakePaseoHolder(paseo.asApi());
    // the fakes mirror only the public surface, so they are cast where the real classes are demanded
    const ctx = createPipeline({
      store,
      gateway: gateway as unknown as AgentGateway,
      holder: holder as unknown as PaseoHolder,
      forks: new ForkRegistry([FORKERS[options.forker ?? "claude"]]),
    });
    // The dispatcher is the same one the HTTP bus uses, so tests exercise role checks and audit logging too.
    const dispatcher = createBusDispatcher(ctx);

    const findRecord = (runId: string, role: string, taskId: string | null) => {
      const taskAgents = Object.values(store.require(runId).agents).filter((agentRecord) => agentRecord.taskId === taskId);
      // Prefer the business identity when several reviewers share the same runtime capability.
      const matchingRecord = taskAgents.find((agentRecord) => agentRecord.projectRole === role)
        ?? taskAgents.find((agentRecord) => agentRecord.role === role);
      if (!matchingRecord) throw new Error(`No ${role} agent for task ${taskId} in run ${runId}`);
      return matchingRecord;
    };
    // Callers are rebuilt from the store each time, exactly like token authentication does in production.
    const callerOf = (agentId: string): BusCaller => {
      const lookup = store.findAgent(agentId);
      if (!lookup) throw new Error(`Unknown agent ${agentId}`);
      return { runId: lookup.run.id, agentId, role: lookup.agentRecord.role, taskId: lookup.agentRecord.taskId,
        ...(lookup.agentRecord.projectRole ? { projectRole: lookup.agentRecord.projectRole } : {}) };
    };

    return {
      ctx, store, gateway, paseo, repoPath, baseBranch, databasePath,
      startRun: async () => {
        const startedRun = await startRun(ctx, {
          repoPath, baseBranch, mode: options.mode, title: "Flow test",
          // Providers are fake ids; the fork resolver only looks at the family prefix of the lead provider.
          providers: { supervisor: "claude/sonnet", lead: "claude/sonnet", peer: "codex/gpt" },
        });
        return startedRun.runId;
      },
      run: (runId) => store.require(runId),
      task: (runId, taskId) => store.require(runId).tasks[taskId],
      agentId: (runId, role, taskId = null) => findRecord(runId, role, taskId).agentId,
      callAs: (agentId, toolName, toolArguments) => dispatcher.dispatch(callerOf(agentId), toolName, toolArguments),
      callAsRole: (runId, role, taskId, toolName, toolArguments) =>
        dispatcher.dispatch(callerOf(findRecord(runId, role, taskId).agentId), toolName, toolArguments),
      mailTo: (runId, agentId) => store.require(runId).mailbox.filter((message) => message.toAgentId === agentId),
      deliverMail: async (runId) => {
        // mail is only delivered to idle agents; the fake agents finish their turns instantly
        gateway.markEveryAgentIdle();
        return ctx.mailbox.flush(runId, await gateway.liveStatuses(runId));
      },
    };
  };
}
