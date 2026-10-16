import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../server/store/run-store";
import { approveMain, approveRunGate } from "../server/pipeline/run-lifecycle";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  API_TASK, UI_TASK, COMPLETE_ACCEPTANCE_REPORT, approveHandshake, approveVerification, driveToReadyForMerge,
  finishImplementation, startedRunWithTasks, waitForPhase,
} from "./helpers/flow-steps";
import { mergeBranchInto, runGitSync } from "./helpers/git-fixture";

const createFlow = useFlowFixture();

// Build a task whose next obligation is a structured acceptance report.
async function documentingRun() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await startedRunWithTasks(flow, [API_TASK]);
  await approveHandshake(flow, runId, API_TASK.id);
  await waitForPhase(flow, runId, API_TASK.id, "implementing");
  await finishImplementation(flow, runId, API_TASK.id);
  await approveVerification(flow, runId, API_TASK.id);
  await waitForPhase(flow, runId, API_TASK.id, "documenting");
  const reportDocDone = (report: unknown = COMPLETE_ACCEPTANCE_REPORT) => flow.callAsRole(runId, "implementer", API_TASK.id, "slp_doc_done", { report });
  return { flow, runId, reportDocDone };
}

// Master Lead's part of phase 4: merge the task branch into dev, then archive the task.
async function mergeAndArchive(flow: Flow, runId: string, taskId: string) {
  mergeBranchInto(flow.run(runId).devCwd, flow.task(runId, taskId).workspace!.branch);
  return flow.callAsRole(runId, "master_lead", null, "slp_archive_task", { taskId });
}

describe("acceptance reports in SQLite", () => {
  it("rejects an empty completion acknowledgement", async () => {
    const { flow, runId } = await documentingRun();
    const docReport = await flow.callAsRole(runId, "implementer", API_TASK.id, "slp_doc_done", {});
    expect(docReport.isError).toBe(true);
    expect(docReport.text).toContain("Invalid arguments");
    expect(flow.task(runId, API_TASK.id).phase).toBe("documenting");
  });

  // Missing evidence is rejected before either the phase or the saved report changes.
  it("rejects an incomplete report and identifies missing fields", async () => {
    const { reportDocDone, flow, runId } = await documentingRun();
    const docReport = await reportDocDone({ summary: "done", changedFiles: [] });
    expect(docReport.isError).toBe(true);
    expect(docReport.text).toContain("qaResults");
    expect(docReport.text).toContain("securityReview");
    expect(flow.task(runId, API_TASK.id).acceptanceReport).toBeNull();
  });

  it("persists a complete report with its authenticated author and notifies the Lead", async () => {
    const { reportDocDone, flow, runId } = await documentingRun();
    expect((await reportDocDone()).isError).toBe(false);
    const readyMail = flow.mailTo(runId, flow.run(runId).masterLeadAgentId)
      .find((message) => message.text.includes("READY FOR MERGE"))!;
    expect(readyMail.awaitTool).toBe("slp_archive_task");
    expect(readyMail.text).toContain("slp_get_report");
    expect(readyMail.text).toContain(API_TASK.id);
    const reloadedStore = new RunStore(flow.databasePath);
    try {
      // A fresh connection proves report content and merge readiness survive a plugin restart.
      reloadedStore.load();
      expect(reloadedStore.require(runId).tasks[API_TASK.id]).toMatchObject({ phase: "ready_for_merge",
        acceptanceReport: { report: COMPLETE_ACCEPTANCE_REPORT, submittedBy: flow.agentId(runId, "implementer", API_TASK.id) } });
    } finally { reloadedStore.close(); }
    expect(existsSync(join(flow.task(runId, API_TASK.id).workspace!.cwd, ".slp"))).toBe(false);
  });

  it("allows a corrected report after a validation failure", async () => {
    const { reportDocDone } = await documentingRun();
    expect((await reportDocDone({ summary: "incomplete" })).isError).toBe(true);
    expect((await reportDocDone()).isError).toBe(false);
  });

  it("refuses a report outside the documenting phase", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    const docReport = await flow.callAsRole(runId, "implementer", API_TASK.id, "slp_doc_done", { report: COMPLETE_ACCEPTANCE_REPORT });
    expect(docReport.text).toContain("Doc report not expected now");
  });
});

