import { describe, expect, it } from "vitest";
import { FIX_LOOP_LIMIT } from "../shared/roles";
import type { Flow } from "./helpers/flow-fixture";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  API_TASK, approveHandshake, eventually, finishImplementation, startedRunWithTasks, waitForPhase,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();
const TASK_ID = API_TASK.id;

// every verification scenario starts from a task whose stage was accepted
async function verifyingRun(taskOverrides: object = {}) {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await startedRunWithTasks(flow, [{ ...API_TASK, ...taskOverrides }]);
  await approveHandshake(flow, runId, TASK_ID);
  await waitForPhase(flow, runId, TASK_ID, "implementing");
  await finishImplementation(flow, runId, TASK_ID);
  return { flow, runId };
}

const verdict = (flow: Flow, runId: string, role: "qa" | "security", outcome: "APPROVED" | "REJECTED", issues: string[] = []) =>
  flow.callAsRole(runId, role, TASK_ID, "slp_verdict", { verdict: outcome, issues });

const verifierExists = (flow: Flow, runId: string, role: "qa" | "security") =>
  eventually(() => {
    flow.agentId(runId, role, TASK_ID);
  });

// spec phase 3: QA and Security review the same worktree at once
describe("parallel verification", () => {
  it("wakes QA and Security together in the task worktree, each owing a verdict", async () => {
    const { flow, runId } = await verifyingRun();
    await verifierExists(flow, runId, "qa");
    await verifierExists(flow, runId, "security");

    const task = flow.task(runId, TASK_ID);
    for (const role of ["qa", "security"] as const) {
      const { spec } = flow.gateway.createdAgentsOfRole(role)[0];
      expect(spec).toMatchObject({ workspaceId: task.workspace!.workspaceId, awaitTool: "slp_verdict", provider: "codex/gpt" });
      expect(spec.initialPrompt).toContain("Verification round 1");
    }
    expect(task.phase).toBe("verifying");
  });

  // one approval is not enough while another reviewer is pending
  it("moves on to documentation only after every verifier approved", async () => {
    const { flow, runId } = await verifyingRun();
    await verifierExists(flow, runId, "qa");
    await verifierExists(flow, runId, "security");

    await verdict(flow, runId, "qa", "APPROVED");
    // security has not answered yet, so the round stays open
    expect(flow.task(runId, TASK_ID).phase).toBe("verifying");
    await verdict(flow, runId, "security", "APPROVED");

    await waitForPhase(flow, runId, TASK_ID, "documenting");
    const docMail = flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer).at(-1);
    expect(docMail).toMatchObject({ awaitTool: "slp_doc_done" });
    expect(docMail?.text).toContain(".slp/ACCEPTANCE_DOC.md");
  });

  // late verdicts must not reopen a finished round
  it("rejects a verdict from a task that is not being verified", async () => {
    const { flow, runId } = await verifyingRun();
    await verifierExists(flow, runId, "qa");
    await verdict(flow, runId, "qa", "APPROVED");
    await verdict(flow, runId, "security", "APPROVED");
    await waitForPhase(flow, runId, TASK_ID, "documenting");
    const lateVerdict = await verdict(flow, runId, "qa", "APPROVED");
    expect(lateVerdict).toMatchObject({ isError: true });
    expect(lateVerdict.text).toContain("Verdict not expected now");
  });

  // one fix loop covers every reviewer's findings
  it("collects both reviewers' issues into one fix request and counts one loop", async () => {
    const { flow, runId } = await verifyingRun();
    await verifierExists(flow, runId, "qa");
    await verifierExists(flow, runId, "security");
    await verdict(flow, runId, "qa", "REJECTED", ["missing edge-case test"]);
    await verdict(flow, runId, "security", "REJECTED", ["SQL injection in query"]);

    await waitForPhase(flow, runId, TASK_ID, "fixing");
    expect(flow.task(runId, TASK_ID).fixLoopCount).toBe(1);
    const fixMail = flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer).at(-1)!;
    expect(fixMail.awaitTool).toBe("slp_stage_done");
    expect(fixMail.text).toContain("missing edge-case test");
    expect(fixMail.text).toContain("SQL injection in query");
    expect(fixMail.text).toContain(`fix loop 1/${FIX_LOOP_LIMIT}`);
  });

  // reviewers keep their memory, so they are mailed instead of recreated
  it("re-reviews with the same reviewers after a fix and clears the previous verdicts", async () => {
    const { flow, runId } = await verifyingRun();
    await verifierExists(flow, runId, "qa");
    await verifierExists(flow, runId, "security");
    await verdict(flow, runId, "qa", "REJECTED", ["bug"]);
    await verdict(flow, runId, "security", "APPROVED");
    await waitForPhase(flow, runId, TASK_ID, "fixing");

    const fixReport = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_stage_done", { summary: "fixed" });
    expect(fixReport.isError).toBe(false);
    await eventually(() => expect(flow.task(runId, TASK_ID).phase).toBe("verifying"));

    expect(flow.task(runId, TASK_ID).roundVerdicts).toEqual({});
    // reviewers are woken by mail (their memory is kept), not recreated
    expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(1);
    const qaId = flow.task(runId, TASK_ID).agentIds.qa;
    const qaMail = flow.mailTo(runId, qaId).at(-1)!;
    expect(qaMail.text).toContain("Verification round 2");
    expect(qaMail.awaitTool).toBe("slp_verdict");
  });
});

