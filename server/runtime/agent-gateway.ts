// Everything the pipeline needs from Paseo agents, behind one seam: create role agents with a
// private bus identity, prompt them, read their live status and archive them.
import { randomBytes, randomUUID } from "node:crypto";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import type { AgentRecord, Run } from "../../shared/state";
import { toolNamesForRole } from "../bus/tool-schemas";
import { systemPromptFor, type StagePromptContext } from "../prompts/system-prompts";
import { resolveAgentSettings, unattendedModeForProvider } from "../project-prompts/agent-settings";
import type { RunStore } from "../store/run-store";
import type { PaseoApi, PaseoHolder } from "./paseo-holder";

export interface AgentLiveStatus {
  agentId: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  pendingPermissions: AgentPermissionRequest[];
  archived: boolean;
}

export interface ActiveShellCall {
  callId: string;
  command: string;
  cwd: string | null;
  output: string;
  startedAt: string | null;
}


export interface CreateAgentSpec {
  runId: string;
  role: SlpRole;
  projectRole?: string;
  writeScope?: string[];
  leadContinuationTool?: string | null;
  taskId: string | null;
  // Stage identity is separate from legacy task identity because one pipeline can create
  // several fresh peer cohorts for the same worktree.
  pipelineId?: string | null;
  stageId?: string | null;
  stagePeerId?: string | null;
  // Stage context belongs in the system prompt so every peer sees the same roster and goal,
  // while initialPrompt remains available for a one-off kickoff message after cohort creation.
  stageContext?: StagePromptContext;
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

// Only Claude, Codex and OpenCode support exact MCP tool preapproval in Paseo; plugin and ACP
// providers such as Antigravity reject session.open when toolPolicy is present and rely on decidePermission.
const PROVIDERS_WITHOUT_TOOL_POLICY = new Set([
  "antigravity",
  "muse",
  "copilot",
  "cursor",
  "pi",
  "omp",
  "kimi",
  "kiro",
  "traecli",
]);

function isUnsupportedToolPolicyError(error: unknown): boolean {
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (errorCode === "tool_policy_unsupported") return true;
  const errorMessage = error instanceof Error ? error.message : String(error);
  // Both plugin providers ("Provider does not support permission.tool_policy") and built-in
  // providers without exact preapproval reject toolPolicy before opening the session.
  return /permission\.tool_policy|tool_policy_unsupported|cannot preapprove exact mcp tools/i.test(errorMessage);
}

function isUnsupportedPeerModelError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  // Providers reject unknown or unavailable models during session creation with a model-related error message.
  return /\bmodel\b.*\b(?:not found|unknown|invalid|unsupported|unavailable|does not exist)\b/i.test(errorMessage);
}

// Older saved runs have no selected mode, so use each supported provider's native unattended mode.
export function permissionModeFor(providerModel: string): string | undefined {
  const providerId = providerModel.split("/", 1)[0];
  // Paseo owns the provider-specific IDs; passing a guessed universal ID can make agent creation fail.
  return unattendedModeForProvider(providerId);
}

function statusFromSnapshot(agentSnapshot: AgentSnapshotPayload, persistedRecord?: AgentRecord): AgentLiveStatus {
  return {
    agentId: agentSnapshot.id,
    status: agentSnapshot.status,
    pendingPermissions: agentSnapshot.pendingPermissions,
    // Persisted archive state wins while the directory projection catches up after a restart.
    archived: Boolean(agentSnapshot.archivedAt || persistedRecord?.archivedAt),
  };
}

function isCurrentStageAgent(run: Run, agentRecord: AgentRecord): boolean {
  if (run.status !== "running" || agentRecord.archivedAt || !agentRecord.pipelineId || !agentRecord.stageId) return false;
  const pipeline = run.pipelines[agentRecord.pipelineId];
  if (!pipeline) return false;
  const currentStage = pipeline.stages[pipeline.currentStageIndex];
  // Only refresh the cohort that can still receive work; archived prior stages should not be revived.
  return Boolean(
    ["starting", "running", "paused"].includes(pipeline.status)
    && currentStage
    && ["starting", "running", "completing"].includes(currentStage.status)
    && currentStage.id === agentRecord.stageId,
  );
}

