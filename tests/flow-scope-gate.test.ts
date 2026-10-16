import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashTaskSpec } from "../server/prompts/task-spec";
import { SCOPE_VIOLATION_LIMIT } from "../shared/roles";
import { tailCommLog } from "../server/store/comm-log";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  API_TASK, approveHandshake, commitInScopeWork, eventually, startedRunWithTasks, waitForPhase,
} from "./helpers/flow-steps";
import { commitFiles, writeWorkingFiles } from "./helpers/git-fixture";

const createFlow = useFlowFixture();
const TASK_ID = API_TASK.id;

// most scope scenarios need a task that is already allowed to write
async function implementingRun() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await startedRunWithTasks(flow);
  await approveHandshake(flow, runId, TASK_ID);
  await waitForPhase(flow, runId, TASK_ID, "implementing");
  const worktree = flow.task(runId, TASK_ID).workspace!.cwd;
  const reportStageDone = () => flow.callAsRole(runId, "implementer", TASK_ID, "slp_stage_done", { summary: "done" });
  return { flow, runId, worktree, reportStageDone };
}

describe("scope gate after implementation", () => {
  it("accepts in-scope work and moves the task to verifying", async () => {
    const { flow, runId, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    const stageReport = await reportStageDone();

    expect(stageReport.isError).toBe(false);
    expect(stageReport.text).toContain("QA/Security review starts now");
    expect(flow.task(runId, TASK_ID).phase).toBe("verifying");
  });

  // git status catches untracked files, so nothing can hide in the worktree
  it("rejects an uncommitted out-of-scope file with a ToolError and counts the violation", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    writeWorkingFiles(worktree, { "docs/out.md": "leak" });
    const stageReport = await reportStageDone();

    expect(stageReport.isError).toBe(true);
    expect(stageReport.text).toContain("outside writable scope: docs/out.md");
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "implementing", scopeViolations: 1 });
  });

  // the branch diff against dev catches committed changes
  it("also catches an out-of-scope file that was committed", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    commitFiles(worktree, { "lib/sneaky.ts": "export {}", "src/api/ok.ts": "export {}" }, "mixed commit");
    const stageReport = await reportStageDone();
    expect(stageReport.text).toContain("lib/sneaky.ts");
    expect(stageReport.text).not.toContain("src/api/ok.ts");
  });

  // repeated violations mean the agent cannot self-correct; a human/Lead must step in
  it("pauses the task on the third violation without raising a tool error", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    writeWorkingFiles(worktree, { "docs/out.md": "leak" });

    for (let attempt = 1; attempt < SCOPE_VIOLATION_LIMIT; attempt += 1) {
      expect((await reportStageDone()).isError).toBe(true);
      expect(flow.task(runId, TASK_ID).scopeViolations).toBe(attempt);
    }
    const finalAttempt = await reportStageDone();

    expect(finalAttempt.isError).toBe(false);
    expect(finalAttempt.text).toContain("paused");
    expect(flow.task(runId, TASK_ID)).toMatchObject({
      phase: "paused",
      scopeViolations: SCOPE_VIOLATION_LIMIT,
      pausedFromPhase: "implementing",
    });
    expect(flow.task(runId, TASK_ID).pausedReason).toContain("docs/out.md");
  });

  // only consecutive violations count towards the limit
  it("resets the violation counter after a clean stage", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    writeWorkingFiles(worktree, { "docs/out.md": "leak" });
    await reportStageDone();
    rmSync(join(worktree, "docs"), { recursive: true });
    commitInScopeWork(flow, runId, TASK_ID);
    expect((await reportStageDone()).isError).toBe(false);
    expect(flow.task(runId, TASK_ID).scopeViolations).toBe(0);
  });

  // the Lead's decision starts a fresh budget
  it("lets a paused task be resumed by the master lead with a fresh violation budget", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    writeWorkingFiles(worktree, { "docs/out.md": "leak" });
    for (let attempt = 0; attempt < SCOPE_VIOLATION_LIMIT; attempt += 1) await reportStageDone();

    await flow.callAsRole(runId, "master_lead", null, "slp_spec_decision", { taskId: TASK_ID, decision: "docs/ is now in scope, keep going" });
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "implementing", scopeViolations: 0, pausedReason: null });
    const resumeMail = flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer).at(-1);
    expect(resumeMail?.awaitTool).toBe("slp_stage_done");
  });

  // earlier QA rounds leave test files in the diff
  it("allows QA test files and pipeline output next to the writable scope", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    // QA files from an earlier round stay in the diff; .slp/ is the pipeline's own output
    writeWorkingFiles(worktree, { "tests/billing.test.ts": "it", ".slp/ACCEPTANCE_DOC.md": "# doc" });
    expect((await reportStageDone()).isError).toBe(false);
  });

  // a stale or duplicated stage report must not reopen verification
  it("refuses stage_done outside implementing/fixing", async () => {
    const { flow, runId, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    await reportStageDone();
    const secondReport = await reportStageDone();
    expect(secondReport.text).toContain("not expected now");
  });
});