// spec phases 4-6 after tasks are ready
describe("merge, archive and reporting (spec phases 4-6)", () => {
  async function allTasksReady() {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow, [API_TASK, UI_TASK]);
    await driveToReadyForMerge(flow, runId, API_TASK.id);
    await driveToReadyForMerge(flow, runId, UI_TASK.id);
    return { flow, runId };
  }

  it("archives a merged task: peers and workspace archived, phase merged", async () => {
    const { flow, runId } = await allTasksReady();
    const peerIds = Object.values(flow.task(runId, API_TASK.id).agentIds);
    const workspaceId = flow.task(runId, API_TASK.id).workspace!.workspaceId;

    const archival = await mergeAndArchive(flow, runId, API_TASK.id);

    expect(archival.text).toBe(`Task '${API_TASK.id}' archived.`);
    expect(flow.task(runId, API_TASK.id)).toMatchObject({ phase: "merged", agentIds: {} });
    for (const peerId of peerIds) expect(flow.gateway.archivedAgentIds).toContain(peerId);
    expect(flow.paseo.archivedWorkspaceIds).toContain(workspaceId);
    // the other task is untouched
    expect(flow.task(runId, UI_TASK.id).phase).toBe("ready_for_merge");
  });

  // the integration tests must wait for every task
  it("sends the 'all merged' notice only after the last task", async () => {
    const { flow, runId } = await allTasksReady();
    const masterLeadId = flow.run(runId).masterLeadAgentId;
    const allMergedMails = () => flow.mailTo(runId, masterLeadId).filter((message) => message.text.includes("All tasks are merged"));

    await mergeAndArchive(flow, runId, API_TASK.id);
    expect(allMergedMails()).toHaveLength(0);
    const lastArchival = await mergeAndArchive(flow, runId, UI_TASK.id);

    expect(lastArchival.text).toContain("All tasks are merged");
    expect(allMergedMails()).toHaveLength(1);
    expect(allMergedMails()[0].awaitTool).toBe("slp_report");
  });

  it("refuses to archive a task that is not ready for merge", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    const archival = await flow.callAsRole(runId, "master_lead", null, "slp_archive_task", { taskId: API_TASK.id });
    expect(archival).toMatchObject({ isError: true });
    expect(archival.text).toContain("not ready_for_merge");
  });

  // the Supervisor verifies independently, using the diff command in the mail
  it("slp_report goes to the supervisor and moves the run to 'reporting'", async () => {
    const { flow, runId } = await allTasksReady();
    const report = await flow.callAsRole(runId, "master_lead", null, "slp_report", { summary: "All green" });

    expect(report.isError).toBe(false);
    expect(flow.run(runId)).toMatchObject({ status: "reporting", finalReport: "All green" });
    const supervisorMail = flow.mailTo(runId, flow.run(runId).supervisorAgentId).at(-1)!;
    expect(supervisorMail.text).toContain("All green");
    expect(supervisorMail.text).toContain("slp_get_report(taskId)");
    expect(supervisorMail.text).toContain(`git diff main..${flow.run(runId).integrationBranch}`);
  });

  // a rejected result sends the Lead back to work
  it("slp_request_rework sends the master lead back to work and expects a new report", async () => {
    const { flow, runId } = await allTasksReady();
    await flow.callAsRole(runId, "master_lead", null, "slp_report", { summary: "done" });
    await flow.callAsRole(runId, "supervisor", null, "slp_request_rework", { feedback: "criterion 3 is missing" });

    expect(flow.run(runId).status).toBe("running");
    const reworkMail = flow.mailTo(runId, flow.run(runId).masterLeadAgentId).at(-1)!;
    expect(reworkMail.text).toContain("criterion 3 is missing");
    expect(reworkMail.awaitTool).toBe("slp_report");
  });

  // the Supreme Manager alone merges into the base branch
  it("slp_present_to_manager opens the final approval gate", async () => {
    const { flow, runId } = await allTasksReady();
    await flow.callAsRole(runId, "master_lead", null, "slp_report", { summary: "done" });
    const presentation = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Verified in Vietnamese" });

    expect(presentation.isError).toBe(false);
    expect(flow.run(runId)).toMatchObject({ status: "awaiting_user", supervisorReport: "Verified in Vietnamese" });
    expect(flow.run(runId).gate).toMatchObject({ kind: "final_approval" });
  });
});