// Each Lead owns planning, pause recovery, integration and reporting across its feature pipeline, so directory misses must be verified too.
function isActiveMasterLead(run: Run, agentRecord: AgentRecord): boolean {
  return (
    !agentRecord.archivedAt
    && agentRecord.role === "master_lead"
    && !["completed", "aborted"].includes(run.status)
  );
}

// Verify Supervisor and Lead directory misses so archiving any parent in Paseo always cascades to its child agents.
function isActiveParentCoordinator(run: Run, agentRecord: AgentRecord): boolean {
  if (agentRecord.archivedAt || ["completed", "aborted"].includes(run.status)) return false;
  if (agentRecord.role === "supervisor") return agentRecord.agentId === run.supervisorAgentId;
  return agentRecord.role === "master_lead";
}

export function isConfirmedMissingAgentError(error: unknown, agentId: string): boolean {
  const errorMessage = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  if (/^agent\s+(?:not found|does not exist)\b/.test(errorMessage) || /^unknown agent\b/.test(errorMessage)) return true;
  if (errorMessage.includes("is archived") && errorMessage.includes(agentId.toLowerCase())) return true;
  // Generic SDK/network errors must remain unknown; only an error naming this identity can confirm absence.
  return errorMessage.includes(agentId.toLowerCase()) && /\b(?:not found|does not exist|unknown|archived)\b/.test(errorMessage);
}

async function refreshMissingActiveAgent(
  paseo: PaseoApi,
  store: RunStore,
  persistedRecord: AgentRecord,
): Promise<AgentLiveStatus | null> {
  try {
    const refreshed = await paseo.agents.ref(persistedRecord.agentId).refresh();
    if (!refreshed?.agent) {
      // A null fetch result is the SDK's explicit missing-agent response, unlike a transport failure.
      return { agentId: persistedRecord.agentId, status: "closed", pendingPermissions: [], archived: true };
    }
    return statusFromSnapshot(refreshed.agent, store.findAgent(persistedRecord.agentId)?.agentRecord);
  } catch (refreshError) {
    if (isConfirmedMissingAgentError(refreshError, persistedRecord.agentId)) {
      // Treat only a confirmed identity miss as archived so transient SDK failures cannot create a new cohort.
      return { agentId: persistedRecord.agentId, status: "closed", pendingPermissions: [], archived: true };
    }
    // An unavailable directory leaves the agent unknown; callers must not infer that it was archived.
    return null;
  }
}

export class AgentGateway {
  private readonly providersWithoutToolPolicy = new Set<string>(PROVIDERS_WITHOUT_TOOL_POLICY);

  constructor(
    private readonly holder: PaseoHolder,
    private readonly store: RunStore,
    private readonly busPort: () => Promise<number>,
  ) {}

