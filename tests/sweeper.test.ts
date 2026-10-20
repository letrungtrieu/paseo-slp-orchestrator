import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPeerShellWatchdogState } from "../server/pipeline/shell-watchdog";
import { startSweeper } from "../server/sweeper";
import { DEFAULT_SLP_SETTINGS } from "../shared/settings";
import type { FakePaseoHolder } from "./helpers/fake-paseo";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, delegateToLead, eventually, startedRunWithPipeline } from "./helpers/flow-steps";
import { permissionRequest } from "./helpers/permission-request";

const createFlow = useFlowFixture();
const SWEEP_INTERVAL_MS = 3_000;
let stopSweeper: () => void = () => undefined;

beforeEach(() => {
  // only the interval is faked: git, fs and vi.waitFor must keep running on real timers
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  resetPeerShellWatchdogState();
});

afterEach(() => {
  stopSweeper();
  stopSweeper = () => undefined;
  resetPeerShellWatchdogState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const tick = () => vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

async function sweptRun(withPipeline = false) {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  let runId: string;
  if (withPipeline) {
    runId = (await startedRunWithPipeline(flow, DEFAULT_PIPELINE)).runId;
  } else {
    runId = await flow.startRun();
    // Delegate once so the Master Lead is lazily spawned, then clear initial delegation mail before sweeper assertions.
    await delegateToLead(flow, runId);
    flow.store.mutate(runId, (mutableRun) => {
      mutableRun.status = "delegating";
      mutableRun.mailbox = [];
    });
  }
  // Isolate sweep delivery from the separate bootstrap greeting turn.
  flow.gateway.markEveryAgentIdle();
  flow.gateway.prompts.length = 0;
  stopSweeper = startSweeper(flow.ctx);
  return { flow, runId, masterLeadId: flow.run(runId).masterLeadAgentId };
}

describe("sweeper", () => {
  // the sweeper is the safety net for missed turn_ended events
  it("delivers queued mail to idle agents on every tick", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    flow.ctx.mailbox.enqueue(runId, masterLeadId, "sweep me", { taskId: null, awaitTool: null, from: "t", summary: "s" });
    expect(flow.gateway.prompts).toEqual([]);

    await tick();
    expect(flow.gateway.promptsTo(masterLeadId)).toEqual(["sweep me"]);
  });

  it("answers pending permission requests that the lifecycle event missed", async () => {
    const { flow, masterLeadId } = await sweptRun();
    const missedRequest = permissionRequest({ name: "Read" });
    flow.gateway.setPendingPermissions(masterLeadId, [missedRequest]);

    await tick();
    expect(flow.gateway.permissionResponses).toEqual([{ agentId: masterLeadId, requestId: missedRequest.id, response: { behavior: "allow" } }]);
  });

  // finished runs must not wake agents again
  it("does nothing for completed or aborted runs", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    flow.ctx.mailbox.enqueue(runId, masterLeadId, "late", { taskId: null, awaitTool: null, from: "t", summary: "s" });
    flow.store.mutate(runId, (run) => {
      run.status = "completed";
    });
    await tick();
    expect(flow.gateway.prompts).toEqual([]);
  });

  // after a restart no hook has delivered the SDK handle yet
  it("waits until the SDK handle has been captured", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    const holder = flow.ctx.holder as unknown as FakePaseoHolder;
    holder.ready = false;
    flow.ctx.mailbox.enqueue(runId, masterLeadId, "wait", { taskId: null, awaitTool: null, from: "t", summary: "s" });
    await tick();
    expect(flow.gateway.prompts).toEqual([]);

    holder.ready = true;
    await tick();
    expect(flow.gateway.prompts).toHaveLength(1);
  });

  it("survives a failing sweep and keeps sweeping", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalLiveStatuses = flow.gateway.liveStatuses.bind(flow.gateway);
    flow.gateway.liveStatuses = async () => {
      throw new Error("daemon unreachable");
    };
    await tick();
    expect(errorSpy).toHaveBeenCalled();

    flow.gateway.liveStatuses = originalLiveStatuses;
    flow.ctx.mailbox.enqueue(runId, masterLeadId, "after failure", { taskId: null, awaitTool: null, from: "t", summary: "s" });
    await tick();
    expect(flow.gateway.promptsTo(masterLeadId)).toEqual(["after failure"]);
  });

  // plugin shutdown must stop background work
  it("stops sweeping after the returned disposer is called", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    stopSweeper();
    flow.ctx.mailbox.enqueue(runId, masterLeadId, "never", { taskId: null, awaitTool: null, from: "t", summary: "s" });
    await tick();
    expect(flow.gateway.prompts).toEqual([]);
  });

  it("nudges only the current dynamic stage obligation", async () => {
    const { flow, runId } = await sweptRun(true);
    const pipeline = flow.pipeline(runId)!;
    const peerId = flow.agentId(runId, pipeline.stages[0].peers[0].role, pipeline.stages[0].id);
    flow.store.mutate(runId, (run) => Object.assign(run.agents[peerId], { awaitingTool: "slp_stage_report", awaitingSince: "2020-01-01T00:00:00.000Z", nudges: 0 }));
    await tick();
    expect(flow.gateway.promptsTo(peerId).at(-1)).toContain("slp_stage_report");
  });

  // recovery only applies to runs that already left planning
  it("does not restart a queued pipeline of a run that is not in running state", async () => {
    const { flow, runId } = await sweptRun(true);
    const pipeline = flow.pipeline(runId)!;
    flow.store.mutate(runId, (run) => {
      run.status = "planning";
      run.pipelines[pipeline.id].status = "queued";
      run.pipelines[pipeline.id].stages[0].status = "pending";
    });
    await tick();
    expect(flow.pipeline(runId)!.stages[0].status).toBe("pending");
  });

  // Agents whose turn crashed in Paseo report 'error' status and must still receive queued mail and recovery nudges.
  it("delivers queued mail to an agent in error status so its session can recover", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    flow.gateway.setStatus(masterLeadId, "error");
    flow.ctx.mailbox.enqueue(runId, masterLeadId, "recover from crash", {
      taskId: null,
      awaitTool: "slp_define_pipeline",
      from: "supervisor",
      summary: "recover",
    });

    await tick();
    expect(flow.gateway.promptsTo(masterLeadId)).toEqual(["recover from crash"]);
    expect(flow.run(runId).agents[masterLeadId].awaitingTool).toBe("slp_define_pipeline");
  });

  // When the Master Lead session dies during planning, the sweeper must spawn a replacement and re-queue slp_define_pipeline.
  it("automatically revives a dead Master Lead during planning and restores its slp_define_pipeline obligation", async () => {
    const { flow, runId, masterLeadId } = await sweptRun();
    flow.store.mutate(runId, (run) => {
      run.status = "planning";
      run.criteria = "Implement resilient orchestration with automatic Master Lead revival.";
      run.agents[masterLeadId].awaitingTool = "slp_define_pipeline";
    });
    await flow.gateway.archive(masterLeadId);

    await tick();
    const revivedMasterLeadId = flow.run(runId).masterLeadAgentId;
    expect(revivedMasterLeadId).not.toBe(masterLeadId);
    expect(flow.run(runId).agents[revivedMasterLeadId].awaitingTool).toBe("slp_define_pipeline");
    expect(flow.gateway.promptsTo(revivedMasterLeadId).at(-1)).toContain("slp_define_pipeline");
  });

  // Mid-stage peer revival must only replace and brief the dead peer without resetting healthy peers that already reported.
  it("revives only a dead stage peer without re-briefing healthy peers in the same stage", async () => {
    const { flow, runId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const deadPeerId = firstStage.peerAgentIds[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;
    await flow.gateway.archive(deadPeerId);
    flow.gateway.prompts.length = 0;

    await tick();
    const refreshedStage = flow.pipeline(runId)!.stages[0];
    const replacementPeerId = refreshedStage.peerAgentIds[0];
    expect(replacementPeerId).toBeTruthy();
    expect(replacementPeerId).not.toBe(deadPeerId);
    expect(refreshedStage.forkedLeadAgentId).toBe(coordinatorId);
    expect(flow.gateway.promptsTo(replacementPeerId).at(-1)).toContain("slp_stage_report");
    expect(flow.run(runId).agents[replacementPeerId].awaitingTool).toBe("slp_stage_report");
  });

  // When the Supervisor is archived, the sweeper must retire all dependent Peers, Forked Leads and Master Lead instead of respawning them.
  it("archives all dependent leads and peers and aborts the run when the Supervisor is archived", async () => {
    const { flow, runId, masterLeadId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;
    const peerIds = [...firstStage.peerAgentIds];
    const supervisorId = flow.run(runId).supervisorAgentId;
    await flow.gateway.archive(supervisorId);

    await tick();
    const stoppedRun = flow.run(runId);
    expect(stoppedRun.status).toBe("aborted");
    expect(flow.gateway.archivedAgentIds).toContain(masterLeadId);
    expect(flow.gateway.archivedAgentIds).toContain(coordinatorId);
    for (const peerId of peerIds) {
      expect(flow.gateway.archivedAgentIds).toContain(peerId);
    }
  });

  // When a Lead is archived in Paseo, the sweeper must recursively archive its child stage peers, pause the pipeline, and revive a replacement Lead.
  it("recursively archives child stage peers and pauses the pipeline when a Lead is archived", async () => {
    const { flow, runId, masterLeadId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;
    const stagePeerIds = [...firstStage.peerAgentIds];
    const supervisorId = flow.run(runId).supervisorAgentId;
    await flow.gateway.archive(coordinatorId);

    await tick();
    const updatedRun = flow.run(runId);
    expect(updatedRun.status).toBe("running");
    expect(flow.pipeline(runId)!.status).toBe("paused");
    for (const stagePeerId of stagePeerIds) {
      expect(flow.gateway.archivedAgentIds).toContain(stagePeerId);
      expect(updatedRun.agents[stagePeerId].archivedAt).toBeTruthy();
    }
    expect(updatedRun.agents[masterLeadId].archivedAt).toBeTruthy();
    expect(updatedRun.agents[supervisorId].archivedAt).toBeNull();
  });

  // When a parent Lead is archived during parallel pipelines, the sweeper must recursively archive all child Leads and grandchild Peers.
  it("recursively archives child Leads and grandchild Peers when the parent Lead is archived during a running pipeline", async () => {
    const { flow, runId, masterLeadId } = await sweptRun(true);
    // Define a second parallel pipeline so a sibling Lead child exists under masterLeadId.
    const secondDefineResponse = await flow.callAs(masterLeadId, "slp_define_pipeline", {
      pipeline: {
        name: "secondary-feature",
        version: "1.0",
        description: "Secondary parallel pipeline",
        stages: [{ name: "impl", goal: "Implement secondary feature", peers: [{ role: "developer", task: "Code secondary" }] }],
      },
    });
    expect(secondDefineResponse.isError).toBe(false);
    const secondPipelineId = JSON.parse(secondDefineResponse.text).pipelineId as string;
    await vi.waitFor(() => {
      if (flow.pipeline(runId, secondPipelineId)?.status !== "running") {
        throw new Error("second pipeline still starting");
      }
    });
    const secondPipeline = flow.pipeline(runId, secondPipelineId)!;
    const childLeadId = secondPipeline.leadAgentId!;
    const childStagePeerIds = [...secondPipeline.stages[0].peerAgentIds];
    const supervisorId = flow.run(runId).supervisorAgentId;
    await flow.gateway.archive(masterLeadId);

    await tick();
    const updatedRun = flow.run(runId);
    expect(updatedRun.status).toBe("running");
    expect(flow.pipeline(runId, secondPipelineId)!.status).toBe("paused");
    for (const stagePeerId of childStagePeerIds) {
      expect(flow.gateway.archivedAgentIds).toContain(stagePeerId);
      expect(updatedRun.agents[stagePeerId].archivedAt).toBeTruthy();
      // Leaf peers must be archived before their parent child Lead coordinator.
      expect(flow.gateway.archivedAgentIds.indexOf(stagePeerId)).toBeLessThan(
        flow.gateway.archivedAgentIds.indexOf(childLeadId),
      );
    }
    expect(flow.gateway.archivedAgentIds).toContain(childLeadId);
    expect(updatedRun.agents[childLeadId].archivedAt).toBeTruthy();
    expect(updatedRun.agents[supervisorId].archivedAt).toBeNull();
  });

  // Changing stdout/stderr resets the heartbeat clock; only when output stalls past idleTimeoutSeconds does the watchdog wake Forked Lead.
  it("resets the shell heartbeat while stdout changes and alerts Forked Lead only after output stalls past idleTimeoutSeconds", async () => {
    const { flow, runId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const runningPeerId = firstStage.peerAgentIds[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;

    flow.ctx.getSettings = () => ({
      ...DEFAULT_SLP_SETTINGS,
      shellWatchdog: { enabled: true, idleTimeoutSeconds: 60 },
    });
    flow.gateway.setStatus(runningPeerId, "running");

    let simulatedTimeMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => simulatedTimeMs);

    // First sweep observes the shell command starting.
    flow.gateway.setActiveShellCall(runningPeerId, {
      callId: "shell-watch-1",
      command: "npm test -- --watch",
      cwd: activePipeline.worktree,
      output: "PASS tests/unit.test.ts\nWaiting for file changes...",
      startedAt: new Date(simulatedTimeMs).toISOString(),
    });
    await tick();
    expect(flow.gateway.promptsTo(coordinatorId)).toEqual([]);

    // 45s later: new stdout appears, which must reset the idle timer so another 45s does not trigger an alert.
    simulatedTimeMs += 45_000;
    flow.gateway.setActiveShellCall(runningPeerId, {
      callId: "shell-watch-1",
      command: "npm test -- --watch",
      cwd: activePipeline.worktree,
      output: "PASS tests/unit.test.ts\nPASS tests/integration.test.ts\nWaiting for file changes...",
      startedAt: new Date(1_000_000).toISOString(),
    });
    await tick();
    expect(flow.gateway.promptsTo(coordinatorId)).toEqual([]);

    // 45s after the last output change (90s total elapsed, 45s unchanged < 60s threshold): still no alert.
    simulatedTimeMs += 45_000;
    await tick();
    expect(flow.gateway.promptsTo(coordinatorId)).toEqual([]);

    // 20s later (65s unchanged >= 60s threshold): Forked Lead receives the watchdog alert with command and output tail.
    simulatedTimeMs += 20_000;
    await tick();
    const coordinatorPrompts = flow.gateway.promptsTo(coordinatorId);
    expect(coordinatorPrompts).toHaveLength(1);
    expect(coordinatorPrompts[0]).toContain("Shell Watchdog Alert");
    expect(coordinatorPrompts[0]).toContain("npm test -- --watch");
    expect(coordinatorPrompts[0]).toContain("Waiting for file changes...");
    expect(coordinatorPrompts[0]).toContain("slp_handle_peer_shell");
  });

  // Forked Lead can either extend the timer for legitimate heavy builds (action: "wait") or interrupt a hung shell with guidance (action: "cancel").
  it("allows Forked Lead to snooze legitimate long-running shells with action=wait or interrupt hung shells with action=cancel", async () => {
    const { flow, runId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const runningPeerId = firstStage.peerAgentIds[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;

    flow.ctx.getSettings = () => ({
      ...DEFAULT_SLP_SETTINGS,
      shellWatchdog: { enabled: true, idleTimeoutSeconds: 30 },
    });
    flow.gateway.setStatus(runningPeerId, "running");

    let simulatedTimeMs = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => simulatedTimeMs);

    flow.gateway.setActiveShellCall(runningPeerId, {
      callId: "shell-hang-1",
      command: "npx prisma migrate dev",
      cwd: activePipeline.worktree,
      output: "Enter a name for the new migration:",
      startedAt: new Date(simulatedTimeMs).toISOString(),
    });
    await tick();

    // Advance past the 30s idle threshold so the initial alert is delivered to Forked Lead.
    simulatedTimeMs += 35_000;
    await tick();
    expect(flow.gateway.promptsTo(coordinatorId)).toHaveLength(1);

    // Forked Lead first extends the watchdog by 120s via slp_handle_peer_shell(action: "wait").
    await flow.callAs(coordinatorId, "slp_handle_peer_shell", {
      peerAgentId: runningPeerId,
      action: "wait",
      waitSeconds: 120,
    });

    // 60s later (still inside the 120s snooze window): no second alert is sent.
    simulatedTimeMs += 60_000;
    await tick();
    expect(flow.gateway.promptsTo(coordinatorId)).toHaveLength(1);

    // Forked Lead then decides to cancel the interactive shell and provide non-interactive guidance.
    flow.gateway.prompts.length = 0;
    await flow.callAs(coordinatorId, "slp_handle_peer_shell", {
      peerAgentId: runningPeerId,
      action: "cancel",
      guidance: "Pass --name init --skip-generate so Prisma does not block on interactive stdin.",
    });

    const peerInterruptPrompts = flow.gateway.promptsTo(runningPeerId);
    expect(peerInterruptPrompts).toHaveLength(1);
    expect(peerInterruptPrompts[0]).toContain("Shell Command Canceled by Lead");
    expect(peerInterruptPrompts[0]).toContain("npx prisma migrate dev");
    expect(peerInterruptPrompts[0]).toContain("--name init --skip-generate");
    expect(flow.run(runId).agents[runningPeerId].awaitingTool).toBe("slp_stage_report");
    expect(flow.run(runId).agents[runningPeerId].nudges).toBe(0);
    expect(flow.store.tailLog(runId, 50).some((logEntry) => logEntry.kind === "peer.shell_canceled")).toBe(true);
  });

  // Disabling shellWatchdog in SLP settings suppresses all shell heartbeat checks and alerts.
  it("does not alert when shellWatchdog.enabled is false in SLP settings", async () => {
    const { flow, runId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const runningPeerId = firstStage.peerAgentIds[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;

    flow.ctx.getSettings = () => ({
      ...DEFAULT_SLP_SETTINGS,
      shellWatchdog: { enabled: false, idleTimeoutSeconds: 30 },
    });
    flow.gateway.setStatus(runningPeerId, "running");

    let simulatedTimeMs = 3_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => simulatedTimeMs);

    flow.gateway.setActiveShellCall(runningPeerId, {
      callId: "shell-disabled-1",
      command: "tail -f app.log",
      cwd: activePipeline.worktree,
      output: "listening...",
      startedAt: new Date(simulatedTimeMs).toISOString(),
    });
    await tick();
    simulatedTimeMs += 120_000;
    await tick();
    expect(flow.gateway.promptsTo(coordinatorId)).toEqual([]);
  });
});

