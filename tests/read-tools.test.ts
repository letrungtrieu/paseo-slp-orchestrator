import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusCaller } from "../server/bus/http-mcp";
import type { PipelineContext } from "../server/pipeline/context";
import { createBusDispatcher } from "../server/pipeline/tool-handlers";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { PipelineStateSchema } from "../shared/pipeline";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun } from "./helpers/run-factory";

let store: RunStore;
let dispatch: ReturnType<typeof createBusDispatcher>["dispatch"];
const peer: BusCaller = { runId: "run-1", agentId: "peer-1", role: "peer", projectRole: "developer", taskId: null };
const masterLead: BusCaller = { runId: "run-1", agentId: "lead-1", role: "master_lead", taskId: null };

function pipelineFixture() {
  return PipelineStateSchema.parse({
    id: "pipeline-1",
    name: "ingestion",
    version: "1.0",
    worktree: "/tmp/ingestion-worktree",
    description: "Ingest and export data.",
    stages: [{
      id: "stage-1", name: "coding", goal: "Implement ingestion.",
      peers: [{ role: "developer", task: "Implement the ingestion path." }],
      status: "running", forkedLeadAgentId: "stage-lead", peerAgentIds: ["peer-1"], reports: [], messages: [],
      result: null, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null,
    }],
    status: "running", currentStageIndex: 0, workspaceId: "workspace-1", branch: "slp/ingestion", baseCommit: "abc",
    pausedReason: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    finalReport: null, gate: null, mergedCommit: null, integratedAt: null,
  });
}

beforeEach(() => {
  store = new RunStore(":memory:");
  const pipeline = pipelineFixture();
  // Read projections must expose stage context without leaking tokens or unrelated runs.
  store.insert(buildRun({ promptConfig: defaultProjectPrompts(), pipelines: { [pipeline.id]: pipeline }, agents: {
    "peer-1": buildAgentRecord({ agentId: "peer-1", role: "peer", projectRole: "developer", pipelineId: pipeline.id, stageId: "stage-1", stagePeerId: "0", taskId: null, token: "private-token" }),
    "lead-1": buildAgentRecord({ agentId: "lead-1", role: "master_lead", taskId: null }),
  } }));
  store.insert(buildRun({ id: "other", pipelines: { "foreign-pipeline": { ...pipeline, id: "foreign-pipeline", name: "foreign" } } }));
  const ctx = { store, logEvent: vi.fn() } as unknown as PipelineContext;
  dispatch = createBusDispatcher(ctx).dispatch;
});
afterEach(() => store.close());

describe("dynamic pipeline read tools", () => {
  it("returns run context without credentials or mailbox contents", async () => {
    const runRead = await dispatch(peer, "slp_get_run", {});
    expect(JSON.parse(runRead.text)).toMatchObject({ id: "run-1", pipelines: [{ id: "pipeline-1", name: "ingestion" }] });
    expect(runRead.text).not.toContain("private-token");
    expect(runRead.text).not.toContain('"agents"');
    expect(runRead.text).not.toContain('"mailbox"');
  });

  it("defaults a stage peer to its assigned pipeline", async () => {
    const pipelineRead = await dispatch(peer, "slp_get_pipeline", {});
    expect(JSON.parse(pipelineRead.text)).toMatchObject({ id: "pipeline-1", stages: [{ id: "stage-1", status: "running" }] });
  });

  it("requires an explicit pipeline for a top-level Lead", async () => {
    expect((await dispatch(masterLead, "slp_get_pipeline", {})).isError).toBe(true);
    expect(JSON.parse((await dispatch(masterLead, "slp_get_pipeline", { pipelineId: "pipeline-1" })).text).id).toBe("pipeline-1");
  });

  it("does not resolve a foreign or inherited pipeline id", async () => {
    expect((await dispatch(peer, "slp_get_pipeline", { pipelineId: "foreign-pipeline" })).isError).toBe(true);
    expect((await dispatch(peer, "slp_get_pipeline", { pipelineId: "constructor" })).isError).toBe(true);
  });

  it("lists ordered stage summaries for the run's pipelines", async () => {
    const pipelinePage = JSON.parse((await dispatch(masterLead, "slp_list_pipelines", {})).text);
    expect(pipelinePage.pipelines).toMatchObject([{ id: "pipeline-1", stages: [{ name: "coding", goal: "Implement ingestion.", status: "running" }] }]);
  });

  it("keeps the stage assignment readable after a report obligation is set", async () => {
    store.mutate("run-1", (run) => { run.agents["peer-1"].awaitingTool = "slp_stage_report"; });
    await dispatch(peer, "slp_get_pipeline", {});
    expect(store.require("run-1").agents["peer-1"].awaitingTool).toBe("slp_stage_report");
  });
});
