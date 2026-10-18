import { describe, expect, it } from "vitest";
import { normalizePipelineRoleId, type PipelineDefinition } from "../shared/pipeline";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, currentStage, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("project business roles", () => {
  it("keeps the seeded project vocabulary separate from runtime capabilities", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const configuration = flow.run(runId).promptConfig!;

    // Recursive discovery reads .slp/peers/ in lexicographical filename order.
    expect(configuration.peers.map((peer) => peer.role)).toEqual([
      "developer",
      "end-user",
      "qa-engineer",
      "reviewer",
      "security-reviewer",
    ]);
    expect(configuration.peers.map((peer) => peer.role)).not.toContain("implementer");
    expect(configuration.peers.map((peer) => peer.role)).not.toContain("qa");
    expect(Object.values(flow.run(runId).agents).filter((agent) => agent.role === "peer").every((agent) => agent.projectRole)).toBe(true);
  });

  it("normalizes Lead-authored role IDs before resolving .slp workflows", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const pipeline: PipelineDefinition = {
      ...DEFAULT_PIPELINE,
      name: "normalized-role",
      stages: [{
        name: "qa-normalization",
        goal: "Use the configured QA workflow.",
        peers: [{ role: "qa_engineer", task: "Run the configured QA checks." }],
      }],
    };
    const { runId, pipelineId } = await startedRunWithPipeline(flow, pipeline);
    const stage = currentStage(flow, runId, pipelineId);
    const peerId = flow.agentId(runId, "qa_engineer", stage.id);

    expect(normalizePipelineRoleId(" QA_engineer ")).toBe("qa-engineer");
    expect(flow.run(runId).agents[peerId].projectRole).toBe("qa-engineer");
    expect(flow.gateway.createdAgents.find(({ record }) => record.agentId === peerId)?.spec.title).toContain("QA Engineer");
  });

  it("rejects a business role absent from the project's .slp snapshot", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
    });
    const response = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", { pipeline: {
      ...DEFAULT_PIPELINE,
      name: "unknown-role",
      stages: [{ ...DEFAULT_PIPELINE.stages[0], peers: [{ role: "performance", task: "Measure the import path." }] }],
    } });

    expect(response).toMatchObject({ isError: true });
    expect(response.text).toContain("Unknown project peer role");
    expect(Object.keys(flow.run(runId).pipelines)).toHaveLength(0);
  });
});
