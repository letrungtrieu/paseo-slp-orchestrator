// Monitors running peer shell tool calls in code (0 model tokens) by comparing stdout/stderr snapshots
// across sweeper ticks, and wakes the stage's Forked Lead to decide whether to cancel or wait when output stalls.
import type { PipelineState, StageState } from "../../shared/pipeline";
import { DEFAULT_SLP_SETTINGS, type ShellWatchdogSettings } from "../../shared/settings";
import type { AgentRecord, Run } from "../../shared/state";
import type { BusCaller } from "../bus/http-mcp";
import type { ActiveShellCall, AgentLiveStatus } from "../runtime/agent-gateway";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

export interface HandlePeerShellInput {
  peerAgentId: string;
  action: "cancel" | "wait";
  guidance?: string;
  waitSeconds?: number;
}

interface TrackedPeerShellHeartbeat {
  runId: string;
  pipelineId: string;
  stageId: string;
  peerAgentId: string;
  callId: string;
  command: string;
  cwd: string | null;
  lastOutputSnapshot: string;
  firstObservedAtMs: number;
  lastOutputChangedAtMs: number;
  snoozedUntilMs: number;
  lastAlertedAtMs: number | null;
}

// Cap the output tail sent to the Forked Lead so a noisy build log does not bloat the coordinator's context window.
const MAX_ALERT_OUTPUT_LINES = 40;
const MAX_ALERT_OUTPUT_CHARS = 2_000;
const DEFAULT_WAIT_EXTENSION_SECONDS = 120;

// In-memory heartbeat table keyed by peerAgentId; cleared automatically when a peer finishes its shell or turn.
const trackedShellsByPeerAgentId = new Map<string, TrackedPeerShellHeartbeat>();

// Allows isolated test runs to clear module-level heartbeat state between test cases.
export function resetPeerShellWatchdogState(): void {
  trackedShellsByPeerAgentId.clear();
}

async function resolveShellWatchdogSettings(ctx: PipelineContext): Promise<ShellWatchdogSettings> {
  try {
    const resolvedSettings = await ctx.getSettings?.();
    return resolvedSettings?.shellWatchdog ?? DEFAULT_SLP_SETTINGS.shellWatchdog;
  } catch {
    // Fall back to default thresholds if the host settings store is not yet initialized in a test or early boot tick.
    return DEFAULT_SLP_SETTINGS.shellWatchdog;
  }
}

function formatShellOutputTail(rawOutput: string): string {
  const trimmedOutput = rawOutput.trimEnd();
  if (!trimmedOutput) {
    return "(no stdout/stderr output produced yet)";
  }
  // Keep only the trailing lines and characters because hang diagnostics (prompts, watch banners, last test) appear at the end.
  const trailingLines = trimmedOutput.split("\n").slice(-MAX_ALERT_OUTPUT_LINES).join("\n");
  if (trailingLines.length <= MAX_ALERT_OUTPUT_CHARS) {
    return trailingLines;
  }
  return `...${trailingLines.slice(-MAX_ALERT_OUTPUT_CHARS)}`;
}

function buildCoordinatorWatchdogAlertPrompt(
  pipeline: PipelineState,
  stage: StageState,
  peerRecord: AgentRecord,
  activeShell: ActiveShellCall,
  elapsedSeconds: number,
  unchangedOutputSeconds: number,
): string {
  const peerRoleLabel = peerRecord.projectRole ?? peerRecord.role;
  const outputTailText = formatShellOutputTail(activeShell.output);
  // Provide concrete command/cwd/duration/output metrics so the Forked Lead can distinguish a hang from a legitimate build.
  return [
    `## Shell Watchdog Alert — Peer Shell Output Unchanged for ${unchangedOutputSeconds}s`,
    "",
    `- **Pipeline**: \`${pipeline.name}\` (\`${pipeline.id}\`)`,
    `- **Stage**: \`${stage.name}\` (\`${stage.id}\`)`,
    `- **Peer**: \`${peerRecord.agentId}\` (role: \`${peerRoleLabel}\`)`,
    `- **Tool Call ID**: \`${activeShell.callId}\``,
    `- **Command**: \`${activeShell.command}\``,
    `- **Working Directory**: \`${activeShell.cwd ?? pipeline.worktree}\``,
    `- **Total Elapsed**: ${elapsedSeconds}s (${unchangedOutputSeconds}s with zero new stdout/stderr output)`,
    "",
    "### Latest Output Tail",
    "```text",
    outputTailText,
    "```",
    "",
    "### Required Coordinator Decision (`slp_handle_peer_shell`)",
    "Inspect the command and output tail above, then call `slp_handle_peer_shell`: ",
    `1. **Cancel hung/blocking shell**: If the command is stuck in watch mode, waiting for interactive stdin (\`[y/N]\`, passphrase, prompt), deadlocked, or running a foreground server that never exits, call \`slp_handle_peer_shell({ peerAgentId: "${peerRecord.agentId}", action: "cancel", guidance: "<explain why the command hung and what non-interactive command/flag to run instead>" })\`.`,
    `2. **Extend timer for legitimate heavy work**: If the command is a legitimate long-running compilation, test suite, or dependency install that simply has not flushed output yet, call \`slp_handle_peer_shell({ peerAgentId: "${peerRecord.agentId}", action: "wait", waitSeconds: 120 })\` (or an appropriate duration between 15 and 1800 seconds).`,
  ].join("\n");
}

