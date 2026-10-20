import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLifecycleHooks } from "../server/hooks/lifecycle-hooks";
import type { AgentLiveStatus, AgentGateway } from "../server/runtime/agent-gateway";
import type { PaseoHolder } from "../server/runtime/paseo-holder";
import { NUDGE_LIMIT } from "../shared/roles";
import { PipelineStateSchema } from "../shared/pipeline";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun } from "./helpers/run-factory";
import { fileWriteRequest, permissionRequest } from "./helpers/permission-request";

type HookHandler = (event: any, hookContext: { paseo: unknown }) => unknown;
const openedStores: RunStore[] = [];
let contextSequence = 0;
afterEach(() => { for (const store of openedStores.splice(0)) store.close(); });

function fakeServer() {
  const handlers = new Map<string, HookHandler>();
  const beforeHandlers = new Map<string, HookHandler>();
  const removedEvents: string[] = [];
  const removedBeforeHooks: string[] = [];
  const server = {
    on: (eventName: string, handler: HookHandler) => {
      handlers.set(eventName, handler);
      return () => removedEvents.push(eventName);
    },
    before: (hookName: string, handler: HookHandler) => {
      beforeHandlers.set(hookName, handler);
      return () => removedBeforeHooks.push(hookName);
    },
  } as unknown as PluginServerContext;
  const hookContext = { paseo: { marker: "paseo-from-hook" } };
  return {
    server, removedEvents, removedBeforeHooks, hookContext,
    fire: async (eventName: string, event: unknown) => await handlers.get(eventName)!(event, hookContext),
    fireBefore: async (hookName: string, request: unknown) =>
      await beforeHandlers.get(hookName)!({ request }, hookContext),
  };
}

function dynamicHookContext() {
  const sequence = contextSequence += 1;
  const runId = `run-hooks-${sequence}`;
  const pipeline = PipelineStateSchema.parse({
    id: `pipeline-${sequence}`, name: "ingestion", version: "1.0", worktree: "/tmp/pipeline-worktree", description: "Ingestion",
    stages: [{ id: `stage-${sequence}`, name: "coding", goal: "Implement ingestion", peers: [{ role: "developer", task: "Code" }],
      status: "running", forkedLeadAgentId: `stage-lead-${sequence}`, peerAgentIds: [`peer-${sequence}`], reports: [], messages: [],
      result: null, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null }],
    status: "running", currentStageIndex: 0, workspaceId: `workspace-${sequence}`, branch: "slp/ingestion", baseCommit: "abc",
    pausedReason: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    finalReport: null, gate: null, mergedCommit: null, integratedAt: null,
  });
  const peerId = `peer-${sequence}`;
  const stageLeadId = `stage-lead-${sequence}`;
  const masterLeadId = `master-lead-${sequence}`;
  const supervisorId = `supervisor-${sequence}`;
  const store = new RunStore(":memory:");
  openedStores.push(store);
  store.insert(buildRun({ id: runId, status: "running", supervisorAgentId: supervisorId, masterLeadAgentId: masterLeadId, pipelines: { [pipeline.id]: pipeline }, agents: {
    [supervisorId]: buildAgentRecord({ agentId: supervisorId, role: "supervisor", taskId: null }),
    [masterLeadId]: buildAgentRecord({ agentId: masterLeadId, role: "master_lead", taskId: null }),
    // Give the peer a bounded scope so out-of-scope write requests can be verified against it.
    [peerId]: buildAgentRecord({ agentId: peerId, role: "peer", projectRole: "developer", writeScope: ["src/**"], pipelineId: pipeline.id, stageId: pipeline.stages[0].id, stagePeerId: "0", taskId: null }),
    [stageLeadId]: buildAgentRecord({ agentId: stageLeadId, role: "master_lead", parentAgentId: masterLeadId, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, taskId: null }),
  } }));
  const queuedMessages: Array<{ toAgentId: string; text: string; awaitTool: string | null }> = [];
  const permissionResponses: Array<{ agentId: string; requestId: string; response: unknown }> = [];
  const archivedAgentIds: string[] = [];
  const liveStatuses = new Map<string, AgentLiveStatus>([
    [peerId, { agentId: peerId, status: "idle", pendingPermissions: [], archived: false }],
    [stageLeadId, { agentId: stageLeadId, status: "idle", pendingPermissions: [], archived: false }],
  ]);
  const fakeGateway = {
    archive: async (agentId: string) => {
      archivedAgentIds.push(agentId);
      store.mutate(runId, (mutableRun) => {
        if (mutableRun.agents[agentId]) mutableRun.agents[agentId].archivedAt = "2026-01-01T00:01:00.000Z";
      });
    },
    busEndpointForToken: async (agentToken: string) => `http://127.0.0.1:43123/mcp/${agentToken}`,
    liveStatuses: async () => liveStatuses,
    respondToPermission: async (agentId: string, requestId: string, response: unknown) => { permissionResponses.push({ agentId, requestId, response }); },
  } as unknown as AgentGateway;
  const capturedHandles: unknown[] = [];
  const holder = { capture: (paseo: unknown) => capturedHandles.push(paseo) } as unknown as PaseoHolder;
  const logs: Array<Record<string, unknown>> = [];
  const ctx = {
    store, gateway: fakeGateway, holder,
    mailbox: { enqueue: (_runId: string, toAgentId: string, text: string, options: { awaitTool: string | null }) => queuedMessages.push({ toAgentId, text, awaitTool: options.awaitTool }) },
    forks: {}, continuations: {},
    logEvent: (_runId: string, entry: Record<string, unknown>) => logs.push(entry),
  };
  return { ctx, store, runId, pipelineId: pipeline.id, supervisorId, masterLeadId, peerId, stageLeadId, archivedAgentIds, queuedMessages, permissionResponses, capturedHandles, logs };
}

