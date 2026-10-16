import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import { registerLifecycleHooks } from "../server/hooks/lifecycle-hooks";
import { NUDGE_LIMIT } from "../shared/roles";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import { API_TASK, eventually, startedRunWithTasks, UI_TASK } from "./helpers/flow-steps";
import { fileWriteRequest, permissionRequest } from "./helpers/permission-request";

const createFlow = useFlowFixture();

type HookHandler = (event: unknown, hookContext: { paseo: unknown }) => unknown;

// Minimal PluginServerContext: remembers handlers by event name so tests can fire them.
// hooks are registered through server.on, so a recording stub is enough to fire them
function fakeServer() {
  const handlers = new Map<string, HookHandler>();
  const removedEvents: string[] = [];
  const server = {
    on: (eventName: string, handler: HookHandler) => {
      handlers.set(eventName, handler);
      return () => removedEvents.push(eventName);
    },
  } as unknown as PluginServerContext;
  const hookContext = { paseo: { marker: "paseo-from-hook" } };
  return {
    server, removedEvents, hookContext,
    fire: (eventName: string, event: unknown) => handlers.get(eventName)!(event, hookContext),
  };
}

// two tasks give each test a second implementer that never had a turn
async function hookedRun() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await startedRunWithTasks(flow, [API_TASK, UI_TASK]);
  const hooks = fakeServer();
  const unregister = registerLifecycleHooks(hooks.server, flow.ctx);
  const implementerId = flow.task(runId, API_TASK.id).agentIds.implementer;
  const startTurn = (agentId: string) => hooks.fire("agent.turn_started", { agent: { id: agentId } });
  const endTurn = (agentId: string, outcomeKind = "completed") => hooks.fire("agent.turn_ended", { agent: { id: agentId }, outcome: { kind: outcomeKind } });
  // the owed tool was requested in the past, so a turn started now counts as the agent's reply
  const requestedLongAgo = (agentId: string, owedTool: string, since = "2020-01-01T00:00:00.000Z") =>
    flow.store.mutate(runId, (run) => {
      Object.assign(run.agents[agentId], { awaitingTool: owedTool, awaitingSince: since, nudges: 0 });
    });
  const remindersFor = (agentId: string) => flow.mailTo(runId, agentId).filter((message) => message.text.startsWith("Reminder:"));
  return { flow, runId, hooks, unregister, implementerId, startTurn, endTurn, requestedLongAgo, remindersFor };
}

// the entry file relies on the returned disposer for shutdown
describe("hook registration", () => {
  it("subscribes to the three lifecycle events and unsubscribes them all", async () => {
    const { hooks, unregister } = await hookedRun();
    expect(() => hooks.fire("agent.turn_started", { agent: { id: "x" } })).not.toThrow();
    unregister();
    expect(hooks.removedEvents.sort()).toEqual(["agent.permission_requested", "agent.turn_ended", "agent.turn_started"]);
  });

  it("captures the SDK handle from every event", async () => {
    const { flow, hooks, implementerId, startTurn, endTurn } = await hookedRun();
    const holder = flow.ctx.holder as unknown as { captures: unknown[] };
    const capturesBefore = holder.captures.length;
    startTurn(implementerId);
    endTurn(implementerId);
    await hooks.fire("agent.permission_requested", { agent: { id: implementerId }, request: permissionRequest({ name: "Read" }) });
    expect(holder.captures.slice(capturesBefore)).toEqual([hooks.hookContext.paseo, hooks.hookContext.paseo, hooks.hookContext.paseo]);
  });
});

