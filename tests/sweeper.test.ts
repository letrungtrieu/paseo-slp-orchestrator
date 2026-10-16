import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSweeper } from "../server/sweeper";
import { registerTasks } from "../server/pipeline/task-start";
import { TaskDefinitionSchema } from "../shared/state";
import type { FakePaseoHolder } from "./helpers/fake-paseo";
import { useFlowFixture } from "./helpers/flow-fixture";
import { API_TASK, eventually } from "./helpers/flow-steps";
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

async function sweptRun() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await flow.startRun();
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

  it("restarts tasks left in 'queued' after a plugin restart", async () => {
    const { flow, runId } = await sweptRun();
    // emulate the crash window: tasks registered, but the detached startQueuedTasks never ran
    registerTasks(flow.ctx, runId, [TaskDefinitionSchema.parse(API_TASK)]);
    expect(flow.task(runId, API_TASK.id).phase).toBe("queued");

    await tick();
    await eventually(() => expect(flow.task(runId, API_TASK.id).phase).toBe("handshaking"));
    expect(flow.gateway.createdAgentsOfRole("implementer")).toHaveLength(1);
  });

  // recovery only applies to runs that already left planning
  it("does not restart queued tasks of a run that is not in 'running' state", async () => {
    const { flow, runId } = await sweptRun();
    registerTasks(flow.ctx, runId, [TaskDefinitionSchema.parse(API_TASK)]);
    flow.store.mutate(runId, (run) => {
      run.status = "planning";
    });
    await tick();
    expect(flow.task(runId, API_TASK.id).phase).toBe("queued");
  });
});