describe("hook registration", () => {
  it("subscribes to lifecycle events and removes them all", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    const unregister = registerLifecycleHooks(hooks.server, fixture.ctx as never);
    await hooks.fire("agent.turn_started", { agent: { id: "unknown" } });
    unregister();
    expect(hooks.removedEvents.sort()).toEqual(["agent.archived", "agent.permission_requested", "agent.turn_ended", "agent.turn_started"]);
    expect(hooks.removedBeforeHooks).toEqual(["agent.session_open"]);
    expect(fixture.capturedHandles).toHaveLength(1);
  });

  // Archiving the Supervisor in Paseo must immediately archive all dependent Peers, Forked Leads and Master Lead.
  it("cascades Supervisor agent.archived to archive all dependent peers and leads in bottom-up order", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    await hooks.fire("agent.archived", {
      agent: { id: fixture.supervisorId },
      archivedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(fixture.archivedAgentIds).toEqual([fixture.peerId, fixture.stageLeadId, fixture.masterLeadId]);
    const abortedRun = fixture.store.require(fixture.runId);
    expect(abortedRun.status).toBe("aborted");
    expect(abortedRun.agents[fixture.supervisorId].archivedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(abortedRun.agents[fixture.peerId].archivedAt).toBeTruthy();
    expect(abortedRun.agents[fixture.stageLeadId].archivedAt).toBeTruthy();
    expect(abortedRun.agents[fixture.masterLeadId].archivedAt).toBeTruthy();
    expect(fixture.logs.some((entry) => entry.kind === "supervisor.archived")).toBe(true);
  });

  // Archiving a stage Forked Lead must recursively archive all of its child stage peers across worktrees.
  it("cascades Forked Lead agent.archived to recursively archive its child stage peers and pause the stage pipeline", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    await hooks.fire("agent.archived", {
      agent: { id: fixture.stageLeadId },
      archivedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(fixture.archivedAgentIds).toEqual([fixture.peerId]);
    const updatedRun = fixture.store.require(fixture.runId);
    expect(updatedRun.status).toBe("running");
    expect(updatedRun.pipelines[fixture.pipelineId].status).toBe("paused");
    expect(updatedRun.agents[fixture.stageLeadId].archivedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(updatedRun.agents[fixture.peerId].archivedAt).toBeTruthy();
    expect(updatedRun.agents[fixture.masterLeadId].archivedAt).toBeNull();
    expect(updatedRun.agents[fixture.supervisorId].archivedAt).toBeNull();
    expect(fixture.logs.some((entry) => entry.kind === "master_lead.archived")).toBe(true);
  });

  // Archiving the Master Lead must recursively archive child Forked Leads and grandchild Peers in bottom-up order.
  it("cascades Master Lead agent.archived to recursively archive child Forked Leads and grandchild Peers", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    await hooks.fire("agent.archived", {
      agent: { id: fixture.masterLeadId },
      archivedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(fixture.archivedAgentIds).toEqual([fixture.peerId, fixture.stageLeadId]);
    const updatedRun = fixture.store.require(fixture.runId);
    expect(updatedRun.status).toBe("running");
    expect(updatedRun.pipelines[fixture.pipelineId].status).toBe("paused");
    expect(updatedRun.agents[fixture.masterLeadId].archivedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(updatedRun.agents[fixture.stageLeadId].archivedAt).toBeTruthy();
    expect(updatedRun.agents[fixture.peerId].archivedAt).toBeTruthy();
    expect(updatedRun.agents[fixture.supervisorId].archivedAt).toBeNull();
    expect(fixture.logs.some((entry) => entry.kind === "master_lead.archived")).toBe(true);
  });

  // Antigravity stdio MCP bridge processes inherit the agent's launch env to authenticate to slp-bus.
  it("injects the SLP agent token and bus URL into agent.session_open for run agents only", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    const peerRecord = fixture.store.require(fixture.runId).agents[fixture.peerId];
    const transformedSessionRequest = await hooks.fireBefore("agent.session_open", {
      agentId: fixture.peerId,
      workspaceId: "ws-1",
      provider: "antigravity",
      cwd: "/tmp/pipeline-worktree",
      reason: "create",
      purpose: "interactive",
      env: { PASEO_AGENT_ID: fixture.peerId },
    }) as { env: Record<string, string> };
    expect(transformedSessionRequest.env).toMatchObject({
      PASEO_AGENT_ID: fixture.peerId,
      SLP_AGENT_ID: fixture.peerId,
      SLP_AGENT_TOKEN: peerRecord.token,
      SLP_BUS_URL: `http://127.0.0.1:43123/mcp/${peerRecord.token}`,
    });
    const nonSlpResult = await hooks.fireBefore("agent.session_open", {
      agentId: "external-agent",
      workspaceId: "ws-1",
      provider: "antigravity",
      cwd: "/tmp/other",
      reason: "create",
      purpose: "interactive",
      env: { PASEO_AGENT_ID: "external-agent" },
    });
    expect(nonSlpResult).toBeUndefined();
  });
});

describe("dynamic stage nudging", () => {
  it("enqueues a reminder naming the current stage tool", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    fixture.store.mutate(fixture.runId, (run) => Object.assign(run.agents[fixture.peerId], { awaitingTool: "slp_stage_report", awaitingSince: "2020-01-01T00:00:00.000Z", nudges: 0 }));
    await hooks.fire("agent.turn_started", { agent: { id: fixture.peerId } });
    await hooks.fire("agent.turn_ended", { agent: { id: fixture.peerId }, outcome: { kind: "completed" } });
    expect(fixture.queuedMessages[0]).toMatchObject({ toAgentId: fixture.peerId, awaitTool: "slp_stage_report" });
    expect(fixture.queuedMessages[0].text).toContain("without the expected workflow tool slp_stage_report");
    expect(fixture.store.require(fixture.runId).agents[fixture.peerId].nudges).toBe(1);
  });

  it(`pauses the pipeline after ${NUDGE_LIMIT} reminders`, async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    fixture.store.mutate(fixture.runId, (run) => Object.assign(run.agents[fixture.peerId], { awaitingTool: "slp_stage_report", awaitingSince: "2020-01-01T00:00:00.000Z", nudges: 0 }));
    for (let attempt = 0; attempt <= NUDGE_LIMIT; attempt += 1) {
      await hooks.fire("agent.turn_started", { agent: { id: fixture.peerId } });
      await hooks.fire("agent.turn_ended", { agent: { id: fixture.peerId }, outcome: { kind: "completed" } });
    }
    expect(fixture.store.require(fixture.runId).pipelines[fixture.pipelineId].status).toBe("paused");
    expect(fixture.store.require(fixture.runId).agents[fixture.peerId].awaitingTool).toBeNull();
    expect(fixture.logs.some((entry) => entry.kind === "nudge.exhausted")).toBe(true);
  });

  it("ignores stale, missing-start and non-completed turns", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    fixture.store.mutate(fixture.runId, (run) => Object.assign(run.agents[fixture.peerId], { awaitingTool: "slp_stage_report", awaitingSince: new Date(Date.now() + 3_600_000).toISOString(), nudges: 0 }));
    await hooks.fire("agent.turn_started", { agent: { id: fixture.peerId } });
    await hooks.fire("agent.turn_ended", { agent: { id: fixture.peerId }, outcome: { kind: "completed" } });
    expect(fixture.queuedMessages).toEqual([]);
    fixture.store.mutate(fixture.runId, (run) => { run.agents[fixture.peerId].awaitingSince = "2020-01-01T00:00:00.000Z"; });
    await hooks.fire("agent.turn_ended", { agent: { id: fixture.peerId }, outcome: { kind: "error" } });
    expect(fixture.queuedMessages).toEqual([]);
  });

  it("uses the Forked Lead's approval obligation for its own nudge", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    fixture.store.mutate(fixture.runId, (run) => Object.assign(run.agents[fixture.stageLeadId], { awaitingTool: "slp_approve_stage", awaitingSince: "2020-01-01T00:00:00.000Z" }));
    await hooks.fire("agent.turn_started", { agent: { id: fixture.stageLeadId } });
    await hooks.fire("agent.turn_ended", { agent: { id: fixture.stageLeadId }, outcome: { kind: "completed" } });
    expect(fixture.queuedMessages).toHaveLength(1);
    expect(fixture.queuedMessages[0].awaitTool).toBe("slp_approve_stage");
  });

  it("nudges the Master Lead for slp_define_pipeline only during planning without peer-only instructions", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    const masterLeadId = "lead-agent";
    fixture.store.mutate(fixture.runId, (run) => {
      // Once the run is already 'running' with an active pipeline, a stale slp_define_pipeline stamp must not trigger nudges.
      run.masterLeadAgentId = masterLeadId;
      run.agents[masterLeadId] = buildAgentRecord({
        agentId: masterLeadId,
        role: "master_lead",
        awaitingTool: "slp_define_pipeline",
        awaitingSince: "2020-01-01T00:00:00.000Z",
      });
    });
    await hooks.fire("agent.turn_started", { agent: { id: masterLeadId } });
    await hooks.fire("agent.turn_ended", { agent: { id: masterLeadId }, outcome: { kind: "completed" } });
    expect(fixture.queuedMessages).toHaveLength(0);

    fixture.store.mutate(fixture.runId, (run) => {
      run.status = "planning";
    });
    await hooks.fire("agent.turn_started", { agent: { id: masterLeadId } });
    await hooks.fire("agent.turn_ended", { agent: { id: masterLeadId }, outcome: { kind: "completed" } });
    expect(fixture.queuedMessages).toHaveLength(1);
    expect(fixture.queuedMessages[0].awaitTool).toBe("slp_define_pipeline");
    expect(fixture.queuedMessages[0].text).toContain("[SLP Orchestrator]");
    expect(fixture.queuedMessages[0].text).not.toContain("waitForReply");
  });
});