// the Master Lead may chain reviewers one after another
describe("sequential verification", () => {
  it("wakes only the first verifier, then the next after an approval", async () => {
    const { flow, runId } = await verifyingRun({ verifyParallel: false });
    await verifierExists(flow, runId, "qa");
    expect(flow.gateway.createdAgentsOfRole("security")).toHaveLength(0);
    expect(flow.task(runId, TASK_ID).verifierQueue).toEqual(["security"]);

    await verdict(flow, runId, "qa", "APPROVED");
    await verifierExists(flow, runId, "security");
    expect(flow.task(runId, TASK_ID).phase).toBe("verifying");

    await verdict(flow, runId, "security", "APPROVED");
    await waitForPhase(flow, runId, TASK_ID, "documenting");
  });

  // waking the next reviewer for code that already failed wastes a round
  it("ends the round at the first rejection without waking the next verifier", async () => {
    const { flow, runId } = await verifyingRun({ verifyParallel: false });
    await verifierExists(flow, runId, "qa");
    await verdict(flow, runId, "qa", "REJECTED", ["broken"]);

    await waitForPhase(flow, runId, TASK_ID, "fixing");
    expect(flow.gateway.createdAgentsOfRole("security")).toHaveLength(0);
    expect(flow.task(runId, TASK_ID).fixLoopCount).toBe(1);
  });

  it("honours a custom verifier order and subset", async () => {
    const { flow, runId } = await verifyingRun({ verifyParallel: false, verifiers: ["security"] });
    await verifierExists(flow, runId, "security");
    expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(0);
    await verdict(flow, runId, "security", "APPROVED");
    await waitForPhase(flow, runId, TASK_ID, "documenting");
  });
});

describe("verification stage edge cases", () => {
  it("skips verification entirely when the Master Lead configured no verifiers", async () => {
    const { flow, runId } = await verifyingRun({ verifiers: [] });
    await waitForPhase(flow, runId, TASK_ID, "documenting");
    expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(0);
  });

  it("creates a Doc peer when documentedBy is 'doc'", async () => {
    const { flow, runId } = await verifyingRun({ verifiers: [], documentedBy: "doc" });
    await eventually(() => flow.agentId(runId, "doc", TASK_ID));
    const { spec } = flow.gateway.createdAgentsOfRole("doc")[0];
    expect(spec.awaitTool).toBe("slp_doc_done");
    expect(spec.workspaceId).toBe(flow.task(runId, TASK_ID).workspace!.workspaceId);
  });
});

