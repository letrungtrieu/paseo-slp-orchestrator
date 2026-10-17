import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, currentStage, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("shared pipeline worktree", () => {
  it("gives every peer in a stage the Lead's handed-over worktree and equal write scope", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const pipeline = flow.pipeline(runId, pipelineId)!;
    const stage = currentStage(flow, runId, pipelineId);
    const peerRecords = stage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId]);
    const peerSpecs = stage.peerAgentIds.map((agentId) => flow.gateway.createdAgents.find(({ record }) => record.agentId === agentId)!.spec);

    expect(pipeline.worktree).not.toBe(flow.repoPath);
    expect(pipeline.workspaceId).toBeTruthy();
    expect(peerSpecs.every((spec) => spec.workspaceId === pipeline.workspaceId)).toBe(true);
    expect(peerRecords.every((record) => record.writeScope.length > 0)).toBe(true);
    expect(peerSpecs.every((spec) => spec.peerWorktreePath === pipeline.worktree)).toBe(true);
  });

  it("does not create task specification or report files in a pipeline checkout", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const worktree = flow.pipeline(runId, pipelineId)!.worktree;

    expect(existsSync(join(worktree, "TASK_SPEC.md"))).toBe(false);
    expect(existsSync(join(worktree, "ACCEPTANCE_DOC.md"))).toBe(false);
  });
});