describe("permission lifecycle events", () => {
  it("captures the SDK handle and answers a permission request once", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    const request = permissionRequest({ name: "Read" });
    await hooks.fire("agent.permission_requested", { agent: { id: fixture.peerId }, request });
    await hooks.fire("agent.permission_requested", { agent: { id: fixture.peerId }, request });
    expect(fixture.capturedHandles).toHaveLength(2);
    expect(fixture.permissionResponses).toHaveLength(1);
    expect(fixture.permissionResponses[0]).toMatchObject({ agentId: fixture.peerId, requestId: request.id, response: { behavior: "allow" } });
  });

  it("denies a stage peer write outside its assigned scope", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    const request = fileWriteRequest("docs/leak.md");
    await hooks.fire("agent.permission_requested", { agent: { id: fixture.peerId }, request });
    expect(fixture.permissionResponses[0].response).toMatchObject({ behavior: "deny" });
    expect(fixture.logs.some((entry) => entry.kind === "permission.Edit" && entry.outcome === "blocked")).toBe(true);
  });

  it("ignores permission requests from agents outside the run", async () => {
    const fixture = dynamicHookContext();
    const hooks = fakeServer();
    registerLifecycleHooks(hooks.server, fixture.ctx as never);
    await hooks.fire("agent.permission_requested", { agent: { id: "stranger" }, request: permissionRequest({ name: "Read" }) });
    expect(fixture.permissionResponses).toEqual([]);
  });
});
