// Verifies safe archival (x-button / archiveOnly) and restoration of SLP runs across lifecycle phases and deleted worktree directories.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleSupervisorArchived } from "../server/pipeline/run-lifecycle";
import { archiveRunSafely, restoreRun } from "../server/pipeline/run-restore";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  DEFAULT_PIPELINE,
  commitPipelineWork,
  delegateToLead,
  startedRunWithPipeline,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("run archive protection and restoration", () => {
  it("preserves committed work on the pipeline branch and re-attaches a deleted worktree directory on restore", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    commitPipelineWork(flow, runId, pipelineId, "src/preserved-feature.ts");

    const activePipeline = flow.pipeline(runId, pipelineId)!;
    const worktreeDirectory = activePipeline.worktree;
    const pipelineBranch = activePipeline.branch!;
    expect(existsSync(worktreeDirectory)).toBe(true);

    // Simulate accidental x-button click on the Supervisor session in Paseo.
    await flow.gateway.archive(flow.run(runId).supervisorAgentId);
    await handleSupervisorArchived(flow.ctx, runId);

    // Both the worktree directory and the local slp/* branch remain intact after x-button archival.
    expect(existsSync(worktreeDirectory)).toBe(true);
    const branchesAfterArchive = execFileSync("git", ["branch", "--list", pipelineBranch], {
      cwd: flow.repoPath,
      encoding: "utf8",
    }).trim();
    expect(branchesAfterArchive).toContain(pipelineBranch);

    // Simulate Paseo also removing the worktree checkout directory while leaving the local git branch ref intact.
    rmSync(worktreeDirectory, { recursive: true, force: true });
    expect(existsSync(worktreeDirectory)).toBe(false);

    // Restoring the run re-attaches the git worktree from the preserved local branch and resumes the stage.
    const restoredOutcome = await restoreRun(flow.ctx, runId);
    expect(restoredOutcome.ok).toBe(true);
    expect(restoredOutcome.status).toBe("running");
    expect(existsSync(worktreeDirectory)).toBe(true);
    expect(existsSync(`${worktreeDirectory}/src/preserved-feature.ts`)).toBe(true);
    expect(flow.pipeline(runId, pipelineId)!.status).toBe("running");
  });

  it("restores a run that was archived during planning and re-queues slp_define_pipeline for its Lead", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const originalLeadId = flow.run(runId).masterLeadAgentId;

    // Safely archive the run while it is still in 'planning' before any pipeline is defined.
    await archiveRunSafely(flow.ctx, runId);
    expect(flow.run(runId).status).toBe("aborted");
    expect(flow.run(runId).archivedFromStatus).toBe("planning");
    expect(flow.run(runId).archivedAt).toBeTruthy();

    const restoredOutcome = await restoreRun(flow.ctx, runId);
    expect(restoredOutcome.status).toBe("planning");
    const restoredLeadId = flow.run(runId).masterLeadAgentId;
    expect(restoredLeadId).not.toBe(originalLeadId);
    expect(flow.run(runId).agents[restoredLeadId].awaitingTool).toBe("slp_define_pipeline");
  });
});