// agents that end a turn in plain text would otherwise stall the pipeline silently
describe("nudging an agent that ended its turn without the owed tool", () => {
  it("enqueues a reminder naming the owed tool and counts the nudge", async () => {
    const { flow, runId, implementerId, startTurn, endTurn, requestedLongAgo, remindersFor } = await hookedRun();
    requestedLongAgo(implementerId, "slp_submit_plan");
    startTurn(implementerId);
    endTurn(implementerId);

    const [reminder] = remindersFor(implementerId);
    expect(reminder.text).toContain("without calling slp_submit_plan");
    expect(reminder.awaitTool).toBe("slp_submit_plan");
    expect(flow.run(runId).agents[implementerId].nudges).toBe(1);
  });

  // an endlessly nudged agent would burn tokens; after the limit a human/Lead must decide
  it(`gives up after ${NUDGE_LIMIT} reminders and pauses the task`, async () => {
    const { flow, runId, implementerId, startTurn, endTurn, requestedLongAgo, remindersFor } = await hookedRun();
    requestedLongAgo(implementerId, "slp_submit_plan");
    for (let ended = 0; ended < NUDGE_LIMIT; ended += 1) {
      startTurn(implementerId);
      endTurn(implementerId);
    }
    expect(remindersFor(implementerId)).toHaveLength(NUDGE_LIMIT);
    expect(flow.task(runId, API_TASK.id).phase).toBe("handshaking");

    startTurn(implementerId);
    endTurn(implementerId);

    expect(remindersFor(implementerId)).toHaveLength(NUDGE_LIMIT);
    expect(flow.task(runId, API_TASK.id)).toMatchObject({ phase: "paused", pausedReason: "Escalated: implementer did not call slp_submit_plan" });
    // nothing is owed any more, so later turn ends are ignored
    expect(flow.run(runId).agents[implementerId].awaitingTool).toBeNull();
    await eventually(async () => {
      const logEntries = await flow.store.tailLog(runId, 300);
      if (!logEntries.some((entry) => entry.kind === "nudge.exhausted")) throw new Error("exhaustion not logged");
    });
  });

  // the turn that ended may be the one that started before the request was sent
  it("does not nudge for a stale turn that started before the request", async () => {
    const { flow, runId, implementerId, startTurn, endTurn, requestedLongAgo, remindersFor } = await hookedRun();
    const inTheFuture = new Date(Date.now() + 3_600_000).toISOString();
    requestedLongAgo(implementerId, "slp_submit_plan", inTheFuture);
    startTurn(implementerId);
    endTurn(implementerId);
    expect(remindersFor(implementerId)).toEqual([]);
    expect(flow.run(runId).agents[implementerId].nudges).toBe(0);
  });

  // without a start time the turn cannot be tied to the request
  it("does not nudge when no turn start was observed", async () => {
    const { flow, runId, requestedLongAgo, endTurn, remindersFor } = await hookedRun();
    const uiImplementerId = flow.task(runId, UI_TASK.id).agentIds.implementer;
    requestedLongAgo(uiImplementerId, "slp_submit_plan");
    endTurn(uiImplementerId);
    expect(remindersFor(uiImplementerId)).toEqual([]);
  });

  // only a completed turn means the agent chose not to call its tool
  it.each(["error", "canceled", "interrupted"])("does not nudge when the turn outcome is '%s'", async (outcomeKind) => {
    const { implementerId, startTurn, endTurn, requestedLongAgo, remindersFor } = await hookedRun();
    requestedLongAgo(implementerId, "slp_submit_plan");
    startTurn(implementerId);
    endTurn(implementerId, outcomeKind);
    expect(remindersFor(implementerId)).toEqual([]);
  });

  it("does not nudge an agent that owes nothing", async () => {
    const { flow, runId, startTurn, endTurn, remindersFor } = await hookedRun();
    const masterLeadId = flow.run(runId).masterLeadAgentId;
    startTurn(masterLeadId);
    endTurn(masterLeadId);
    expect(remindersFor(masterLeadId)).toEqual([]);
  });

  // dispatch clears awaitingTool on success, which silences the nudge
  it("does not nudge once the owed tool was called", async () => {
    const { flow, runId, implementerId, startTurn, endTurn, requestedLongAgo, remindersFor } = await hookedRun();
    requestedLongAgo(implementerId, "slp_submit_plan");
    startTurn(implementerId);
    flow.gateway.scriptTurnReplies(flow.task(runId, API_TASK.id).agentIds.forked_lead, ["```json\n{\"verdict\":\"clarify\",\"message\":\"m\"}\n```"]);
    await flow.callAs(implementerId, "slp_submit_plan", { restatedGoal: "g", discrepancies: [], plannedFiles: [] });
    endTurn(implementerId);
    expect(remindersFor(implementerId)).toEqual([]);
  });

  it("ignores agents that do not belong to any run", async () => {
    const { startTurn, endTurn } = await hookedRun();
    startTurn("stranger");
    expect(() => endTurn("stranger")).not.toThrow();
  });

  // An exhausted nudge pauses the task and must reach the Master Lead, who alone can decide.
  it("tells the master lead when nudge exhaustion pauses a task", async () => {
    const { flow, runId, implementerId, startTurn, endTurn, requestedLongAgo } = await hookedRun();
    requestedLongAgo(implementerId, "slp_submit_plan");
    for (let ended = 0; ended <= NUDGE_LIMIT; ended += 1) {
      startTurn(implementerId);
      endTurn(implementerId);
    }
    const masterMail = flow.mailTo(runId, flow.run(runId).masterLeadAgentId);
    expect(masterMail.some((message) => message.text.includes(API_TASK.id))).toBe(true);
  });
});

