import { describe, expect, it } from "vitest";
import { HANDSHAKE_ROUND_LIMIT } from "../shared/roles";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  API_TASK, IMPLEMENTER_PLAN, eventually, forkedLeadReply, startedRunWithTasks, submitPlanAndAwaitReview, waitForPhase,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();
const TASK_ID = API_TASK.id;

async function handshakingRun(mode: "FULL_AUTO" | "STEP_BY_STEP_DEBUG" | "SEMI_AUTO" = "FULL_AUTO") {
  const flow = await createFlow({ mode });
  const runId = await startedRunWithTasks(flow);
  return { flow, runId, masterLeadId: flow.run(runId).masterLeadAgentId };
}

const mailTexts = (flow: Flow, runId: string, agentId: string) => flow.mailTo(runId, agentId).map((message) => message.text);

// spec phase 2, step 4: readback handshake between Implementer and Forked Lead
describe("handshake clarification", () => {
  // reviews take minutes, so the tool call must return immediately
  it("sends the plan to the forked lead and returns to the implementer immediately", async () => {
    const { flow, runId } = await handshakingRun();
    const forkedLeadId = flow.task(runId, TASK_ID).agentIds.forked_lead;
    flow.gateway.scriptTurnReplies(forkedLeadId, [forkedLeadReply("clarify", "which router?")]);
    const submission = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_submit_plan", IMPLEMENTER_PLAN);

    expect(submission.isError).toBe(false);
    expect(submission.text).toContain("The Forked Lead is reviewing it");
    await eventually(() => expect(flow.gateway.turns).toHaveLength(1));
    // the review prompt carries the restated goal, discrepancies and files
    expect(flow.gateway.turns[0].text).toContain(IMPLEMENTER_PLAN.restatedGoal);
    expect(flow.gateway.turns[0].text).toContain(IMPLEMENTER_PLAN.discrepancies[0]);
    expect(flow.gateway.turns[0].text).toContain("src/api/billing.ts");
    expect(flow.task(runId, TASK_ID).plan).toEqual(IMPLEMENTER_PLAN);
    expect(flow.task(runId, TASK_ID).handshakeRounds).toBe(1);
  });

  // the Forked Lead explains and the Implementer revises until the plan matches
  it("mails the clarification to the implementer, who resubmits until approved", async () => {
    const { flow, runId, masterLeadId } = await handshakingRun();
    const implementerId = flow.task(runId, TASK_ID).agentIds.implementer;
    await submitPlanAndAwaitReview(flow, runId, TASK_ID, "clarify", "which router?");

    await eventually(() => expect(flow.mailTo(runId, implementerId)).toHaveLength(1));
    const [clarification] = flow.mailTo(runId, implementerId);
    expect(clarification.text).toContain("which router?");
    expect(clarification.awaitTool).toBe("slp_submit_plan");
    expect(flow.task(runId, TASK_ID).phase).toBe("handshaking");

    await submitPlanAndAwaitReview(flow, runId, TASK_ID, "approve");
    await waitForPhase(flow, runId, TASK_ID, "implementing");

    const forkedLeadId = flow.gateway.createdAgentsOfRole("forked_lead")[0].record.agentId;
    // spec step 5: forked lead retired, master lead briefed, writes unlocked
    expect(flow.gateway.archivedAgentIds).toContain(forkedLeadId);
    expect(flow.task(runId, TASK_ID).agentIds.forked_lead).toBeUndefined();
    expect(mailTexts(flow, runId, masterLeadId).some((text) => text.includes("plan approved after 2 round(s)"))).toBe(true);
    const unlockMail = flow.mailTo(runId, implementerId).find((message) => message.awaitTool === "slp_stage_done");
    expect(unlockMail?.text).toContain("APPROVED");
    expect(unlockMail?.text).toContain("src/api/");
  });

  // writes are only unlocked after the Forked Lead's approval
  it("stays read-only until approval: stage_done during the handshake is refused", async () => {
    const { flow, runId } = await handshakingRun();
    const stageReport = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_stage_done", { summary: "too early" });
    expect(stageReport).toMatchObject({ isError: true });
    expect(stageReport.text).toContain("phase 'handshaking'");
  });

  it("refuses a plan once the task is no longer handshaking", async () => {
    const { flow, runId } = await handshakingRun();
    await submitPlanAndAwaitReview(flow, runId, TASK_ID, "approve");
    await waitForPhase(flow, runId, TASK_ID, "implementing");
    const lateSubmission = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_submit_plan", IMPLEMENTER_PLAN);
    expect(lateSubmission.text).toContain("Plan not expected now");
  });
});

// the Forked Lead has no tools, so its verdict is parsed from text
describe("unparseable verdicts", () => {
  it("makes one repair attempt before accepting the verdict", async () => {
    const { flow, runId } = await handshakingRun();
    const forkedLeadId = flow.task(runId, TASK_ID).agentIds.forked_lead;
    flow.gateway.scriptTurnReplies(forkedLeadId, ["Sure, looks fine to me!", forkedLeadReply("approve")]);
    await flow.callAsRole(runId, "implementer", TASK_ID, "slp_submit_plan", IMPLEMENTER_PLAN);

    await waitForPhase(flow, runId, TASK_ID, "implementing");
    expect(flow.gateway.turns).toHaveLength(2);
    expect(flow.gateway.turns[1].text).toContain("no valid verdict");
  });

  // a verdict nobody can parse must not stall the task
  it("escalates to the master lead when the repair attempt fails too", async () => {
    const { flow, runId, masterLeadId } = await handshakingRun();
    const forkedLeadId = flow.task(runId, TASK_ID).agentIds.forked_lead;
    flow.gateway.scriptTurnReplies(forkedLeadId, ["prose only", "still prose"]);
    await flow.callAsRole(runId, "implementer", TASK_ID, "slp_submit_plan", IMPLEMENTER_PLAN);

    await waitForPhase(flow, runId, TASK_ID, "paused");
    expect(flow.task(runId, TASK_ID).pausedReason).toContain("no parseable verdict");
    expect(mailTexts(flow, runId, masterLeadId).some((text) => text.includes("ESCALATION"))).toBe(true);
  });

  it("escalates when the forked lead turn itself throws", async () => {
    const { flow, runId } = await handshakingRun();
    flow.gateway.runTurn = async () => {
      throw new Error("forked lead crashed");
    };
    await flow.callAsRole(runId, "implementer", TASK_ID, "slp_submit_plan", IMPLEMENTER_PLAN);
    await waitForPhase(flow, runId, TASK_ID, "paused");
    expect(flow.task(runId, TASK_ID).pausedReason).toContain("handshake review failed: forked lead crashed");
  });
});

