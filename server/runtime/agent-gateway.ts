// Everything the pipeline needs from Paseo agents, behind one seam: create role agents with a
// private bus identity, prompt them, read their live status and archive them.
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import type { AgentRecord } from "../../shared/state";
import { toolNamesForRole } from "../bus/tool-schemas";
import { systemPromptFor } from "../prompts/system-prompts";
import { resolveAgentSettings } from "../project-prompts/agent-settings";
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
  projectRole?: string;
  writeScope?: string[];
  leadContinuationTool?: string | null;
  taskId: string | null;
  provider: string;
  // Parent links organize the Paseo sidebar independently from the chosen worktree placement.
  parentAgentId?: string;
  // A role's selected reasoning option must survive every agent creation in that role.
  thinkingOptionId?: string;
  permissionModeId?: string;
  // Peer labels use the task worktree path so the same group can span several peer agents.
  peerWorktreePath?: string;
  workspaceId: string;
  title: string;
  initialPrompt?: string;
  awaitTool: string | null;
  // provider-native settings, e.g. the Claude session fork flags
  extraOptions?: Record<string, unknown>;
}

export interface TurnResult {
  status: "idle" | "error" | "permission" | "timeout";
  lastMessage: string | null;
  error: string | null;
}

// Older saved runs have no selected mode, so use each supported provider's native unattended mode.
export function permissionModeFor(providerModel: string): string | undefined {
  const providerId = providerModel.split("/", 1)[0];
  // Paseo owns the provider-specific IDs; passing a guessed universal ID can make agent creation fail.
  return getUnattendedModeId(providerId);
}

export class AgentGateway {
  constructor(
    private readonly holder: PaseoHolder,
    private readonly store: RunStore,
    private readonly busPort: () => Promise<number>,
  ) {}

  async createAgent(spec: CreateAgentSpec): Promise<AgentRecord> {
    const run = this.store.require(spec.runId);
    // Resolve before allocating an identity so invalid project model settings leave no orphan agent token.
    const modelSettings = resolveAgentSettings(run.promptConfig, spec.role, spec.projectRole, spec);
    const paseo = await this.holder.get();
    // the bus starts in the background at plugin load; wait for its port before baking a URL into an agent
    const busPort = await this.busPort();
    // Pre-assigning the id lets the bus token exist before the agent does; the provider-assigned id would arrive too late for that.
    const agentId = randomUUID();
    // The record exists before the agent so its very first tool call can already authenticate.
    const agentRecord: AgentRecord = {
      agentId,
      role: spec.role,
      projectRole: spec.projectRole ?? null,
      writeScope: spec.writeScope ?? [],
      leadContinuationTool: spec.leadContinuationTool ?? null,
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
          // Business expertise is independent of the task capability used for tool/permission checks.
          "slp.peer-role": spec.projectRole ?? "",
          "slp.task": spec.taskId ?? "",
          // Workspace path and group labels make task peers searchable together in Paseo.
          ...(spec.peerWorktreePath ? { "slp.group": "peers", "slp.worktree": spec.peerWorktreePath } : {}),
        },
        // Parentage is separate from workspace placement, so a Lead can live in its own integration worktree.
        ...(spec.parentAgentId ? { parent: spec.parentAgentId } : {}),
        config: {
          provider: modelSettings.provider,
          modeId: modelSettings.permissionModeId ?? permissionModeFor(modelSettings.provider),
          ...(modelSettings.thinkingOptionId ? { thinkingOptionId: modelSettings.thinkingOptionId } : {}),
          systemPrompt: systemPromptFor(spec.role, this.store.require(spec.runId).promptConfig, spec.projectRole),
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
