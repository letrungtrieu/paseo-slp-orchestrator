// Helper predicates, live status reconciliation, and timeline shell inspection for AgentGateway.
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { AgentRecord, Run } from "../../shared/state";
import { unattendedModeForProvider } from "../project-prompts/agent-settings";
import type { RunStore } from "../store/run-store";
import type { ActiveShellCall, AgentLiveStatus } from "./agent-gateway";
import type { PaseoApi } from "./paseo-holder";

// Only Claude, Codex and OpenCode support exact MCP tool preapproval in Paseo; plugin and ACP
// providers such as Antigravity reject session.open when toolPolicy is present and rely on decidePermission.
export const PROVIDERS_WITHOUT_TOOL_POLICY: ReadonlySet<string> = new Set([
  "antigravity",
  "muse",
  "copilot",
  "cursor",
  "pi",
  "omp",
  "kimi",
  "kiro",
  "kiro-cli",
  "traecli",
]);

// ACP providers expose Paseo's `auto_accept` feature toggle ("Auto accept permission prompts")
// rather than a static unattended mode in @getpaseo/protocol's manifest.
export const ACP_AUTO_ACCEPT_PROVIDERS: ReadonlySet<string> = new Set([
  "kiro",
  "kiro-cli",
  "cursor",
  "copilot",
  "pi",
  "omp",
  "kimi",
  "traecli",
]);

// Identify Kiro CLI provider IDs whether configured as 'kiro', 'kiro-cli', or qualified with a model suffix.
export function isKiroProvider(providerOrModel: string | null | undefined): boolean {
  if (!providerOrModel) return false;
  const normalizedProviderId = providerOrModel.trim().toLowerCase().split("/", 1)[0];
  return normalizedProviderId === "kiro" || normalizedProviderId === "kiro-cli";
}

// Always enable Paseo's ACP `auto_accept` feature for Kiro CLI and ACP providers so permission prompts do not stall turns.
export function defaultFeatureValuesForProvider(
  providerOrModel: string,
  existingFeatureValues?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const normalizedProviderId = providerOrModel.trim().toLowerCase().split("/", 1)[0];
  if (!ACP_AUTO_ACCEPT_PROVIDERS.has(normalizedProviderId)) {
    return existingFeatureValues;
  }
  return {
    ...existingFeatureValues,
    auto_accept: true,
  };
}

export function isUnsupportedToolPolicyError(error: unknown): boolean {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (errorCode === "tool_policy_unsupported") return true;
  const errorMessage = error instanceof Error ? error.message : String(error);
  // Both plugin providers ("Provider does not support permission.tool_policy") and built-in
  // providers without exact preapproval reject toolPolicy before opening the session.
  return /permission\.tool_policy|tool_policy_unsupported|cannot preapprove exact mcp tools/i.test(
    errorMessage,
  );
}

export function isUnsupportedPeerModelError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  // Providers reject unknown or unavailable models during session creation with a model-related error message.
  return /\bmodel\b.*\b(?:not found|unknown|invalid|unsupported|unavailable|does not exist)\b/i.test(
    errorMessage,
  );
}

export function isUnavailableWorkspaceDirectoryError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  // Archiving a workspace in Paseo detaches its directory until workspaces.open re-attaches the checkout path.
  return /has no available directory|workspace.*(?:archived|not found|does not exist)/i.test(
    errorMessage,
  );
}

// Older saved runs have no selected mode, so use each supported provider's native unattended mode.
export function permissionModeFor(providerModel: string): string | undefined {
  const providerId = providerModel.split("/", 1)[0];
  // Paseo owns the provider-specific IDs; passing a guessed universal ID can make agent creation fail.
  return unattendedModeForProvider(providerId);
}

export function statusFromSnapshot(
  agentSnapshot: AgentSnapshotPayload,
  persistedRecord?: AgentRecord,
): AgentLiveStatus {
  return {
    agentId: agentSnapshot.id,
    status: agentSnapshot.status,
    pendingPermissions: agentSnapshot.pendingPermissions,
    // Persisted archive state wins while the directory projection catches up after a restart.
    archived: Boolean(agentSnapshot.archivedAt || persistedRecord?.archivedAt),
  };
}

export function isCurrentStageAgent(run: Run, agentRecord: AgentRecord): boolean {
  if (run.status !== "running" || agentRecord.archivedAt || !agentRecord.pipelineId || !agentRecord.stageId) {
    return false;
  }
  const pipeline = run.pipelines[agentRecord.pipelineId];
  if (!pipeline) return false;
  const currentStage = pipeline.stages[pipeline.currentStageIndex];
  // Only refresh the cohort that can still receive work; archived prior stages should not be revived.
  return Boolean(
    ["starting", "running", "paused"].includes(pipeline.status) &&
      currentStage &&
      ["starting", "running", "completing"].includes(currentStage.status) &&
      currentStage.id === agentRecord.stageId,
  );
}

// Each Lead owns planning, pause recovery, integration and reporting across its feature pipeline, so directory misses must be verified too.
export function isActiveMasterLead(run: Run, agentRecord: AgentRecord): boolean {
  return (
    !agentRecord.archivedAt &&
    agentRecord.role === "master_lead" &&
    !["completed", "aborted"].includes(run.status)
  );
}

// Verify Supervisor and Lead directory misses so archiving any parent in Paseo always cascades to its child agents.
export function isActiveParentCoordinator(run: Run, agentRecord: AgentRecord): boolean {
  if (agentRecord.archivedAt || ["completed", "aborted"].includes(run.status)) return false;
  if (agentRecord.role === "supervisor") return agentRecord.agentId === run.supervisorAgentId;
  return agentRecord.role === "master_lead";
}

export function isConfirmedMissingAgentError(error: unknown, agentId: string): boolean {
  const errorMessage = (error instanceof Error ? error.message : String(error)).trim().toLowerCase();
  if (
    /^agent\s+(?:not found|does not exist)\b/.test(errorMessage) ||
    /^unknown agent\b/.test(errorMessage)
  ) {
    return true;
  }
  if (errorMessage.includes("is archived") && errorMessage.includes(agentId.toLowerCase())) return true;
  // Generic SDK/network errors must remain unknown; only an error naming this identity can confirm absence.
  return (
    errorMessage.includes(agentId.toLowerCase()) &&
    /\b(?:not found|does not exist|unknown|archived)\b/.test(errorMessage)
  );
}

export async function refreshMissingActiveAgent(
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

// Reads the tail of an agent's timeline so the shell watchdog can track stdout/stderr progress without model tokens.
export async function fetchActiveShellCallFromTimeline(
  paseo: PaseoApi,
  agentId: string,
): Promise<ActiveShellCall | null> {
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
      if (
        timelineItem.detail.type === "unknown" &&
        /^(bash|sh|shell|exec_command|run_command|terminal)$/i.test(timelineItem.name)
      ) {
        const rawInput = timelineItem.detail.input;
        const commandFromInput =
          rawInput && typeof rawInput === "object" && "command" in rawInput && typeof rawInput.command === "string"
            ? rawInput.command
            : null;
        if (commandFromInput) {
          return {
            callId: timelineItem.callId,
            command: commandFromInput,
            cwd:
              rawInput && typeof rawInput === "object" && "cwd" in rawInput && typeof rawInput.cwd === "string"
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
