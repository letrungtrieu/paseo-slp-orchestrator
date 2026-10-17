import { describe, expect, it } from "vitest";
import { PipelineEnvelopeSchema, PipelineGateSchema, PipelineStateSchema, StageReportSubmissionSchema } from "../shared/pipeline";

describe("Lead-authored dynamic pipeline contract", () => {
  it("preserves ordered stages and equal peer rosters", () => {
    const envelope = PipelineEnvelopeSchema.parse({
      pipeline: {
        name: "task_A", version: "1.0", worktree: "path/to/worktree", description: "Data ingestion and export.",
        stages: [
          { name: "review-codebase", goal: "Understand the current design.", peers: [
            { role: "reviewer", task: "Review the codebase." },
            { role: "developer", task: "Address review findings." },
          ] },
          { name: "coding", goal: "Implement the accepted design.", peers: [{ role: "developer", task: "Implement the feature." }] },
          { name: "qa", goal: "Verify the delivered behavior.", peers: [{ role: "qa_engineer", task: "Exercise edge cases." }] },
        ],
      },
    });
    expect(envelope.pipeline.stages.map((stage) => stage.name)).toEqual(["review-codebase", "coding", "qa"]);
    expect(envelope.pipeline.stages[0].peers.map((peer) => peer.role)).toEqual(["reviewer", "developer"]);
    expect(envelope.pipeline.stages[2].peers[0].role).toBe("qa-engineer");
  });

  it("accepts a Lead-supplied systemPrompt but leaves workflow authority to the daemon", () => {
    const envelope = PipelineEnvelopeSchema.parse({
      pipeline: { name: "task", version: "1", worktree: ".", description: "Work", stages: [
        { name: "inspect", goal: "Inspect", peers: [{ role: "reviewer", systemPrompt: "untrusted hint", task: "Review" }] },
      ] },
    });
    expect(envelope.pipeline.stages[0].peers[0].systemPrompt).toBe("untrusted hint");
  });

  it("models stage approval gates without reintroducing task phases", () => {
    const gate = PipelineGateSchema.parse({ kind: "after_stage", stageId: "stage-1", openedAt: "2026-01-01", note: "Review" });
    expect(gate).toEqual({ kind: "after_stage", stageId: "stage-1", openedAt: "2026-01-01", note: "Review" });
    expect(() => PipelineGateSchema.parse({ kind: "before_merge", stageId: null, openedAt: "now", note: "old" })).toThrow();
  });

  it("requires a report before a Forked Lead can approve a stage", () => {
    expect(StageReportSubmissionSchema.parse({ summary: "done" })).toEqual({ summary: "done", findings: [], status: "completed" });
    expect(() => StageReportSubmissionSchema.parse({ summary: "" })).toThrow();
  });

  it("keeps dynamic stage statuses separate from the pipeline status", () => {
    const state = PipelineStateSchema.parse({
      name: "task", version: "1", worktree: ".", description: "Work", stages: [{
        id: "stage-1", name: "coding", goal: "Code", peers: [{ role: "developer", task: "Code" }], status: "completed",
        forkedLeadAgentId: "lead", peerAgentIds: ["peer"], reports: [], messages: [], result: { summary: "accepted", approvedBy: "lead", approvedAt: "now" },
      }], id: "pipeline-1", status: "completed", currentStageIndex: 1, workspaceId: null, branch: null, baseCommit: null,
      pausedReason: null, createdAt: "now", updatedAt: "now", finalReport: "accepted", gate: null, mergedCommit: null, integratedAt: null,
    });
    expect(state.stages[0].status).toBe("completed");
    expect(state.status).toBe("completed");
  });
});