// spec section 4, rule 2: spec disputes go up to the Master Lead
describe("handshake escalation", () => {
  it("pauses the task and asks the master lead, who resumes it with slp_spec_decision", async () => {
    const { flow, runId, masterLeadId } = await handshakingRun();
    const implementerId = flow.task(runId, TASK_ID).agentIds.implementer;
    await submitPlanAndAwaitReview(flow, runId, TASK_ID, "escalate", "the API contract is wrong");

    await waitForPhase(flow, runId, TASK_ID, "paused");
    expect(flow.task(runId, TASK_ID)).toMatchObject({ pausedFromPhase: "handshaking", pausedReason: "Escalated: the API contract is wrong" });
    const escalationMail = flow.mailTo(runId, masterLeadId).find((message) => message.text.includes("ESCALATION"));
    expect(escalationMail?.awaitTool).toBe("slp_spec_decision");
    // the sibling task keeps going
    expect(flow.task(runId, "ui-layer").phase).toBe("handshaking");

    const decision = await flow.callAsRole(runId, "master_lead", null, "slp_spec_decision", { taskId: TASK_ID, decision: "use REST v2" });
    expect(decision.text).toContain("resumed");
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "handshaking", pausedReason: null, pausedFromPhase: null });
    const resumeMail = flow.mailTo(runId, implementerId).find((message) => message.text.includes("use REST v2"));
    expect(resumeMail?.awaitTool).toBe("slp_submit_plan");
    expect(resumeMail?.text).toContain("READ-ONLY");
  });

  // any peer can stop the line instead of improvising
  it("lets the implementer escalate through slp_escalate", async () => {
    const { flow, runId, masterLeadId } = await handshakingRun();
    const escalation = await flow.callAsRole(runId, "implementer", TASK_ID, "slp_escalate", { reason: "schema cannot be implemented" });
    expect(escalation.isError).toBe(false);
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "paused", pausedReason: "Escalated: implementer: schema cannot be implemented" });
    expect(mailTexts(flow, runId, masterLeadId).at(-1)).toContain("schema cannot be implemented");
  });

  // a handshake that never converges means the spec itself is wrong
  it("forces an escalation when clarification does not converge within the round limit", async () => {
    const { flow, runId, masterLeadId } = await handshakingRun();
    for (let round = 1; round <= HANDSHAKE_ROUND_LIMIT; round += 1) {
      await submitPlanAndAwaitReview(flow, runId, TASK_ID, "clarify", `still unclear ${round}`);
      // each round must finish before the next plan is submitted
      await eventually(() => {
        const settled = round < HANDSHAKE_ROUND_LIMIT ? flow.task(runId, TASK_ID).phase === "handshaking" : flow.task(runId, TASK_ID).phase === "paused";
        if (!settled) throw new Error(`round ${round} not settled`);
      });
    }
    expect(flow.task(runId, TASK_ID).handshakeRounds).toBe(HANDSHAKE_ROUND_LIMIT);
    expect(flow.task(runId, TASK_ID).pausedReason).toContain(`did not converge after ${HANDSHAKE_ROUND_LIMIT} rounds`);
    expect(mailTexts(flow, runId, masterLeadId).some((text) => text.includes("did not converge"))).toBe(true);
    // only the first three clarifications reached the implementer
    const clarificationCount = flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer).filter((message) => message.text.includes("needs changes")).length;
    expect(clarificationCount).toBe(HANDSHAKE_ROUND_LIMIT - 1);
  });

  // the limit only blocks further clarification, not a valid approval
  it("still approves on the last allowed round", async () => {
    const { flow, runId } = await handshakingRun();
    for (let round = 1; round < HANDSHAKE_ROUND_LIMIT; round += 1) {
      await submitPlanAndAwaitReview(flow, runId, TASK_ID, "clarify");
      await eventually(() => expect(flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer)).toHaveLength(round));
    }
    await submitPlanAndAwaitReview(flow, runId, TASK_ID, "approve");
    await waitForPhase(flow, runId, TASK_ID, "implementing");
  });

  // decisions for an unpaused task are plain guidance
  it("forwards a spec decision to a running implementer when the task is not paused", async () => {
    const { flow, runId } = await handshakingRun();
    const decision = await flow.callAsRole(runId, "master_lead", null, "slp_spec_decision", { taskId: TASK_ID, decision: "prefer fetch over axios" });
    expect(decision.text).toContain("forwarded");
    const forwardedMail = flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer).at(-1);
    expect(forwardedMail?.text).toContain("prefer fetch over axios");
    expect(forwardedMail?.awaitTool).toBeNull();
    expect(flow.task(runId, TASK_ID).phase).toBe("handshaking");
  });
});
