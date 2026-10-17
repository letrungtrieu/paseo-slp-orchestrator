import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusCaller } from "../server/bus/http-mcp";
import type { PipelineContext } from "../server/pipeline/context";
import { createBusDispatcher } from "../server/pipeline/tool-handlers";
import { PipelineStateSchema } from "../shared/pipeline";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun } from "./helpers/run-factory";

const LONG_MESSAGE = "The stage must preserve the existing ingestion contract and include evidence for edge cases.";
let store: RunStore;
let logEvent: ReturnType<typeof vi.fn>;
let dispatcher: ReturnType<typeof createBusDispatcher>;

function callerFor(agentId: string): BusCaller {
  const lookup = store.findAgent(agentId)!;
  return { runId: lookup.run.id, agentId, role: lookup.agentRecord.role, projectRole: lookup.agentRecord.projectRole, taskId: null };
}

beforeEach(() => {
  store = new RunStore(":memory:");
  const pipeline = PipelineStateSchema.parse({
    id: "pipeline-1", name: "ingestion", version: "1.0", worktree: "/tmp/ingestion", description: "Ingestion pipeline",
    stages: [{ id: "stage-1", name: "coding", goal: "Deliver ingestion", peers: [
      { role: "developer", task: "Implement ingestion" }, { role: "reviewer", task: "Challenge the implementation" },
    ], status: "running", forkedLeadAgentId: "stage-lead", peerAgentIds: ["peer-1", "peer-2"], reports: [], messages: [],
    result: null, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null }],
    status: "running", currentStageIndex: 0, workspaceId: "workspace-1", branch: "slp/ingestion", baseCommit: "abc",
    pausedReason: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    finalReport: null, gate: null, mergedCommit: null, integratedAt: null,
  });
  store.insert(buildRun({ status: "running", pipelines: { [pipeline.id]: pipeline }, agents: {
    "sup-agent": buildAgentRecord({ agentId: "sup-agent", role: "supervisor", token: "tok-sup" }),
    "lead-agent": buildAgentRecord({ agentId: "lead-agent", role: "master_lead", token: "tok-lead" }),
    "stage-lead": buildAgentRecord({ agentId: "stage-lead", role: "forked_lead", pipelineId: pipeline.id, stageId: "stage-1", taskId: null, token: "tok-stage" }),
    "peer-1": buildAgentRecord({ agentId: "peer-1", role: "peer", projectRole: "developer", pipelineId: pipeline.id, stageId: "stage-1", stagePeerId: "0", taskId: null, token: "tok-peer" }),
    "peer-2": buildAgentRecord({ agentId: "peer-2", role: "peer", projectRole: "reviewer", pipelineId: pipeline.id, stageId: "stage-1", stagePeerId: "1", taskId: null, token: "tok-reviewer" }),
  } }));
  logEvent = vi.fn();
  // Stage messages are persisted in the same SQLite mutation as their stage state; the dispatcher
  // does not call the delivery mailbox directly before the tool response returns.
  const fakeContext = { store, logEvent } as unknown as PipelineContext;
  dispatcher = createBusDispatcher(fakeContext);
});

afterEach(() => store.close());

describe("dynamic caller authentication", () => {
  it("maps a token to the strict runtime role and business role", () => {
    expect(dispatcher.resolveCaller("tok-peer")).toEqual({ runId: "run-1", agentId: "peer-1", role: "peer", projectRole: "developer", taskId: null });
  });

  it("returns null for an unknown token", () => {
    expect(dispatcher.resolveCaller("nope")).toBeNull();
  });
});