// agents run with a permission mode that routes every prompt through the policy
describe("permission events", () => {
  const fireRequest = (hooks: ReturnType<typeof fakeServer>, agentId: string, request: ReturnType<typeof permissionRequest>) =>
    hooks.fire("agent.permission_requested", { agent: { id: agentId }, request });
  const lastResponse = (flow: Flow) => flow.gateway.permissionResponses.at(-1)!;

  it("denies a write by an implementer that is still in the read-only handshake", async () => {
    const { flow, hooks, implementerId } = await hookedRun();
    const request = fileWriteRequest("src/api/a.ts");
    await fireRequest(hooks, implementerId, request);
    expect(lastResponse(flow)).toMatchObject({ agentId: implementerId, requestId: request.id, response: { behavior: "deny" } });
  });

  it("allows an in-scope write once the task is implementing and denies one outside", async () => {
    const { flow, runId, hooks, implementerId } = await hookedRun();
    flow.store.mutate(runId, (run) => {
      run.tasks[API_TASK.id].phase = "implementing";
    });
    await fireRequest(hooks, implementerId, fileWriteRequest("src/api/a.ts"));
    expect(lastResponse(flow).response).toEqual({ behavior: "allow" });
    await fireRequest(hooks, implementerId, fileWriteRequest("src/ui/a.ts"));
    expect(lastResponse(flow).response).toMatchObject({ behavior: "deny" });
  });

  // the policy must judge paths against the agent's own cwd
  it("resolves relative paths against the task worktree, not the repository", async () => {
    const { flow, runId, hooks, implementerId } = await hookedRun();
    flow.store.mutate(runId, (run) => {
      run.tasks[API_TASK.id].phase = "implementing";
    });
    const worktree = flow.task(runId, API_TASK.id).workspace!.cwd;
    await fireRequest(hooks, implementerId, fileWriteRequest(`${worktree}/src/api/abs.ts`));
    expect(lastResponse(flow).response).toEqual({ behavior: "allow" });
    // the same file in the main checkout is outside the worktree
    await fireRequest(hooks, implementerId, fileWriteRequest(`${flow.repoPath}/src/api/abs.ts`));
    expect(lastResponse(flow).response).toMatchObject({ behavior: "deny" });
  });

  it("lets the master lead write inside the integration checkout and denies the supervisor", async () => {
    const { flow, runId, hooks } = await hookedRun();
    // Integration fixes remain writable; pipeline specs now go through SQLite tools instead.
    await fireRequest(hooks, flow.run(runId).masterLeadAgentId, fileWriteRequest("src/integration-fix.ts"));
    expect(lastResponse(flow).response).toEqual({ behavior: "allow" });
    await fireRequest(hooks, flow.run(runId).supervisorAgentId, fileWriteRequest("src/index.ts"));
    expect(lastResponse(flow).response).toMatchObject({ behavior: "deny" });
  });

  it("selects the 'implement' action of a plan approval", async () => {
    const { flow, hooks, implementerId } = await hookedRun();
    const planRequest = permissionRequest({ name: "ExitPlanMode", kind: "plan" });
    (planRequest as unknown as { actions: unknown[] }).actions = [{ id: "keep-planning", intent: "dismiss" }, { id: "go", intent: "implement" }];
    await fireRequest(hooks, implementerId, planRequest);
    expect(lastResponse(flow).response).toEqual({ behavior: "allow", selectedActionId: "go" });
  });

  it("answers bus tools with allow and questions with deny", async () => {
    const { flow, hooks, implementerId } = await hookedRun();
    await fireRequest(hooks, implementerId, permissionRequest({ name: "mcp__slp-bus__slp_submit_plan" }));
    expect(lastResponse(flow).response).toEqual({ behavior: "allow" });
    await fireRequest(hooks, implementerId, permissionRequest({ name: "AskUserQuestion", kind: "question" }));
    expect(lastResponse(flow).response).toMatchObject({ behavior: "deny" });
  });

  // a second answer to a resolved request fails inside the SDK
  it("answers each request id only once", async () => {
    const { flow, hooks, implementerId } = await hookedRun();
    const request = permissionRequest({ name: "Read" });
    await fireRequest(hooks, implementerId, request);
    await fireRequest(hooks, implementerId, request);
    expect(flow.gateway.permissionResponses.filter((response) => response.requestId === request.id)).toHaveLength(1);
  });

  it("forgets a request whose answer failed so the sweeper can retry it", async () => {
    const { flow, hooks, implementerId } = await hookedRun();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = permissionRequest({ name: "Read" });
    flow.gateway.failNextPermissionResponse = true;
    await fireRequest(hooks, implementerId, request);
    expect(flow.gateway.permissionResponses).toEqual([]);

    await fireRequest(hooks, implementerId, request);
    expect(flow.gateway.permissionResponses).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  // other plugins' agents are none of the pipeline's business
  it("ignores permission requests from agents unknown to the pipeline", async () => {
    const { flow, hooks } = await hookedRun();
    await fireRequest(hooks, "stranger", permissionRequest({ name: "Read" }));
    expect(flow.gateway.permissionResponses).toEqual([]);
  });

  it("logs a denial to the comm log as blocked", async () => {
    const { flow, runId, hooks, implementerId } = await hookedRun();
    await fireRequest(hooks, implementerId, fileWriteRequest("src/api/a.ts"));
    await eventually(async () => {
      const logEntries = await flow.store.tailLog(runId, 300);
      if (!logEntries.some((entry) => entry.kind === "permission.Edit" && entry.outcome === "blocked")) throw new Error("denial not logged");
    });
  });
});
