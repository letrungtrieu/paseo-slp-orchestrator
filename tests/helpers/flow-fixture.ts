// Wires the dynamic pipeline to a real RunStore, real git and fake Paseo agents. Tests drive
// the MCP dispatcher so every call follows the same authentication boundary as production.
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
import type { RunMode } from "../../shared/roles";
import type { MailboxMessage, Run } from "../../shared/state";
import type { PipelineState } from "../../shared/pipeline";
import { normalizePipelineRoleId } from "../../shared/pipeline";
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
  pipeline(runId: string, pipelineId?: string): PipelineState | undefined;
  agentId(runId: string, role: string, stageId?: string | null): string;
  callAs(agentId: string, toolName: string, toolArguments: unknown): Promise<BusToolOutcome>;
  callAsRole(runId: string, role: string, stageId: string | null, toolName: string, toolArguments: unknown): Promise<BusToolOutcome>;
  mailTo(runId: string, agentId: string): MailboxMessage[];
  deliverMail(runId: string): Promise<number>;
}

// A forker that is registered but cannot fork models the stored-spec fallback path. It keeps
// dynamic stage tests independent of provider-specific native fork support.
const UNWIRED_CLAUDE_FORKER: SessionForker = { family: "claude", bind: async () => null };
const THROWING_CLAUDE_FORKER: SessionForker = {
  family: "claude",
  bind: async () => { throw new Error("fork adapter exploded"); },
};
const FORKERS: Record<ForkerChoice, SessionForker> = {
  claude: claudeForker,
  unwired: UNWIRED_CLAUDE_FORKER,
  throwing: THROWING_CLAUDE_FORKER,
};

// Call once per test file; the returned factory creates isolated repositories and databases.
export function useFlowFixture(): (options: FlowOptions) => Promise<Flow> {
  const createTemporaryDirectory = useTemporaryDirectories();
  const createdStores: RunStore[] = [];

  afterEach(async () => {
    // SQLite must close before temporary directories disappear, including WAL and shared-memory files.
    for (const createdStore of createdStores.splice(0)) createdStore.close();
    vi.restoreAllMocks();
  });

  return async (options: FlowOptions): Promise<Flow> => {
    const rootDirectory = await createTemporaryDirectory("flow");
    const { repoPath, baseBranch } = createGitRepository(join(rootDirectory, "repo"));
    const databasePath = join(rootDirectory, "state", "orchestrator.sqlite3");
    const store = new RunStore(databasePath);
    createdStores.push(store);
    const gateway = new FakeAgentGateway(store);
    const paseo = new FakePaseo(join(rootDirectory, "worktrees"));
    const holder = new FakePaseoHolder(paseo.asApi());
    const ctx = createPipeline({
      store,
      gateway: gateway as unknown as AgentGateway,
      holder: holder as unknown as PaseoHolder,
      forks: new ForkRegistry([FORKERS[options.forker ?? "claude"]]),
    });
    const dispatcher = createBusDispatcher(ctx);

    const findRecord = (runId: string, role: string, stageId: string | null) => {
      const currentRun = store.require(runId);
      const records = Object.values(currentRun.agents).filter((agent) => !agent.archivedAt);
      const normalizedRole = normalizePipelineRoleId(role);
      const effectiveRole = role === "forked_lead" ? "master_lead" : role;
      // Leads supervise both run-level pipeline definition and active stage execution in their worktree.
      const stageRecords = stageId === null
        ? records.filter((agent) => agent.stageId === null || (effectiveRole === "master_lead" && agent.role === "master_lead"))
        : records.filter(
            (agent) =>
              agent.stageId === stageId
              || (effectiveRole === "master_lead"
                && agent.role === "master_lead"
                && Object.values(currentRun.pipelines).some((pipeline) =>
                  pipeline.stages.some(
                    (stage) =>
                      stage.id === stageId
                      && (stage.forkedLeadAgentId === agent.agentId || pipeline.leadAgentId === agent.agentId),
                  ),
                )),
          );
      const matchingRecord = stageRecords.find((agent) => agent.projectRole === normalizedRole)
        ?? stageRecords.find((agent) => agent.role === effectiveRole);
      if (!matchingRecord) throw new Error(`No ${role} agent for stage ${stageId ?? "(run)"}`);
      return matchingRecord;
    };
    const callerOf = (agentId: string): BusCaller => {
      const lookup = store.findAgent(agentId);
      if (!lookup) throw new Error(`Unknown agent ${agentId}`);
      return {
        runId: lookup.run.id,
        agentId,
        role: lookup.agentRecord.role,
        projectRole: lookup.agentRecord.projectRole,
        taskId: null,
      };
    };

    return {
      ctx,
      store,
      gateway,
      paseo,
      repoPath,
      baseBranch,
      databasePath,
      startRun: async () => {
        const startedRun = await startRun(ctx, {
          repoPath,
          baseBranch,
          mode: options.mode,
          name: "Flow test",
          providers: { supervisor: "claude/sonnet", lead: "claude/sonnet", peer: "claude/sonnet" },
        });
        return startedRun.runId;
      },
      run: (runId) => store.require(runId),
      pipeline: (runId, pipelineId) => {
        const pipelines = Object.values(store.require(runId).pipelines);
        return pipelineId ? store.require(runId).pipelines[pipelineId] : pipelines.at(-1);
      },
      agentId: (runId, role, stageId = null) => findRecord(runId, role, stageId).agentId,
      callAs: (agentId, toolName, toolArguments) => dispatcher.dispatch(callerOf(agentId), toolName, toolArguments),
      callAsRole: (runId, role, stageId, toolName, toolArguments) =>
        dispatcher.dispatch(callerOf(findRecord(runId, role, stageId).agentId), toolName, toolArguments),
      mailTo: (runId, agentId) => store.require(runId).mailbox.filter((message) => message.toAgentId === agentId),
      deliverMail: async (runId) => {
        gateway.markEveryAgentIdle();
        return ctx.mailbox.flush(runId, await gateway.liveStatuses(runId));
      },
    };
  };
}
