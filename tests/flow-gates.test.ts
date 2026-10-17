import { describe, expect, it } from "vitest";
import type { PipelineDefinition } from "../shared/pipeline";
import { approvePipelineGate } from "../server/pipeline/stage-control";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, approveCurrentStage, currentStage, reportPeer, startedRunWithPipeline, waitForStage } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("dynamic pipeline gates", () => {
  it("pauses between Lead-authored stages in STEP_BY_STEP_DEBUG", async () => {
    const flow = await createFlow({ mode: "STEP_BY_STEP_DEBUG" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    for (const assignment of firstStage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    const pausedPipeline = flow.pipeline(runId, pipelineId)!;
    expect(pausedPipeline.status).toBe("paused");
    expect(pausedPipeline.gate).toMatchObject({ kind: "after_stage", stageId: firstStage.id });
    expect(pausedPipeline.currentStageIndex).toBe(1);

    const approval = await approvePipelineGate(flow.ctx, runId, pipelineId);
    expect(approval).toContain("Next stage scheduled");
    await waitForStage(flow, runId, pipelineId, "running");
    expect(currentStage(flow, runId, pipelineId).name).toBe("coding");
  });

  it("opens a before-integration gate after all stages in SEMI_AUTO", async () => {
    const flow = await createFlow({ mode: "SEMI_AUTO" });
    const definition: PipelineDefinition = { ...DEFAULT_PIPELINE, name: "semi-auto", stages: [DEFAULT_PIPELINE.stages[0]] };
    const { runId, pipelineId } = await startedRunWithPipeline(flow, definition);
    const stage = currentStage(flow, runId, pipelineId);
    for (const assignment of stage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    expect(flow.pipeline(runId, pipelineId)!.gate).toMatchObject({ kind: "before_integration" });
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("completed");
  });

  it("keeps FULL_AUTO free of human gates while retaining Forked Lead approval", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const definition: PipelineDefinition = { ...DEFAULT_PIPELINE, name: "full-auto", stages: [DEFAULT_PIPELINE.stages[0]] };
    const { runId, pipelineId } = await startedRunWithPipeline(flow, definition);
    const stage = currentStage(flow, runId, pipelineId);
    for (const assignment of stage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    expect(flow.pipeline(runId, pipelineId)!.gate).toBeNull();
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("completed");
  });
});
