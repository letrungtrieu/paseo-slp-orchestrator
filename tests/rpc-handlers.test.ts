import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { registerRpcHandlers } from "../server/rpc-handlers";
import {
  abortRunRpc, approveGateRpc, approvePipelineGateRpc, approveMainRpc, getRunRpc, listRunsRpc, resumeTaskRpc, setRunModeRpc, startRunRpc, tailLogRpc, initializeProjectPromptsRpc,
} from "../shared/rpc";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, approveCurrentStage, delegateToLead, reportPeer, startedRunWithPipeline, eventually } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

function fakeRpcServer() {
  const handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>();
  const server = {
    handle: (rpc: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => { handlers.set(rpc.name, handler); },
  } as unknown as PluginServerContext;
  const paseoFromRequest = { marker: "paseo-from-rpc" };
  const call = async <Output>(rpc: { name: string }, input: unknown): Promise<Output> => (await handlers.get(rpc.name)!(input, { paseo: paseoFromRequest })) as Output;
  return { server, call, paseoFromRequest, registeredNames: () => [...handlers.keys()].sort() };
}

async function rpcRun(mode: "FULL_AUTO" | "STEP_BY_STEP_DEBUG" = "FULL_AUTO") {
  const flow = await createFlow({ mode });
  const rpc = fakeRpcServer();
  registerRpcHandlers(rpc.server, flow.ctx);
  return { flow, rpc };
}

describe("RPC registration", () => {
  it("registers one handler per shared RPC contract", async () => {
    const { rpc } = await rpcRun();
    const expectedNames = [listRunsRpc, getRunRpc, startRunRpc, setRunModeRpc, approveGateRpc, approvePipelineGateRpc, resumeTaskRpc, approveMainRpc, abortRunRpc, tailLogRpc, initializeProjectPromptsRpc].map((contract) => contract.name).sort();
    expect(rpc.registeredNames()).toEqual(expectedNames);
  });
});

describe("run RPCs", () => {
  it("initializes role workflows before starting agents", async () => {
    const { flow, rpc } = await rpcRun();
    const configuration = await rpc.call<{ directory: string; peers: Array<{ role: string }> }>(initializeProjectPromptsRpc, { repoPath: flow.repoPath });
    // Project selection prepares editable files but must not create a run or a pipeline.
    expect(configuration.directory).toBe(`${flow.repoPath}/.slp`);
    expect(configuration.peers.map((peer) => peer.role).sort()).toEqual([
      "developer",
      "end-user",
      "qa-engineer",
      "reviewer",
      "security-reviewer",
    ]);
    expect(flow.store.list()).toHaveLength(0);
    expect(flow.gateway.createdAgents).toHaveLength(0);
  });

  it("starts a run from the UI request and captures the SDK handle", async () => {
    const { flow, rpc } = await rpcRun();
    const started = await rpc.call<{ runId: string }>(startRunRpc, {
      repoPath: flow.repoPath, mode: "SEMI_AUTO", title: "From UI", supervisorProvider: "claude/sonnet", leadProvider: "claude/opus", peerProvider: "codex/gpt",
    });
    expect(flow.run(started.runId)).toMatchObject({ title: "From UI", mode: "SEMI_AUTO", providers: { lead: "claude/opus", peer: "codex/gpt" } });
    expect((flow.ctx.holder as unknown as { captures: unknown[] }).captures).toContain(rpc.paseoFromRequest);
  });

  it("lists dynamic pipelines newest first", async () => {
    const { flow, rpc } = await rpcRun();
    const olderRunId = await flow.startRun();
    const newerStory = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    // RunStore.mutate() always stamps updatedAt with the current clock, so age the older run on the live record.
    flow.run(olderRunId).updatedAt = "2000-01-01T00:00:00.000Z";
    const { runs } = await rpc.call<{ runs: Array<Record<string, unknown>> }>(listRunsRpc, {});
    expect(runs.map((run) => run.id)).toEqual([newerStory.runId, olderRunId]);
    expect(runs[0]).toMatchObject({ taskCount: 1, mergedTaskCount: 0, openGateCount: 0, status: "running" });
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

  it("tails the SQLite comm log of a run", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    await eventually(() => {
      const entries = flow.store.tailLog(runId, 50);
      if (!entries.some((entry) => entry.kind === "run.started")) throw new Error("run.started not logged yet");
    });
    expect(await rpc.call(tailLogRpc, { runId: "nope", limit: 5 })).toEqual({ entries: [] });
  });
});

describe("dynamic pipeline gate RPCs", () => {
  it("approves the declared stage gate and schedules the next stage", async () => {
    const { flow, rpc } = await rpcRun("STEP_BY_STEP_DEBUG");
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const stage = flow.pipeline(runId, pipelineId)!.stages[0];
    for (const assignment of stage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);
    const approval = await rpc.call<{ ok: boolean; message: string }>(approvePipelineGateRpc, { runId, pipelineId });
    expect(approval).toMatchObject({ ok: true });
    expect(flow.pipeline(runId, pipelineId)!.gate).toBeNull();
  });

  it("rejects the retired task resume RPC for a dynamic run", async () => {
    const { flow, rpc } = await rpcRun();
    const runId = await flow.startRun();
    await expect(rpc.call(resumeTaskRpc, { runId, taskId: "retired", guidance: "continue" })).rejects.toThrow(/retired task engine/);
  });
});
