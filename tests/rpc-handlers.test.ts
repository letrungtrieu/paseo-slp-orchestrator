import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { registerRpcHandlers } from "../server/rpc-handlers";
import {
  abortRunRpc, approveGateRpc, approveMainRpc, getRunRpc, listRunsRpc, resumeTaskRpc, setRunModeRpc, startRunRpc, tailLogRpc, initializeProjectPromptsRpc,
} from "../shared/rpc";
import { useFlowFixture } from "./helpers/flow-fixture";
import { API_TASK, approveHandshake, eventually, startedRunWithTasks } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

// Captures handlers by RPC name so tests call them like the daemon would.
function fakeRpcServer() {
  const handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>();
  const server = {
    handle: (rpc: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => {
      handlers.set(rpc.name, handler);
    },
  } as unknown as PluginServerContext;
  const paseoFromRequest = { marker: "paseo-from-rpc" };
  const call = async <Output>(rpc: { name: string }, input: unknown): Promise<Output> =>
    (await handlers.get(rpc.name)!(input, { paseo: paseoFromRequest })) as Output;
  return { server, call, paseoFromRequest, registeredNames: () => [...handlers.keys()].sort() };
}

async function rpcRun(mode: "FULL_AUTO" | "STEP_BY_STEP_DEBUG" = "FULL_AUTO") {
  const flow = await createFlow({ mode });
  const rpc = fakeRpcServer();
  registerRpcHandlers(rpc.server, flow.ctx);
  return { flow, rpc };
}

describe("RPC registration", () => {
  // a contract without a handler would hang the UI call
  it("registers one handler per contract in shared/rpc.ts", async () => {
    const { rpc } = await rpcRun();
    const expectedNames = [listRunsRpc, getRunRpc, startRunRpc, setRunModeRpc, approveGateRpc, resumeTaskRpc, approveMainRpc, abortRunRpc, tailLogRpc, initializeProjectPromptsRpc].map((contract) => contract.name).sort();
    expect(rpc.registeredNames()).toEqual(expectedNames);
  });
});

describe("run RPCs", () => {
  it("initializes role workflows before starting agents", async () => {
    const { flow, rpc } = await rpcRun();
    const configuration = await rpc.call<{ directory: string; peers: Array<{ role: string }> }>(initializeProjectPromptsRpc, { repoPath: flow.repoPath });
    // Project selection prepares editing files but must not create a run or an agent.
    expect(configuration.directory).toBe(`${flow.repoPath}/.slp`);
    expect(configuration.peers).toHaveLength(4);
    expect(flow.store.list()).toHaveLength(0);
    expect(flow.gateway.createdAgents).toHaveLength(0);
  });
  it("starts a run from the UI request and captures the SDK handle", async () => {
    const { flow, rpc } = await rpcRun();
    const started = await rpc.call<{ runId: string }>(startRunRpc, {
      repoPath: flow.repoPath, mode: "SEMI_AUTO", title: "From UI", leadProvider: "claude/opus", peerProvider: "codex/gpt",
    });

    expect(flow.run(started.runId)).toMatchObject({ title: "From UI", mode: "SEMI_AUTO", providers: { lead: "claude/opus", peer: "codex/gpt" } });
    expect((flow.ctx.holder as unknown as { captures: unknown[] }).captures).toContain(rpc.paseoFromRequest);
  });

  it("lists runs newest first with task and gate counts", async () => {
    const { flow, rpc } = await rpcRun("STEP_BY_STEP_DEBUG");
    const olderRunId = await flow.startRun();
    const newerRunId = await startedRunWithTasks(flow, [API_TASK]);
    await approveHandshake(flow, newerRunId, API_TASK.id);
    // mutate() re-stamps updatedAt, so the timestamp is set on the stored object directly
    flow.run(olderRunId).updatedAt = "2000-01-01T00:00:00.000Z";

    const { runs } = await rpc.call<{ runs: Array<Record<string, unknown>> }>(listRunsRpc, {});
    expect(runs.map((run) => run.id)).toEqual([newerRunId, olderRunId]);
    expect(runs[0]).toMatchObject({ taskCount: 1, mergedTaskCount: 0, openGateCount: 1, status: "running" });
  });

  it("returns a run by id, or null when unknown", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    expect((await rpc.call<{ run: { id: string } }>(getRunRpc, { runId })).run.id).toBe(runId);
    expect(await rpc.call(getRunRpc, { runId: "nope" })).toEqual({ run: null });
  });

  it("changes the mode of a live run", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    expect(await rpc.call(setRunModeRpc, { runId, mode: "SEMI_AUTO" })).toEqual({ ok: true });
    expect(flow.run(runId).mode).toBe("SEMI_AUTO");
  });

  // the client only displays thrown errors, not ok:false payloads
  it("surfaces failures by throwing so the UI can show them", async () => {
    const { rpc } = await rpcRun();
    await expect(rpc.call(setRunModeRpc, { runId: "nope", mode: "SEMI_AUTO" })).rejects.toThrow(/Unknown SLP run/);
    await expect(rpc.call(approveMainRpc, { runId: "nope" })).rejects.toThrow(/Unknown SLP run/);
  });

  it("aborts a run", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    await rpc.call(abortRunRpc, { runId });
    expect(flow.run(runId).status).toBe("aborted");
  });

  it("tails the comm log of a run and returns nothing for an unknown run", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    await eventually(async () => {
      const { entries } = await rpc.call<{ entries: Array<{ kind: string }> }>(tailLogRpc, { runId, limit: 50 });
      if (!entries.some((entry) => entry.kind === "run.started")) throw new Error("run.started not logged yet");
    });
    expect(await rpc.call(tailLogRpc, { runId: "nope", limit: 5 })).toEqual({ entries: [] });
  });
});

describe("gate and task RPCs", () => {
  it("approves a task gate and resumes the waiting step", async () => {
    const { flow, rpc } = await rpcRun("STEP_BY_STEP_DEBUG");
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    await approveHandshake(flow, runId, API_TASK.id);

    const approval = await rpc.call<{ ok: boolean; message: string }>(approveGateRpc, { runId, taskId: API_TASK.id });
    expect(approval).toEqual({ ok: true, message: "Gate after_handshake approved" });
    expect(flow.task(runId, API_TASK.id).phase).toBe("implementing");
  });

  // whitespace-only guidance must not produce an empty 'Master Lead decided' block
  it("resumes a paused task, trimming blank guidance to none", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    await flow.callAsRole(runId, "implementer", API_TASK.id, "slp_escalate", { reason: "stuck" });

    const resumption = await rpc.call(resumeTaskRpc, { runId, taskId: API_TASK.id, guidance: "   " });
    expect(resumption).toEqual({ ok: true, message: `Task ${API_TASK.id} resumed` });
    expect(flow.task(runId, API_TASK.id).phase).toBe("handshaking");
    const resumeMail = flow.mailTo(runId, flow.task(runId, API_TASK.id).agentIds.implementer).at(-1)!;
    expect(resumeMail.text).not.toContain("The Master Lead decided");
  });

  it("rejects resuming a task that is not paused", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    await expect(rpc.call(resumeTaskRpc, { runId, taskId: API_TASK.id })).rejects.toThrow(/not paused/);
  });

  // the merge button must be inert until the supervisor presented the result
  it("rejects approving the base-branch merge before the supervisor presented", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    await expect(rpc.call(approveMainRpc, { runId })).rejects.toThrow(/not awaiting approval/);
  });
});
