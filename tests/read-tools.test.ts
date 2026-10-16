import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusCaller } from "../server/bus/http-mcp";
import type { PipelineContext } from "../server/pipeline/context";
import { createBusDispatcher } from "../server/pipeline/tool-handlers";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun, buildTask } from "./helpers/run-factory";

let store: RunStore;
let dispatch: ReturnType<typeof createBusDispatcher>["dispatch"];
const peer: BusCaller = { runId: "run-1", agentId: "impl", role: "implementer", taskId: "api" };
const supervisor: BusCaller = { runId: "run-1", agentId: "sup", role: "supervisor", taskId: null };

beforeEach(() => {
  store = new RunStore(":memory:");
  // Separate runs and token-bearing agent records exercise the projection's ownership boundary.
  store.insert(buildRun({ masterSpec: "Shared architecture", tasks: {
    api: buildTask({ id: "api", phase: "implementing", implementationSummary: "API built" }),
    ui: buildTask({ id: "ui", phase: "queued" }),
  }, agents: { impl: buildAgentRecord({ agentId: "impl", role: "implementer", taskId: "api", awaitingTool: "slp_stage_done", token: "private-token" }) } }));
  store.insert(buildRun({ id: "other", tasks: { foreign: buildTask({ id: "foreign" }) } }));
  const ctx = { store, logEvent: vi.fn() } as unknown as PipelineContext;
  dispatch = createBusDispatcher(ctx).dispatch;
});
afterEach(() => store.close());

describe("SQLite read tools", () => {
  it("returns run context without credentials or mailbox contents", async () => {
    const runRead = await dispatch(peer, "slp_get_run", {});
    expect(JSON.parse(runRead.text)).toMatchObject({ id: "run-1", masterSpec: "Shared architecture" });
    expect(runRead.text).not.toContain("private-token");
    expect(runRead.text).not.toContain('"agents"');
    expect(runRead.text).not.toContain('"mailbox"');
  });

  // Reads supply context for the outstanding stage; they must not satisfy or clear that stage.
  it("defaults to the peer's task and preserves its owed tool", async () => {
    const taskRead = await dispatch(peer, "slp_get_task", {});
    expect(JSON.parse(taskRead.text)).toMatchObject({ id: "api", writableScope: ["src/"] });
    expect(store.require("run-1").agents.impl.awaitingTool).toBe("slp_stage_done");
  });

  it("requires an explicit task for run-level callers", async () => {
    expect((await dispatch(supervisor, "slp_get_task", {})).text).toContain("Provide taskId");
    expect(JSON.parse((await dispatch(supervisor, "slp_get_task", { taskId: "api" })).text).id).toBe("api");
  });

  // A guessed ID from another run must never resolve through a global task lookup.
  it.each(["foreign", "constructor"])("does not resolve a foreign or inherited task ID: %s", async (taskId) => {
    expect((await dispatch(peer, "slp_get_task", { taskId })).isError).toBe(true);
  });

  it("filters and paginates task summaries within the caller's run", async () => {
    const taskPage = JSON.parse((await dispatch(peer, "slp_list_tasks", { phase: "queued", limit: 1 })).text);
    expect(taskPage.total).toBe(1);
    expect(taskPage.tasks.map((task: { id: string }) => task.id)).toEqual(["ui"]);
  });

  it("serves a task report to a peer and project reports to a Supervisor", async () => {
    expect(JSON.parse((await dispatch(peer, "slp_get_report", {})).text)).toMatchObject({ taskId: "api", implementationSummary: "API built" });
    expect(JSON.parse((await dispatch(supervisor, "slp_get_report", {})).text)).toEqual({ finalReport: null, supervisorReport: null, peerReports: [] });
  });
});