  // Expose the per-token loopback endpoint so session-open hooks can inject it into stdio CLI environments.
  async busEndpointForToken(agentToken: string): Promise<string> {
    const activeBusPort = await this.busPort();
    return `http://127.0.0.1:${activeBusPort}/mcp/${agentToken}`;
  }

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
      pipelineId: spec.pipelineId ?? null,
      stageId: spec.stageId ?? null,
      stagePeerId: spec.stagePeerId ?? null,
      parentAgentId: spec.parentAgentId ?? null,
      workspaceId: spec.workspaceId ?? null,
      worktreePath: spec.peerWorktreePath ?? null,
      featureName: null,
      featureCriteria: null,
      archivedAt: null,
      token: randomBytes(24).toString("base64url"),
      // Direct stage messages can temporarily defer an agent's normal report obligation.
      waitingForAgentId: null,
      deferredTool: null,
      awaitingTool: spec.awaitTool,
      // Starts the nudge clock at creation: an agent that never calls the tool it owes is detected by the sweeper from this timestamp.
      awaitingSince: spec.awaitTool ? new Date().toISOString() : null,
      nudges: 0,
      createdAt: new Date().toISOString(),
    };
    this.store.mutate(spec.runId, (run) => {
      run.agents[agentId] = agentRecord;
    });
    const busToolNames = toolNamesForRole(spec.role);
    try {
      // Refresh belongs inside the rollback boundary: a stale workspace is just as much a failed
      // creation as an SDK rejection, and must not leave an authenticated orphan in SQLite.
      const workspace = paseo.workspaces.ref(spec.workspaceId);
      await workspace.refresh();
      const baseAgentCreation = {
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
          // Dynamic stage labels let recovery find an exact cohort without depending on a task record.
          "slp.pipeline": spec.pipelineId ?? "",
          "slp.stage": spec.stageId ?? "",
          "slp.peer": spec.stagePeerId ?? "",
          // Workspace path and group labels make task peers searchable together in Paseo.
          ...(spec.peerWorktreePath ? { "slp.group": "peers", "slp.worktree": spec.peerWorktreePath } : {}),
        },
        // Parentage is separate from workspace placement, so a Lead can live in its own integration worktree.
        ...(spec.parentAgentId ? { parent: spec.parentAgentId } : {}),
      };
      const preapprovedToolPolicy = {
        // Pre-approving the role's own bus tools avoids a permission round trip per call when supported.
        preapproved: busToolNames.map((tool) => ({ kind: "mcp" as const, server: BUS_SERVER_NAME, tool })),
      };
      const openAgentWithSettings = async (activeModelSettings: typeof modelSettings): Promise<void> => {
        const selectedProviderId = activeModelSettings.provider.split("/", 1)[0];
        const baseSessionConfig = {
          provider: activeModelSettings.provider,
          modeId: activeModelSettings.permissionModeId ?? permissionModeFor(activeModelSettings.provider),
          ...(activeModelSettings.thinkingOptionId ? { thinkingOptionId: activeModelSettings.thinkingOptionId } : {}),
          systemPrompt: systemPromptFor(
            spec.role,
            this.store.require(spec.runId).promptConfig,
            spec.projectRole,
            spec.stageContext,
          ),
          mcpServers: {
            [BUS_SERVER_NAME]: {
              type: "http" as const,
              // load tool schemas up front; deferred tools made agents call slp_ tools with empty arguments
              alwaysLoad: true,
              url: `http://127.0.0.1:${busPort}/mcp/${agentRecord.token}`,
            },
          },
          ...(spec.extraOptions ? { options: spec.extraOptions } : {}),
        };
        if (this.providersWithoutToolPolicy.has(selectedProviderId)) {
          await workspace.agents.create({ ...baseAgentCreation, config: baseSessionConfig });
          return;
        }
        try {
          await workspace.agents.create({
            ...baseAgentCreation,
            config: { ...baseSessionConfig, toolPolicy: preapprovedToolPolicy },
          });
        } catch (toolPolicyError) {
          if (!isUnsupportedToolPolicyError(toolPolicyError)) throw toolPolicyError;
          // Custom or plugin providers without permission.tool_policy still authorize bus tools via decidePermission.
          this.providersWithoutToolPolicy.add(selectedProviderId);
          await workspace.agents.create({ ...baseAgentCreation, config: baseSessionConfig });
        }
      };

      try {
        await openAgentWithSettings(modelSettings);
      } catch (sessionCreateError) {
        // When a .slp/peers model override is rejected by the provider at runtime, fall back to the global config.
        if (
          spec.role === "peer"
          && modelSettings.provider !== spec.provider
          && isUnsupportedPeerModelError(sessionCreateError)
        ) {
          await openAgentWithSettings({
            provider: spec.provider,
            permissionModeId: spec.permissionModeId ?? permissionModeFor(spec.provider),
            thinkingOptionId: modelSettings.thinkingOptionId ?? spec.thinkingOptionId,
          });
        } else {
          throw sessionCreateError;
        }
      }
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
    const persistedRecord = this.store.findAgent(agentId)?.agentRecord;
    // Recovery must never revive a peer whose stage already closed, even if a stale mailbox entry remains.
    if (persistedRecord?.archivedAt) throw new Error(`Agent '${agentId}' is archived.`);
    const paseo = await this.holder.get();
    await paseo.agents.ref(agentId).send(text);
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

  // Reads the tail of an agent's timeline so the shell watchdog can track stdout/stderr progress without model tokens.
  async activeShellCall(agentId: string): Promise<ActiveShellCall | null> {
    const paseo = await this.holder.get();
    try {
      const timelinePage = await paseo.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: 15,
      });
      for (let entryIndex = timelinePage.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
        const timelineEntry = timelinePage.entries[entryIndex];
        const timelineItem = timelineEntry?.item;
        if (!timelineItem || timelineItem.type !== "tool_call" || timelineItem.status !== "running") continue;
        if (timelineItem.detail.type === "shell") {
          return {
            callId: timelineItem.callId,
            command: timelineItem.detail.command,
            cwd: timelineItem.detail.cwd ?? null,
            output: timelineItem.detail.output ?? "",
            startedAt: timelineEntry.timestamp ?? null,
          };
        }
        // Fallback for custom or ACP providers that surface shell tool calls under 'unknown' detail with a command input string.
        if (timelineItem.detail.type === "unknown" && /^(bash|sh|shell|exec_command|run_command|terminal)$/i.test(timelineItem.name)) {
          const rawInput = timelineItem.detail.input;
          const commandFromInput =
            rawInput && typeof rawInput === "object" && "command" in rawInput && typeof rawInput.command === "string"
              ? rawInput.command
              : null;
          if (commandFromInput) {
            return {
              callId: timelineItem.callId,
              command: commandFromInput,
              cwd: rawInput && typeof rawInput === "object" && "cwd" in rawInput && typeof rawInput.cwd === "string"
                ? rawInput.cwd
                : null,
              output: typeof timelineItem.detail.output === "string" ? timelineItem.detail.output : "",
              startedAt: timelineEntry.timestamp ?? null,
            };
          }
        }
      }
      return null;
    } catch {
      // Transient timeline read errors must not fail the sweeper tick; the next sweep will re-check.
      return null;
    }
  }


  // Events are best effort, so truth comes from a directory poll; this is what the mailbox and sweeper trust to decide an agent is idle.
  async liveStatuses(runId: string): Promise<Map<string, AgentLiveStatus>> {
    const paseo = await this.holder.get();
    const statusByAgentId = new Map<string, AgentLiveStatus>();
    let directoryCursor: string | undefined;
    do {
      const directoryPage = await paseo.agents.list({
        filter: { labels: { "slp.run": runId } },
        // The daemon caps each page at 200, so every cursor must be consumed before recovery trusts absence.
        page: { limit: 200, ...(directoryCursor ? { cursor: directoryCursor } : {}) },
      });
      for (const directoryEntry of directoryPage.entries) {
        const agentSnapshot = directoryEntry.agent;
        statusByAgentId.set(agentSnapshot.id, statusFromSnapshot(agentSnapshot, this.store.findAgent(agentSnapshot.id)?.agentRecord));
      }
      const nextDirectoryCursor = directoryPage.pageInfo.nextCursor ?? undefined;
      // A malformed/replayed cursor must not spin the three-second sweeper forever.
      if (!nextDirectoryCursor || nextDirectoryCursor === directoryCursor) break;
      directoryCursor = nextDirectoryCursor;
    } while (directoryCursor);

    const currentRun = this.store.require(runId);
    const recipientsWithQueuedMail = new Set(currentRun.mailbox.map((queuedMessage) => queuedMessage.toAgentId));
    const missingActiveAgents = Object.values(currentRun.agents).filter(
      (agentRecord) =>
        !agentRecord.archivedAt
        && (
          isCurrentStageAgent(currentRun, agentRecord)
          || isActiveMasterLead(currentRun, agentRecord)
          || isActiveParentCoordinator(currentRun, agentRecord)
          || recipientsWithQueuedMail.has(agentRecord.agentId)
        )
        && !statusByAgentId.has(agentRecord.agentId),
    );
    // Directory projections can lag immediately after creation; refresh only the bounded active cohort, Master Lead and Supervisor.
    const refreshedStatuses = await Promise.all(
      missingActiveAgents.map((agentRecord) => refreshMissingActiveAgent(paseo, this.store, agentRecord)),
    );
    for (const refreshedStatus of refreshedStatuses) {
      if (refreshedStatus) statusByAgentId.set(refreshedStatus.agentId, refreshedStatus);
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
    try {
      await paseo.agents.ref(agentId).archive();
    } catch (archiveError) {
      // If Paseo already archived this child via parent cascade, record its archive timestamp instead of failing.
      if (!isConfirmedMissingAgentError(archiveError, agentId)) {
        throw archiveError;
      }
    }
    // Mark only after Paseo confirms the archive, so a transient SDK failure remains recoverable.
    const lookup = this.store.findAgent(agentId);
    if (lookup) {
      this.store.mutate(lookup.run.id, (run) => {
        const agentRecord = run.agents[agentId];
        if (agentRecord) agentRecord.archivedAt ??= new Date().toISOString();
      });
    }
  }
}
