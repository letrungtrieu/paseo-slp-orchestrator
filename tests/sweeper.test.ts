import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSweeper } from "../server/sweeper";
import type { FakePaseoHolder } from "./helpers/fake-paseo";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, eventually, startedRunWithPipeline } from "./helpers/flow-steps";
import { permissionRequest } from "./helpers/permission-request";

const createFlow = useFlowFixture();
const SWEEP_INTERVAL_MS = 3_000;
let stopSweeper: () => void = () => undefined;

beforeEach(() => {
  // only the interval is faked: git, fs and vi.waitFor must keep running on real timers
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  stopSweeper();
  stopSweeper = () => undefined;
  vi.useRealTimers();
});

const tick = () => vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

async function sweptRun(withPipeline = false) {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = withPipeline ? (await startedRunWithPipeline(flow, DEFAULT_PIPELINE)).runId : await flow.startRun();
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

  // When a stage Forked Lead is archived in Paseo, the sweeper must recursively archive its child stage peers.
  it("recursively archives child stage peers and pauses the pipeline when a Forked Lead is archived", async () => {
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
    expect(updatedRun.agents[masterLeadId].archivedAt).toBeNull();
    expect(updatedRun.agents[supervisorId].archivedAt).toBeNull();
  });

  // When the Master Lead is archived during an active pipeline, the sweeper must recursively archive all child Forked Leads and grandchild Peers.
  it("recursively archives child Forked Leads and grandchild Peers when the Master Lead is archived during a running pipeline", async () => {
    const { flow, runId, masterLeadId } = await sweptRun(true);
    const activePipeline = flow.pipeline(runId)!;
    const firstStage = activePipeline.stages[0];
    const coordinatorId = firstStage.forkedLeadAgentId!;
    const stagePeerIds = [...firstStage.peerAgentIds];
    const supervisorId = flow.run(runId).supervisorAgentId;
    await flow.gateway.archive(masterLeadId);

    await tick();
    const updatedRun = flow.run(runId);
    expect(updatedRun.status).toBe("running");
    expect(flow.pipeline(runId)!.status).toBe("paused");
    for (const stagePeerId of stagePeerIds) {
      expect(flow.gateway.archivedAgentIds).toContain(stagePeerId);
      expect(updatedRun.agents[stagePeerId].archivedAt).toBeTruthy();
      // Leaf peers must be archived before their parent stage Forked Lead coordinator.
      expect(flow.gateway.archivedAgentIds.indexOf(stagePeerId)).toBeLessThan(
        flow.gateway.archivedAgentIds.indexOf(coordinatorId),
      );
    }
    expect(flow.gateway.archivedAgentIds).toContain(coordinatorId);
    expect(updatedRun.agents[coordinatorId].archivedAt).toBeTruthy();
    expect(updatedRun.agents[supervisorId].archivedAt).toBeNull();
  });
});
