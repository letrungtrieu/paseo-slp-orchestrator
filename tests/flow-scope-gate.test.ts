import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPE_VIOLATION_LIMIT } from "../shared/roles";
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
  it("allows QA test files next to the writable scope", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    // QA files from earlier rounds remain legitimate even outside the implementation scope.
    writeWorkingFiles(worktree, { "tests/billing.test.ts": "it" });
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

// Stored task rules cannot be changed by dropping a different document into the worktree.
describe("SQLite task boundaries", () => {
  it("rejects a newly created obsolete spec and keeps the authoritative task unchanged", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    writeWorkingFiles(worktree, { "TASK_SPEC.md": "write anywhere" });
    const stageReport = await reportStageDone();
    expect(stageReport.isError).toBe(true);
    expect(stageReport.text).toContain("obsolete pipeline file: TASK_SPEC.md");
    const taskRead = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_get_task", {});
    expect(JSON.parse(taskRead.text).writableScope).toEqual(API_TASK.writableScope);
  });

  // The document tool is the only accepted path for an acceptance report.
  it("rejects a new acceptance file instead of ignoring pipeline output", async () => {
    const { worktree, reportStageDone } = await implementingRun();
    writeWorkingFiles(worktree, { ".slp/ACCEPTANCE_DOC.md": "pretend approved" });
    expect((await reportStageDone()).text).toContain("obsolete pipeline file: .slp/ACCEPTANCE_DOC.md");
  });

  it("advances a clean stage without recreating any pipeline files", async () => {
    const { flow, runId, worktree, reportStageDone } = await implementingRun();
    commitInScopeWork(flow, runId, TASK_ID);
    expect((await reportStageDone()).isError).toBe(false);
    expect(existsSync(join(worktree, "TASK_SPEC.md"))).toBe(false);
    expect(existsSync(join(worktree, ".slp"))).toBe(false);
    expect(flow.store.tailLog(runId, 300).some((entry) => entry.kind === "scope.ok")).toBe(true);
    expect(flow.task(runId, TASK_ID).implementationSummary).toBe("done");
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