function clearTrackedShellsForRun(runId: string, activeRunningPeerIds?: ReadonlySet<string>): void {
  // Evict peers whose turn ended, whose stage closed, or whose run disabled the watchdog so stale timers never fire later.
  for (const [peerAgentId, trackedHeartbeat] of trackedShellsByPeerAgentId.entries()) {
    if (trackedHeartbeat.runId !== runId) continue;
    if (!activeRunningPeerIds || !activeRunningPeerIds.has(peerAgentId)) {
      trackedShellsByPeerAgentId.delete(peerAgentId);
    }
  }
}

export async function sweepPeerShellWatchdog(
  ctx: PipelineContext,
  run: Run,
  liveStatuses: Map<string, AgentLiveStatus>,
): Promise<void> {
  const shellWatchdogSettings = await resolveShellWatchdogSettings(ctx);
  if (!shellWatchdogSettings.enabled || run.status !== "running") {
    clearTrackedShellsForRun(run.id);
    return;
  }

  const idleTimeoutThresholdMs = shellWatchdogSettings.idleTimeoutSeconds * 1_000;
  const currentSweepTimeMs = Date.now();
  const activeRunningPeers: Array<{
    pipeline: PipelineState;
    stage: StageState;
    peerRecord: AgentRecord;
  }> = [];
  const activeRunningPeerIds = new Set<string>();

  // Only inspect peers belonging to currently running stages that Paseo reports as mid-turn with no pending permission dialog.
  for (const pipeline of Object.values(run.pipelines)) {
    if (pipeline.status !== "running") continue;
    const currentStage = pipeline.stages[pipeline.currentStageIndex];
    if (!currentStage || currentStage.status !== "running") continue;
    for (const peerAgentId of currentStage.peerAgentIds) {
      const peerRecord = run.agents[peerAgentId];
      const peerLiveStatus = liveStatuses.get(peerAgentId);
      if (!peerRecord || peerRecord.archivedAt || !peerLiveStatus || peerLiveStatus.archived) continue;
      if (peerLiveStatus.status !== "running" || peerLiveStatus.pendingPermissions.length > 0) continue;
      activeRunningPeerIds.add(peerAgentId);
      activeRunningPeers.push({ pipeline, stage: currentStage, peerRecord });
    }
  }

  clearTrackedShellsForRun(run.id, activeRunningPeerIds);

  for (const { pipeline, stage, peerRecord } of activeRunningPeers) {
    const activeShell = await ctx.gateway.activeShellCall(peerRecord.agentId);
    if (!activeShell) {
      // The peer is running (e.g. model reasoning or file edit) rather than blocked inside a shell tool call.
      trackedShellsByPeerAgentId.delete(peerRecord.agentId);
      continue;
    }

    const existingHeartbeat = trackedShellsByPeerAgentId.get(peerRecord.agentId);
    if (
      !existingHeartbeat
      || existingHeartbeat.callId !== activeShell.callId
      || existingHeartbeat.command !== activeShell.command
    ) {
      // Start a fresh heartbeat window whenever the peer begins a new shell command.
      trackedShellsByPeerAgentId.set(peerRecord.agentId, {
        runId: run.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        peerAgentId: peerRecord.agentId,
        callId: activeShell.callId,
        command: activeShell.command,
        cwd: activeShell.cwd,
        lastOutputSnapshot: activeShell.output,
        firstObservedAtMs: currentSweepTimeMs,
        lastOutputChangedAtMs: currentSweepTimeMs,
        snoozedUntilMs: 0,
        lastAlertedAtMs: null,
      });
      continue;
    }

    if (existingHeartbeat.lastOutputSnapshot !== activeShell.output) {
      // New stdout/stderr bytes prove the shell command is making progress; reset the idle timer and clear prior alert state.
      existingHeartbeat.lastOutputSnapshot = activeShell.output;
      existingHeartbeat.lastOutputChangedAtMs = currentSweepTimeMs;
      existingHeartbeat.lastAlertedAtMs = null;
      continue;
    }

    const unchangedOutputDurationMs = currentSweepTimeMs - existingHeartbeat.lastOutputChangedAtMs;
    if (unchangedOutputDurationMs < idleTimeoutThresholdMs || currentSweepTimeMs < existingHeartbeat.snoozedUntilMs) {
      continue;
    }

    // Throttle repeat alerts so the Forked Lead has a full timeout window to inspect and respond before being reminded.
    if (
      existingHeartbeat.lastAlertedAtMs !== null
      && currentSweepTimeMs - existingHeartbeat.lastAlertedAtMs < idleTimeoutThresholdMs
    ) {
      continue;
    }

    const latestRun = ctx.store.require(run.id);
    const coordinatorAgentId = stage.forkedLeadAgentId || latestRun.masterLeadAgentId;
    if (!coordinatorAgentId || !latestRun.agents[coordinatorAgentId] || latestRun.agents[coordinatorAgentId].archivedAt) {
      continue;
    }

    // Avoid stacking duplicate unread watchdog alerts in the coordinator's mailbox for the same peer.
    const alreadyQueuedInMailbox = latestRun.mailbox.some(
      (queuedMessage) =>
        queuedMessage.toAgentId === coordinatorAgentId
        && queuedMessage.text.includes(peerRecord.agentId)
        && queuedMessage.text.includes("slp_handle_peer_shell"),
    );
    if (alreadyQueuedInMailbox) {
      existingHeartbeat.lastAlertedAtMs = currentSweepTimeMs;
      continue;
    }

    const elapsedSeconds = Math.max(1, Math.round((currentSweepTimeMs - existingHeartbeat.firstObservedAtMs) / 1_000));
    const unchangedOutputSeconds = Math.max(1, Math.round(unchangedOutputDurationMs / 1_000));
    const alertPrompt = buildCoordinatorWatchdogAlertPrompt(
      pipeline,
      stage,
      peerRecord,
      activeShell,
      elapsedSeconds,
      unchangedOutputSeconds,
    );

    existingHeartbeat.lastAlertedAtMs = currentSweepTimeMs;
    // Enqueue with awaitTool: null so an existing slp_approve_stage obligation on the Forked Lead is never overwritten.
    ctx.mailbox.enqueue(run.id, coordinatorAgentId, alertPrompt, {
      taskId: pipeline.id,
      awaitTool: null,
      from: "watchdog",
      summary: `Shell watchdog alert for peer ${peerRecord.agentId} (${unchangedOutputSeconds}s idle): ${activeShell.command.slice(0, 80)}`,
    });
    ctx.logEvent(run.id, {
      taskId: pipeline.id,
      from: "watchdog",
      to: coordinatorAgentId,
      kind: "peer.shell_suspect_hung",
      summary: `Peer ${peerRecord.agentId} shell silent for ${unchangedOutputSeconds}s: ${activeShell.command.slice(0, 120)}`,
      outcome: "queued",
    });
  }
}