describe("dispatch validation", () => {
  it("blocks a stage tool from the Master Lead and does not enqueue mail", async () => {
    const outcome = await dispatcher.dispatch(callerFor("lead-agent"), "slp_stage_report", { summary: "wrong owner" });
    expect(outcome).toMatchObject({ isError: true });
    expect(store.require("run-1").mailbox).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ kind: "slp_stage_report", outcome: "blocked" }));
  });

  it("blocks an unknown tool name", async () => {
    const outcome = await dispatcher.dispatch(callerFor("sup-agent"), "slp_format_disk", {});
    expect(outcome).toMatchObject({ isError: true, text: "Unknown tool 'slp_format_disk'." });
  });

  it("blocks invalid stage report arguments with the schema error", async () => {
    const outcome = await dispatcher.dispatch(callerFor("peer-1"), "slp_stage_report", { summary: "" });
    expect(outcome.isError).toBe(true);
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ kind: "slp_stage_report", outcome: "blocked" }));
  });

  it("rejects direct messages to a peer outside the current stage", async () => {
    const outcome = await dispatcher.dispatch(callerFor("peer-1"), "slp_send_peer_message", { toAgentId: "missing", message: LONG_MESSAGE });
    expect(outcome.isError).toBe(true);
    expect(store.require("run-1").mailbox).toHaveLength(0);
  });
});

describe("stage dispatch and bookkeeping", () => {
  it("delivers a direct peer message through the stage mailbox", async () => {
    const outcome = await dispatcher.dispatch(callerFor("peer-1"), "slp_send_peer_message", { toAgentId: "peer-2", message: LONG_MESSAGE });
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain("queued");
    expect(store.require("run-1").mailbox.at(-1)).toMatchObject({
      toAgentId: "peer-2", text: expect.stringContaining(LONG_MESSAGE), awaitTool: null,
    });
    expect(store.require("run-1").pipelines["pipeline-1"].stages[0].messages).toHaveLength(1);
  });

  it("stores peer evidence and sends it to the Forked Lead", async () => {
    store.mutate("run-1", (run) => {
      run.agents["peer-1"].awaitingTool = "slp_stage_report";
      // Simulate a stale retry row left behind when a previous prompt delivery threw a transient error.
      run.mailbox.push({
        id: "stale-report-mail",
        toAgentId: "peer-1",
        text: "stale stage assignment",
        taskId: null,
        awaitTool: "slp_stage_report",
        isReminder: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });
    const outcome = await dispatcher.dispatch(callerFor("peer-1"), "slp_stage_report", { summary: "Evidence", findings: ["covered edge cases"] });
    expect(outcome.isError).toBe(false);
    expect(store.require("run-1").pipelines["pipeline-1"].stages[0].reports).toMatchObject([{ role: "developer", summary: "Evidence" }]);
    expect(store.require("run-1").mailbox.some((queuedMessage) => queuedMessage.id === "stale-report-mail")).toBe(false);
    expect(store.require("run-1").mailbox.at(-1)).toMatchObject({
      toAgentId: "stage-lead", text: expect.stringContaining("Evidence"), awaitTool: "slp_approve_stage",
    });
    expect(store.require("run-1").agents["peer-1"].awaitingTool).toBeNull();
  });

  it("keeps the owed report when a different valid read tool succeeds", async () => {
    store.mutate("run-1", (run) => { run.agents["peer-1"].awaitingTool = "slp_stage_report"; });
    await dispatcher.dispatch(callerFor("peer-1"), "slp_get_pipeline", {});
    expect(store.require("run-1").agents["peer-1"].awaitingTool).toBe("slp_stage_report");
  });

  it("records delivered, blocked and error outcomes once per call", async () => {
    await dispatcher.dispatch(callerFor("peer-1"), "slp_get_pipeline", {});
    await dispatcher.dispatch(callerFor("peer-1"), "slp_stage_report", { summary: "" });
    await dispatcher.dispatch(callerFor("peer-1"), "slp_missing", {});
    expect(logEvent).toHaveBeenCalledTimes(3);
    expect(logEvent.mock.calls.map(([, entry]) => entry.outcome)).toEqual(["delivered", "blocked", "blocked"]);
    expect(logEvent.mock.calls[0][1]).toMatchObject({ from: "peer:peer-1", to: "pipeline", kind: "slp_get_pipeline", taskId: null });
  });
});