describe("final approval merges into the base branch", () => {
  // full story up to the Supervisor's presentation
  async function presentedRun() {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow, [API_TASK, UI_TASK]);
    await driveToReadyForMerge(flow, runId, API_TASK.id);
    await driveToReadyForMerge(flow, runId, UI_TASK.id);
    await mergeAndArchive(flow, runId, API_TASK.id);
    await mergeAndArchive(flow, runId, UI_TASK.id);
    await flow.callAsRole(runId, "master_lead", null, "slp_report", { summary: "done" });
    await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "ok" });
    return { flow, runId };
  }

  // verified through git itself rather than state flags
  it("merges the integration branch into main, completes the run and clears the gate", async () => {
    const { flow, runId } = await presentedRun();
    const mainBefore = runGitSync(flow.repoPath, ["rev-parse", "main"]).trim();

    const approval = await approveRunGate(flow.ctx, runId, null);

    expect(approval).toContain(`Merged ${flow.run(runId).integrationBranch} into main`);
    expect(flow.run(runId)).toMatchObject({ status: "completed", gate: null });
    expect(runGitSync(flow.repoPath, ["rev-parse", "main"]).trim()).not.toBe(mainBefore);
    // verified through git itself: a --no-ff merge commit and both tasks' work are on main
    expect(runGitSync(flow.repoPath, ["log", "--format=%s", "main"])).toContain(`SLP: merge ${flow.run(runId).integrationBranch}`);
    expect(existsSync(join(flow.repoPath, "src/api/feature.ts"))).toBe(true);
    expect(existsSync(join(flow.repoPath, "src/ui/feature.ts"))).toBe(true);
    // pipeline files never reached the merge
    expect(runGitSync(flow.repoPath, ["ls-files"])).not.toContain("TASK_SPEC.md");
    expect(runGitSync(flow.repoPath, ["ls-files"])).not.toContain(".slp/");
    // Even ignored/untracked pipeline debris must stay absent throughout a complete successful run.
    expect(existsSync(join(flow.repoPath, ".slp/comm-log.jsonl"))).toBe(false);
    expect(existsSync(join(flow.repoPath, ".slp/ACCEPTANCE_DOC.md"))).toBe(false);
    for (const task of Object.values(flow.run(runId).tasks)) {
      expect(existsSync(join(task.workspace!.cwd, ".slp"))).toBe(false);
      expect(existsSync(join(task.workspace!.cwd, "TASK_SPEC.md"))).toBe(false);
    }
  });

  it("refuses to merge before the supervisor presented the result", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await expect(approveMain(flow.ctx, runId)).rejects.toThrow(/not awaiting approval/);
  });

  // merging over local edits could destroy the user's work
  it("refuses to merge into a dirty base branch and keeps awaiting approval", async () => {
    const { flow, runId } = await presentedRun();
    writeFileSync(join(flow.repoPath, "README.md"), "locally edited\n", "utf8");
    await expect(approveMain(flow.ctx, runId)).rejects.toThrow(/uncommitted changes/);
    expect(flow.run(runId).status).toBe("awaiting_user");
  });

  it("refuses to merge when the repo is on a different branch than the base branch", async () => {
    const { flow, runId } = await presentedRun();
    runGitSync(flow.repoPath, ["checkout", "-b", "feature/other"]);
    await expect(approveMain(flow.ctx, runId)).rejects.toThrow(/expected base branch 'main'/);
    expect(readFileSync(join(flow.repoPath, "README.md"), "utf8")).toContain("fixture");
  });

  it("cannot be approved twice", async () => {
    const { flow, runId } = await presentedRun();
    await approveRunGate(flow.ctx, runId, null);
    await expect(approveRunGate(flow.ctx, runId, null)).rejects.toThrow();
  });
});
