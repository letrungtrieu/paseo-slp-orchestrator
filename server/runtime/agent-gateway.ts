// Everything the pipeline needs from Paseo agents, behind one seam: create role agents with a
// private bus identity, prompt them, read their live status and archive them.
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import type { AgentRecord } from "../../shared/state";
import { toolNamesForRole } from "../bus/tool-schemas";
import { systemPromptFor } from "../prompts/system-prompts";
import type { RunStore } from "../store/run-store";
import type { PaseoHolder } from "./paseo-holder";

export interface AgentLiveStatus {
  agentId: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  pendingPermissions: AgentPermissionRequest[];
  archived: boolean;
}

export interface CreateAgentSpec {
  runId: string;
  role: SlpRole;
  taskId: string | null;
  provider: string;
  workspaceId: string;
  title: string;
  initialPrompt: string;
  awaitTool: string | null;
  // provider-native settings, e.g. the Claude session fork flags
  extraOptions?: Record<string, unknown>;
}

export interface TurnResult {
  status: "idle" | "error" | "permission" | "timeout";
  lastMessage: string | null;
  error: string | null;
}

// Permission modes that keep the plugin's permission hook in the loop (see permissions.ts).
export function permissionModeFor(provider: string): string | undefined {
  // Only Claude ids are known to be valid here; other providers keep their own default mode instead of a guessed id Paseo would reject.
  return provider.startsWith("claude") ? "default" : undefined;
}

export class AgentGateway {
  constructor(
    private readonly holder: PaseoHolder,
    private readonly store: RunStore,
    private readonly busPort: () => Promise<number>,
  ) {}

  async createAgent(spec: CreateAgentSpec): Promise<AgentRecord> {
    const paseo = await this.holder.get();
    // the bus starts in the background at plugin load; wait for its port before baking a URL into an agent
    const busPort = await this.busPort();
    // Pre-assigning the id lets the bus token exist before the agent does; the provider-assigned id would arrive too late for that.
    const agentId = randomUUID();
    // The record exists before the agent so its very first tool call can already authenticate.
    const agentRecord: AgentRecord = {
      agentId,
      role: spec.role,
      taskId: spec.taskId,
      token: randomBytes(24).toString("base64url"),
      awaitingTool: spec.awaitTool,
      // Starts the nudge clock at creation: an agent that never calls the tool it owes is detected by the sweeper from this timestamp.
      awaitingSince: spec.awaitTool ? new Date().toISOString() : null,
      nudges: 0,
      createdAt: new Date().toISOString(),
    };
    this.store.mutate(spec.runId, (run) => {
      run.agents[agentId] = agentRecord;
    });
    // Refreshed because the workspace handle may be stale after worktree creation, and the create call needs its current state.
    const workspace = paseo.workspaces.ref(spec.workspaceId);
    await workspace.refresh();
    const busToolNames = toolNamesForRole(spec.role);
    try {
      await workspace.agents.create({
        agentId,
        title: spec.title,
        prompt: spec.initialPrompt,
        // Labels let liveStatuses find a run's agents with one directory query, without trusting in-memory state after a reload.
        labels: {
          "slp.run": spec.runId,
          "slp.role": spec.role,
          "slp.task": spec.taskId ?? "",
        },
        config: {
          provider: spec.provider,
          modeId: permissionModeFor(spec.provider),
          systemPrompt: systemPromptFor(spec.role),
          mcpServers: {
            [BUS_SERVER_NAME]: {
              type: "http",
              // load tool schemas up front; deferred tools made agents call slp_ tools with empty arguments
              alwaysLoad: true,
              url: `http://127.0.0.1:${busPort}/mcp/${agentRecord.token}`,
            },
          },
          // pre-approving the role's own bus tools avoids a permission round trip per call
          toolPolicy: {
            preapproved: busToolNames.map((tool) => ({ kind: "mcp" as const, server: BUS_SERVER_NAME, tool })),
          },
          ...(spec.extraOptions ? { options: spec.extraOptions } : {}),
        },
      });
    } catch (createError) {
      // do not leave a token for an agent that never existed
      this.store.mutate(spec.runId, (run) => {
        delete run.agents[agentId];
      });
      throw createError;
    }
    return agentRecord;
  }

  // send() resolves once the prompt is accepted, not when the turn finishes; completion is observed via events and the sweeper.
  async prompt(agentId: string, text: string): Promise<void> {
    const paseo = await this.holder.get();
    await paseo.agents.ref(agentId).send(text);
  }

  // Unlike prompt(), this blocks for the reply; only the handshake needs the text of a turn.
  async runTurn(agentId: string, text: string, timeoutMs: number): Promise<TurnResult> {
    const paseo = await this.holder.get();
    const turnResult = await paseo.agents.ref(agentId).run(text, { timeoutMs });
    return { status: turnResult.status, lastMessage: turnResult.lastMessage, error: turnResult.error };
  }

  // The status can be 'permission' when a prompt is pending; callers keep waiting because the sweeper answers permissions in the background.
  async waitForIdle(agentId: string, timeoutMs: number): Promise<TurnResult> {
    const paseo = await this.holder.get();
    const turnResult = await paseo.agents.ref(agentId).waitForFinish(timeoutMs);
    return { status: turnResult.status, lastMessage: turnResult.lastMessage, error: turnResult.error };
  }

  // The provider session id is what native session forking resumes from.
  async sessionIdOf(agentId: string): Promise<string | null> {
    const paseo = await this.holder.get();
    const agentHandle = paseo.agents.ref(agentId);
    await agentHandle.refresh();
    return agentHandle.runtimeInfo?.sessionId ?? null;
  }

  // Events are best effort, so truth comes from a directory poll; this is what the mailbox and sweeper trust to decide an agent is idle.
  async liveStatuses(runId: string): Promise<Map<string, AgentLiveStatus>> {
    const paseo = await this.holder.get();
    const directoryPage = await paseo.agents.list({
      filter: { labels: { "slp.run": runId } },
      // 200 is far above any run (a handful of agents per task) and avoids paging logic in the 3 s sweep loop.
      page: { limit: 200 },
    });
    const statusByAgentId = new Map<string, AgentLiveStatus>();
    for (const directoryEntry of directoryPage.entries) {
      const agentSnapshot = directoryEntry.agent;
      statusByAgentId.set(agentSnapshot.id, {
        agentId: agentSnapshot.id,
        status: agentSnapshot.status,
        pendingPermissions: agentSnapshot.pendingPermissions as AgentPermissionRequest[],
        archived: Boolean(agentSnapshot.archivedAt),
      });
    }
    return statusByAgentId;
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const paseo = await this.holder.get();
    await paseo.agents.ref(agentId).respondToPermission({ requestId, response });
  }

  // The record stays in the store: archiving only stops the agent, history and audit lines still refer to it.
  async archive(agentId: string): Promise<void> {
    const paseo = await this.holder.get();
    await paseo.agents.ref(agentId).archive();
  }
}
