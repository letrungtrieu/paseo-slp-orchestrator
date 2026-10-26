import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { registerRpcHandlers } from "../server/rpc-handlers";
import {
  abortRunRpc, approveGateRpc, approvePipelineGateRpc, approveMainRpc, dismissArchiveWarningRpc, getRunRpc, listPeerQuestionsRpc, listRunsRpc, restoreRunRpc, resumeTaskRpc, setRunModeRpc, startRunRpc, tailLogRpc, initializeProjectPromptsRpc, initSlpManagerSkillRpc,
} from "../shared/rpc";
import { useFlowFixture } from "./helpers/flow-fixture";
import type { PeerQuestionMetrics, PeerQuestionView } from "../shared/peer-questions";
import { DEFAULT_PIPELINE, TWO_PEER_PIPELINE, approveCurrentStage, askAndAnswer, currentStage, delegateToLead, reportPeer, startedRunWithPipeline, eventually } from "./helpers/flow-steps";

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
    const expectedNames = [listRunsRpc, getRunRpc, startRunRpc, setRunModeRpc, approveGateRpc, approvePipelineGateRpc, resumeTaskRpc, approveMainRpc, abortRunRpc, restoreRunRpc, dismissArchiveWarningRpc, tailLogRpc, initializeProjectPromptsRpc, initSlpManagerSkillRpc, listPeerQuestionsRpc].map((contract) => contract.name).sort();
    expect(rpc.registeredNames()).toEqual(expectedNames);
  });
});

describe("peer question audit RPC", () => {
  it("lists answered exchanges with labels and metrics, and filters by status", async () => {
    const { flow, rpc } = await rpcRun();
    const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
    const stage = currentStage(flow, runId, pipelineId);
    const reviewerId = flow.agentId(runId, "reviewer", stage.id);
    // Peers may only ask their Lead, so the audited exchange runs between the reviewer and the stage Lead.
    const leadId = flow.agentId(runId, "forked_lead", stage.id);
    await askAndAnswer(flow, reviewerId, leadId, "Which retry cap applies?", "3 attempts.");
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Still open?" });

    const audit = await rpc.call<{ questions: PeerQuestionView[]; metrics: PeerQuestionMetrics }>(listPeerQuestionsRpc, { runId, limit: 50 });
    expect(audit.questions).toHaveLength(2);
    expect(audit.questions.find((view) => view.question === "Which retry cap applies?")).toMatchObject({
      status: "answered", answer: "3 attempts.", fromLabel: "reviewer", toLabel: "master_lead/Flow test #1",
    });
    expect(audit.metrics).toMatchObject({ total: 2, answered: 1, pending: 1, answerRate: 1 });

    const pendingOnly = await rpc.call<{ questions: PeerQuestionView[]; metrics: PeerQuestionMetrics }>(listPeerQuestionsRpc, { runId, status: "pending", limit: 50 });
    expect(pendingOnly.questions.map((view) => view.question)).toEqual(["Still open?"]);
    expect(pendingOnly.metrics.total).toBe(1);
  });

  it("answers an unknown run with an empty audit instead of failing", async () => {
    const { rpc } = await rpcRun();
    const audit = await rpc.call<{ questions: PeerQuestionView[]; metrics: PeerQuestionMetrics }>(listPeerQuestionsRpc, { runId: "nope", limit: 5 });
    expect(audit.questions).toEqual([]);
    expect(audit.metrics.total).toBe(0);
  });
});

describe("run RPCs", () => {
  it("initializes the slp-manager skill inside the selected project repository via RPC", async () => {
    const { flow, rpc } = await rpcRun();
    const skillResult = await rpc.call<{ skillName: string; installedPaths: string[] }>(initSlpManagerSkillRpc, { repoPath: flow.repoPath });
    expect(skillResult.skillName).toBe("slp-manager");
    expect(skillResult.installedPaths).toEqual([
      `${flow.repoPath}/.agents/skills/slp-manager/SKILL.md`,
      `${flow.repoPath}/.claude/skills/slp-manager/SKILL.md`,
    ]);
  });

  it("initializes role workflows before starting agents", async () => {
    const { flow, rpc } = await rpcRun();
    const configuration = await rpc.call<{ directory: string; peers: Array<{ role: string }> }>(initializeProjectPromptsRpc, { repoPath: flow.repoPath });
    // Project selection prepares editable files but must not create a run or a pipeline.
    expect(configuration.directory).toBe(`${flow.repoPath}/.slp`);
    expect(configuration.peers.map((peer) => peer.role).sort()).toEqual([
      "architect",
      "developer",
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
      repoPath: flow.repoPath, mode: "SEMI_AUTO", name: "From UI", supervisorProvider: "claude/sonnet", leadProvider: "claude/opus", peerProvider: "codex/gpt",
    });
    // The daemon appends a "#<sequence>" suffix to the submitted name to build the persisted title.
    expect(flow.run(started.runId)).toMatchObject({ title: "From UI #1", mode: "SEMI_AUTO", providers: { lead: "claude/opus", peer: "codex/gpt" } });
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

  it("preserves worktrees when archived via x-button or archiveOnly=true, exposes archiveWarningPending, and restores the run via restoreRunRpc", async () => {
    const { flow, rpc } = await rpcRun();
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const initialPipeline = flow.pipeline(runId, pipelineId)!;
    const initialSupervisorId = flow.run(runId).supervisorAgentId;

    // Simulate accidental x-button click archiving the Supervisor while the pipeline is running.
    await flow.gateway.archive(initialSupervisorId);
    const { handleSupervisorArchived } = await import("../server/pipeline/run-lifecycle");
    await handleSupervisorArchived(flow.ctx, runId);

    const archivedRun = flow.run(runId);
    expect(archivedRun.status).toBe("aborted");
    expect(archivedRun.archivedAt).toBeTruthy();
    expect(archivedRun.archivedFromStatus).toBe("running");
    expect(archivedRun.archiveWarningPending).toBe(true);
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("paused");
    // Owned pipeline worktrees must NOT be archived/deleted when the Supervisor is closed via the x button.
    expect(flow.paseo.archivedWorkspaceIds).not.toContain(initialPipeline.workspaceId);

    // Dismissing the archive warning keeps the run in the archive list for later restoration.
    await rpc.call(dismissArchiveWarningRpc, { runId });
    expect(flow.run(runId).archiveWarningPending).toBe(false);

    // Restoring the run respawns the Supervisor, Lead, and stage Peers and resumes pipeline execution.
    const restoreResult = await rpc.call<{
      ok: boolean;
      runId: string;
      supervisorAgentId: string;
      status: string;
    }>(restoreRunRpc, { runId });
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.status).toBe("running");
    expect(restoreResult.supervisorAgentId).not.toBe(initialSupervisorId);

    const restoredRun = flow.run(runId);
    expect(restoredRun.status).toBe("running");
    expect(restoredRun.archivedAt).toBeNull();
    expect(restoredRun.archiveWarningPending).toBe(false);
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("running");
    expect(flow.pipeline(runId, pipelineId)!.stages[0].status).toBe("running");
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