// spec phase 3: the daemon, not the agent, restores TASK_SPEC.md
describe("TASK_SPEC.md protection", () => {
  it("restores a tampered TASK_SPEC.md and still accepts in-scope work", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    const originalSpec = readFileSync(join(worktree, "TASK_SPEC.md"), "utf8");
    writeFileSync(join(worktree, "TASK_SPEC.md"), "# my own rules\nwrite anywhere", "utf8");
    commitInScopeWork(flow, runId, TASK_ID);

    expect((await reportStageDone()).isError).toBe(false);
    const restoredSpec = readFileSync(join(worktree, "TASK_SPEC.md"), "utf8");
    expect(restoredSpec).toBe(originalSpec);
    expect(hashTaskSpec(restoredSpec)).toBe(flow.task(runId, TASK_ID).taskSpecSha256);
    await eventually(async () => {
      const entries = await tailCommLog(flow.repoPath, runId, 300);
      if (!entries.some((entry) => entry.kind === "scope.spec_restored")) throw new Error("restoration not logged");
    });
  });

  // deleting the spec counts as tampering too
  it("restores a deleted TASK_SPEC.md", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    rmSync(join(worktree, "TASK_SPEC.md"));
    commitInScopeWork(flow, runId, TASK_ID);
    await reportStageDone();
    expect(readFileSync(join(worktree, "TASK_SPEC.md"), "utf8")).toContain("# TASK_SPEC:");
  });

  // restoration must not depend on the stage being accepted
  it("restores the spec even when the same stage is rejected for scope", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    const originalSpec = readFileSync(join(worktree, "TASK_SPEC.md"), "utf8");
    writeFileSync(join(worktree, "TASK_SPEC.md"), "tampered", "utf8");
    writeWorkingFiles(worktree, { "docs/out.md": "x" });
    expect((await reportStageDone()).isError).toBe(true);
    expect(readFileSync(join(worktree, "TASK_SPEC.md"), "utf8")).toBe(originalSpec);
  });

  it("leaves an untouched TASK_SPEC.md alone", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    await reportStageDone();
    await eventually(async () => {
      const entries = await tailCommLog(flow.repoPath, runId, 300);
      if (!entries.some((entry) => entry.kind === "scope.ok")) throw new Error("scope.ok not logged yet");
      expect(entries.some((entry) => entry.kind === "scope.spec_restored")).toBe(false);
    });
  });
});

describe("pause notifications", () => {
  // Spec section 4, rule 3 / phase 3: a paused task must reach the Master Lead, otherwise nobody
  // is told and nobody can decide.
  it("mails the master lead when a task is paused for repeated scope violations", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    writeWorkingFiles(worktree, { "docs/out.md": "leak" });
    for (let attempt = 0; attempt < SCOPE_VIOLATION_LIMIT; attempt += 1) await reportStageDone();
    const masterMail = flow.mailTo(runId, flow.run(runId).masterLeadAgentId);
    expect(masterMail.some((message) => message.text.includes(TASK_ID) && message.awaitTool === "slp_spec_decision")).toBe(true);
  });
});