// spec section 4, rule 3: more than three rejected rounds pauses the task
describe("circuit breaker", () => {
  async function rejectRound(flow: Flow, runId: string, round: number): Promise<void> {
    await verdict(flow, runId, "qa", "REJECTED", [`issue of round ${round}`]);
    await verdict(flow, runId, "security", "APPROVED");
  }

  // walks through FIX_LOOP_LIMIT fix rounds and one rejection beyond
  async function runIntoCircuitBreaker() {
    const { flow, runId } = await verifyingRun();
    await verifierExists(flow, runId, "qa");
    await verifierExists(flow, runId, "security");
    for (let round = 1; round <= FIX_LOOP_LIMIT; round += 1) {
      await rejectRound(flow, runId, round);
      await waitForPhase(flow, runId, TASK_ID, "fixing");
      expect(flow.task(runId, TASK_ID).fixLoopCount).toBe(round);
      await flow.callAsRole(runId, "implementer", TASK_ID, "slp_stage_done", { summary: `fix ${round}` });
      await eventually(() => expect(flow.task(runId, TASK_ID).phase).toBe("verifying"));
    }
    await rejectRound(flow, runId, FIX_LOOP_LIMIT + 1);
    await waitForPhase(flow, runId, TASK_ID, "paused");
    return { flow, runId };
  }

  it("keeps fixing through the allowed rounds and trips on the first rejection beyond the limit", async () => {
    const { flow, runId } = await runIntoCircuitBreaker();
    const task = flow.task(runId, TASK_ID);
    expect(task.fixLoopCount).toBe(FIX_LOOP_LIMIT + 1);
    expect(task).toMatchObject({ pausedFromPhase: "fixing" });
    expect(task.pausedReason).toContain("Circuit breaker");
    // mail is undelivered in this test, so exactly the three allowed fix requests are queued and no 4th one
    const fixRequests = flow.mailTo(runId, task.agentIds.implementer).filter((message) => message.text.includes("fix loop"));
    expect(fixRequests).toHaveLength(FIX_LOOP_LIMIT);
    expect(fixRequests.some((message) => message.text.includes(`fix loop ${FIX_LOOP_LIMIT + 1}/`))).toBe(false);
  });

  // the Lead needs the failing issues to decide how to proceed
  it("alerts the master lead with the latest issues", async () => {
    const { flow, runId } = await runIntoCircuitBreaker();
    const breakerMail = flow.mailTo(runId, flow.run(runId).masterLeadAgentId).find((message) => message.text.includes("CIRCUIT BREAKER"));
    expect(breakerMail?.awaitTool).toBe("slp_spec_decision");
    expect(breakerMail?.text).toContain(`issue of round ${FIX_LOOP_LIMIT + 1}`);
    expect(breakerMail?.text).toContain(TASK_ID);
  });

  // a Lead or human decision grants a fresh budget
  it("resets the fix budget when the master lead resumes the task", async () => {
    const { flow, runId } = await runIntoCircuitBreaker();
    const decision = await flow.callAsRole(runId, "master_lead", null, "slp_spec_decision", { taskId: TASK_ID, decision: "relax the edge-case requirement" });

    expect(decision.isError).toBe(false);
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "fixing", fixLoopCount: 0, pausedReason: null, pausedFromPhase: null });
    const resumeMail = flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer).at(-1)!;
    expect(resumeMail.text).toContain("relax the edge-case requirement");
    expect(resumeMail.awaitTool).toBe("slp_stage_done");

    // the implementer can continue: stage_done goes back into verification
    const resumedReport = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_stage_done", { summary: "resumed" });
    expect(resumedReport.isError).toBe(false);
    await eventually(() => expect(flow.task(runId, TASK_ID).phase).toBe("verifying"));
  });

  it("is also resumable through the pipeline's resumeTask entry point (human button)", async () => {
    const { flow, runId } = await runIntoCircuitBreaker();
    const { resumeTask } = await import("../server/pipeline/task-pause");
    resumeTask(flow.ctx, runId, TASK_ID, null);
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "fixing", fixLoopCount: 0 });
  });

  it("refuses to resume a task that is not paused", async () => {
    const { flow, runId } = await verifyingRun();
    const { resumeTask } = await import("../server/pipeline/task-pause");
    expect(() => resumeTask(flow.ctx, runId, TASK_ID, null)).toThrow(/not paused/);
  });
});
