// Behaviours that the happy-path flow tests do not reach. Several of them started as failing
// evidence for defects found while writing this suite and are kept as regression tests.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveMain } from "../server/pipeline/run-lifecycle";
import { HANDSHAKE_ROUND_LIMIT } from "../shared/roles";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  API_TASK, IMPLEMENTER_PLAN, eventually, forkedLeadReply, startedRunWithTasks, submitPlanAndAwaitReview, waitForPhase,
} from "./helpers/flow-steps";
import { commitFiles, runGitSync } from "./helpers/git-fixture";

const createFlow = useFlowFixture();
const settle = (milliseconds = 150) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("task start failures", () => {
  it("marks a task failed with the reason when its worktree cannot be created", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    // occupy the branch name the pipeline will want for the task
    runGitSync(flow.repoPath, ["branch", `slp/${runId.slice(0, 8)}/${API_TASK.id}`]);
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "Billing works end to end." });
    await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", { masterSpec: "spec.md", tasks: [API_TASK] });

    await waitForPhase(flow, runId, API_TASK.id, "failed");
    expect(flow.task(runId, API_TASK.id).pausedReason).toMatch(/^Could not start:/);
    expect(flow.gateway.createdAgentsOfRole("implementer")).toEqual([]);
  });
});

describe("merge into the base branch", () => {
  async function presentedRunWithDivergedBase() {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    commitFiles(flow.run(runId).devCwd, { "README.md": "integration edit\n" }, "dev change");
    // someone committed to the same file on main while the run was busy
    commitFiles(flow.repoPath, { "README.md": "base edit\n" }, "base change");
    flow.store.mutate(runId, (run) => {
      run.status = "awaiting_user";
    });
    return { flow, runId };
  }

  it("reports a merge conflict as an error and keeps the run awaiting approval", async () => {
    const { flow, runId } = await presentedRunWithDivergedBase();
    await expect(approveMain(flow.ctx, runId)).rejects.toThrow(/git merge/);
    expect(flow.run(runId).status).toBe("awaiting_user");
  });

  // A failed `git merge` would leave the user's checkout in a conflicted MERGE_HEAD state, so the
  // pipeline must abort it: the Supreme Manager's main checkout is never left half merged.
  it("leaves the base checkout clean after a conflicting merge", async () => {
    const { flow, runId } = await presentedRunWithDivergedBase();
    await approveMain(flow.ctx, runId).catch(() => undefined);
    expect(existsSync(join(flow.repoPath, ".git", "MERGE_HEAD"))).toBe(false);
    expect(runGitSync(flow.repoPath, ["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("");
  });
});

describe("handshake robustness", () => {
  // Two slp_submit_plan calls in one turn must not start two concurrent reviews: both could approve
  // and unlock the implementer twice and brief the master lead twice.
  it("ignores a second plan while the first one is still under review", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    const forkedLeadId = flow.task(runId, API_TASK.id).agentIds.forked_lead;
    flow.gateway.scriptTurnReplies(forkedLeadId, [forkedLeadReply("approve"), forkedLeadReply("approve")]);
    await Promise.all([1, 2].map(() => flow.callAsRole(runId, "implementer", API_TASK.id, "slp_submit_plan", IMPLEMENTER_PLAN)));
    await settle();

    const implementerId = flow.task(runId, API_TASK.id).agentIds.implementer;
    const unlockMails = flow.mailTo(runId, implementerId).filter((message) => message.awaitTool === "slp_stage_done");
    expect(unlockMails).toHaveLength(1);
  });

  // fixLoopCount gets a fresh budget on resume, so handshakeRounds must too; otherwise the very
  // first clarify after the Lead's decision would escalate again.
  it("gives the handshake a fresh round budget after the master lead resumed the task", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    for (let round = 1; round <= HANDSHAKE_ROUND_LIMIT; round += 1) {
      await submitPlanAndAwaitReview(flow, runId, API_TASK.id, "clarify");
      await settle(30);
    }
    await waitForPhase(flow, runId, API_TASK.id, "paused");
    await flow.callAsRole(runId, "master_lead", null, "slp_spec_decision", { taskId: API_TASK.id, decision: "contract clarified" });

    await submitPlanAndAwaitReview(flow, runId, API_TASK.id, "clarify", "one more detail");
    await settle();
    expect(flow.task(runId, API_TASK.id).phase).toBe("handshaking");
  });
});

describe("supervisor guards", () => {
  // Spec phase 6: the Supervisor presents only after the Master Lead's report; a premature call
  // would open the final approval gate for an empty integration branch.
  it("refuses slp_present_to_manager before the master lead reported", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const presentation = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "trust me" });
    expect(presentation.isError).toBe(true);
    expect(flow.run(runId).status).not.toBe("awaiting_user");
  });

  it("surfaces the progress of a failed start to the supervisor's card", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    // A worktree failure is exercised only after the Supervisor has actually delegated the project.
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "Deliver billing with independent tasks." });
    runGitSync(flow.repoPath, ["branch", `slp/${runId.slice(0, 8)}/${API_TASK.id}`]);
    await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", { masterSpec: "spec.md", tasks: [API_TASK] });
    await eventually(() => {
      if (!flow.paseo.cardsForTask(API_TASK.id).some((card) => card.phase === "failed")) throw new Error("no failed card");
    });
  });
});