export async function handlePeerShell(
  ctx: PipelineContext,
  caller: BusCaller,
  input: HandlePeerShellInput,
): Promise<string> {
  const currentRun = ctx.store.require(caller.runId);
  const peerRecord = currentRun.agents[input.peerAgentId];
  if (!peerRecord || peerRecord.role !== "peer") {
    throw new ToolError(`Unknown peer agent '${input.peerAgentId}'.`);
  }
  if (peerRecord.archivedAt) {
    throw new ToolError(`Peer '${input.peerAgentId}' is already archived.`);
  }

  const callerRecord = currentRun.agents[caller.agentId];
  // A QA Lead may only steer its own QA peers; feature peers answer to their feature Lead.
  const peerPipeline = peerRecord.pipelineId ? currentRun.pipelines[peerRecord.pipelineId] : undefined;
  if (callerRecord?.role === "qa_lead" && peerPipeline?.kind !== "qa") {
    throw new ToolError(`QA Lead cannot manage peer '${peerRecord.agentId}' of feature pipeline '${peerPipeline?.name ?? "unknown"}'.`);
  }
  // A pipeline Lead only governs peers inside its own task pipeline; the primary Lead can intervene across any pipeline.
  if (
    caller.agentId !== currentRun.masterLeadAgentId
    && callerRecord?.pipelineId
    && peerRecord.pipelineId !== callerRecord.pipelineId
  ) {
    throw new ToolError(
      `Lead '${caller.agentId}' cannot manage peer '${peerRecord.agentId}' from another pipeline.`,
    );
  }

  const trackedHeartbeat = trackedShellsByPeerAgentId.get(peerRecord.agentId);
  // Refresh the caller's awaitingSince clock if it already had an active obligation so handling a peer shell does not trigger a nudge.
  if (callerRecord?.awaitingTool) {
    ctx.store.mutate(currentRun.id, (mutableRun) => {
      const mutableCaller = mutableRun.agents[caller.agentId];
      if (mutableCaller?.awaitingTool) {
        mutableCaller.awaitingSince = new Date().toISOString();
      }
    });
  }

  if (input.action === "wait") {
    const extensionSeconds = input.waitSeconds ?? DEFAULT_WAIT_EXTENSION_SECONDS;
    const snoozedUntilMs = Date.now() + extensionSeconds * 1_000;
    if (trackedHeartbeat) {
      trackedHeartbeat.snoozedUntilMs = snoozedUntilMs;
      trackedHeartbeat.lastAlertedAtMs = null;
    } else {
      const liveShell = await ctx.gateway.activeShellCall(peerRecord.agentId);
      if (liveShell && peerRecord.pipelineId && peerRecord.stageId) {
        const nowMs = Date.now();
        trackedShellsByPeerAgentId.set(peerRecord.agentId, {
          runId: currentRun.id,
          pipelineId: peerRecord.pipelineId,
          stageId: peerRecord.stageId,
          peerAgentId: peerRecord.agentId,
          callId: liveShell.callId,
          command: liveShell.command,
          cwd: liveShell.cwd,
          lastOutputSnapshot: liveShell.output,
          firstObservedAtMs: nowMs,
          lastOutputChangedAtMs: nowMs,
          snoozedUntilMs,
          lastAlertedAtMs: null,
        });
      }
    }
    ctx.logEvent(currentRun.id, {
      taskId: peerRecord.pipelineId,
      from: `${caller.role}:${caller.agentId.slice(0, 8)}`,
      to: peerRecord.agentId,
      kind: "peer.shell_extended",
      summary: `Extended shell watchdog for ${peerRecord.agentId} by ${extensionSeconds}s`,
      outcome: "delivered",
    });
    return `Extended shell watchdog timer for peer ${peerRecord.agentId} by ${extensionSeconds} seconds.`;
  }

  // Action === "cancel": clear the tracked shell entry, reset the peer's nudge clock, and interrupt its turn with guidance.
  const liveShellBeforeCancel = trackedHeartbeat ?? (await ctx.gateway.activeShellCall(peerRecord.agentId));
  trackedShellsByPeerAgentId.delete(peerRecord.agentId);

  const canceledCommandText = liveShellBeforeCancel?.command ?? "(active shell command)";
  const coordinatorGuidance =
    input.guidance?.trim()
    || "Avoid interactive prompts, watch-mode flags, or un-detached background daemons. Run a non-interactive alternative or add an explicit timeout.";
  const expectedPeerTool = peerRecord.awaitingTool ?? "slp_stage_report";

  const interruptPromptLines = [
    `## Shell Command Canceled by Lead (\`${caller.agentId}\`)`,
    "",
    `- **Canceled Command**: \`${canceledCommandText}\``,
    `- **Coordinator Guidance**: ${coordinatorGuidance}`,
    "",
    `Your previous shell command was interrupted because it stopped producing output. Follow the coordinator guidance above to proceed with another approach, then complete your stage assignment and call \`${expectedPeerTool}\`.`,
  ].join("\n");

  // Refresh awaitingSince and clear nudges before interrupting so the canceled turn's turn_ended event does not fire a missing-tool reminder.
  ctx.store.mutate(currentRun.id, (mutableRun) => {
    const mutablePeer = mutableRun.agents[peerRecord.agentId];
    if (!mutablePeer) return;
    if (!mutablePeer.awaitingTool) mutablePeer.awaitingTool = "slp_stage_report";
    mutablePeer.awaitingSince = new Date().toISOString();
    mutablePeer.nudges = 0;
  });

  // In Paseo, sending a message to a running agent interrupts the active turn/shell and starts a new turn with the prompt.
  await ctx.gateway.prompt(peerRecord.agentId, interruptPromptLines);

  ctx.logEvent(currentRun.id, {
    taskId: peerRecord.pipelineId,
    from: `${caller.role}:${caller.agentId.slice(0, 8)}`,
    to: peerRecord.agentId,
    kind: "peer.shell_canceled",
    summary: `Canceled hung shell on ${peerRecord.agentId} (${canceledCommandText.slice(0, 80)}): ${coordinatorGuidance.slice(0, 120)}`,
    outcome: "delivered",
  });

  return `Canceled running shell on peer ${peerRecord.agentId} and delivered corrective guidance.`;
}
