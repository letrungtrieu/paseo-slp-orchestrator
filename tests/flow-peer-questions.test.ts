import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sweepPeerQuestions } from "../server/pipeline/peer-messaging/question-sweep";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, currentStage, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

// A peer and its Lead in one running stage: peers may only talk to their Lead, so this is the smallest
// setup in which a question has an asker and a recipient.
async function reviewerAndLead(flow: Flow) {
  const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
  const stage = currentStage(flow, runId, pipelineId);
  return {
    runId,
    reviewerId: flow.agentId(runId, "reviewer", stage.id),
    leadId: flow.agentId(runId, "forked_lead", stage.id),
  };
}

const sweep = async (flow: Flow, runId: string) => {
  flow.gateway.markEveryAgentIdle();
  sweepPeerQuestions(flow.ctx, runId, await flow.gateway.liveStatuses(runId));
};

const onlyQuestion = (flow: Flow, runId: string) => {
  const ledgerRows = flow.store.questions.listForRun(runId, 10);
  expect(ledgerRows).toHaveLength(1);
  return ledgerRows[0];
};

describe("blocking questions", () => {
  it("returns a pending notice after the wait window and resumes with slp_await_answer", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);

    const firstWindow = await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Which retry cap applies?" });
    const askedQuestion = onlyQuestion(flow, runId);
    expect(firstWindow.isError).toBe(false);
    expect(firstWindow.text).toContain("slp_await_answer");
    expect(firstWindow.text).toContain(askedQuestion.questionId);

    // The agent resumes waiting, and the answer lands while that second window is open.
    const resumedWait = flow.callAs(reviewerId, "slp_await_answer", { questionId: askedQuestion.questionId });
    const answerOutcome = await flow.callAs(leadId, "slp_answer", { questionId: askedQuestion.questionId, answer: "Cap is 3 attempts." });
    expect(answerOutcome.isError).toBe(false);
    expect((await resumedWait).text).toContain("Cap is 3 attempts.");
    expect(flow.store.questions.require(askedQuestion.questionId)).toMatchObject({ status: "answered" });
  });

  it("does not hang when two agents ask each other at once: each call surfaces the other's question", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", questionTiming: { waitWindowMs: 2_000 } });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);

    const reviewerAsk = flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Q-from-reviewer" });
    await vi.waitFor(() => expect(flow.store.questions.listForRun(runId, 10)).toHaveLength(1));
    const leadAsk = flow.callAs(leadId, "slp_ask", { toAgentId: reviewerId, question: "Q-from-lead" });

    // A 2 s window would only elapse if the waiting reviewer were not woken by the developer's question.
    const startedAt = Date.now();
    const [reviewerResult, leadResult] = await Promise.all([reviewerAsk, leadAsk]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(reviewerResult.text).toContain("Q-from-lead");
    expect(leadResult.text).toContain("Q-from-reviewer");

    // Both answer, then each collects the reply with slp_await_answer.
    const ledgerRows = flow.store.questions.listForRun(runId, 10);
    const reviewerQuestionId = ledgerRows.find((row) => row.question === "Q-from-reviewer")!.questionId;
    const developerQuestionId = ledgerRows.find((row) => row.question === "Q-from-lead")!.questionId;
    await flow.callAs(leadId, "slp_answer", { questionId: reviewerQuestionId, answer: "A-from-developer" });
    await flow.callAs(reviewerId, "slp_answer", { questionId: developerQuestionId, answer: "A-from-reviewer" });
    expect((await flow.callAs(reviewerId, "slp_await_answer", { questionId: reviewerQuestionId })).text).toContain("A-from-developer");
    expect((await flow.callAs(leadId, "slp_await_answer", { questionId: developerQuestionId })).text).toContain("A-from-reviewer");
  });

  it("hands a question to a recipient that is waiting on its own question instead of queueing mail", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", questionTiming: { waitWindowMs: 2_000 } });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    const developerWait = flow.callAs(leadId, "slp_ask", { toAgentId: reviewerId, question: "dev asks first" });
    await vi.waitFor(() => expect(flow.store.questions.listForRun(runId, 10)).toHaveLength(1));

    const reviewerAsk = flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "reviewer asks second" });
    // The developer's own call returns carrying the reviewer's question, so no prompt mail was needed.
    expect((await developerWait).text).toContain("reviewer asks second");
    expect(flow.mailTo(runId, leadId).some((queuedMail) => queuedMail.questionId !== null)).toBe(false);
    expect(flow.store.questions.listForRun(runId, 10).find((row) => row.question === "reviewer asks second")?.deliveredAt).not.toBeNull();
    await reviewerAsk;
  });

  it("records delivery once the mailbox actually prompts the recipient", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Is the schema final?" });
    const askedQuestion = onlyQuestion(flow, runId);
    expect(askedQuestion.deliveredAt).toBeNull();
    expect(flow.mailTo(runId, leadId).at(-1)).toMatchObject({ questionId: askedQuestion.questionId, awaitTool: null });

    await flow.deliverMail(runId);
    expect(flow.gateway.promptsTo(leadId).join("\n")).toContain("slp_answer");
    expect(flow.store.questions.require(askedQuestion.questionId).deliveredAt).not.toBeNull();
  });
});

describe("question expiry and late answers", () => {
  it("expires an unanswered question, tells the asker to proceed, and forwards a late answer", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Which locale format?" });
    const askedQuestion = onlyQuestion(flow, runId);

    flow.ctx.questionTiming.questionTtlMs = 0;
    await sweep(flow, runId);
    expect(flow.store.questions.require(askedQuestion.questionId)).toMatchObject({ status: "expired", expireReason: "timeout" });
    expect(flow.mailTo(runId, reviewerId).at(-1)?.text).toContain("assumption");
    // The never-delivered question must not reach the recipient after the asker was told to move on.
    expect(flow.mailTo(runId, leadId).some((queuedMail) => queuedMail.questionId === askedQuestion.questionId)).toBe(false);

    const lateAnswer = await flow.callAs(leadId, "slp_answer", { questionId: askedQuestion.questionId, answer: "ISO-8601 everywhere." });
    expect(lateAnswer.isError).toBe(false);
    expect(flow.store.questions.require(askedQuestion.questionId).status).toBe("answered_late");
    expect(flow.mailTo(runId, reviewerId).at(-1)?.text).toContain("after your question expired");
    expect(flow.mailTo(runId, reviewerId).at(-1)?.text).toContain("ISO-8601 everywhere.");
  });

  it("wakes a still-blocked asker with the expiry instead of mailing it", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", questionTiming: { waitWindowMs: 5_000 } });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    const blockedAsk = flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Anyone there?" });
    await vi.waitFor(() => expect(flow.store.questions.listForRun(runId, 10)).toHaveLength(1));

    flow.ctx.questionTiming.questionTtlMs = 0;
    await sweep(flow, runId);
    expect((await blockedAsk).text).toContain("expired");
    expect(flow.mailTo(runId, reviewerId).some((queuedMail) => queuedMail.text.includes("expired"))).toBe(false);
  });

  it("expires a question whose recipient disappeared without waiting for the full lifetime", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Still alive?" });
    flow.store.mutate(runId, (run) => { run.agents[leadId].archivedAt = new Date().toISOString(); });

    await sweep(flow, runId);
    expect(onlyQuestion(flow, runId)).toMatchObject({ status: "expired", expireReason: "recipient_unavailable" });
    expect(flow.mailTo(runId, reviewerId).at(-1)?.text).toContain("no longer available");
  });
});

describe("question reconciliation and reminders", () => {
  it("queues a question that never reached its recipient exactly once", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    // Simulates a lost wake-up or a reload between the ledger insert and the mail: the ledger row exists alone.
    const orphanQuestionId = randomUUID();
    flow.store.questions.insert({
      questionId: orphanQuestionId, runId, fromAgentId: reviewerId, toAgentId: leadId,
      scope: "stage", pipelineId: null, question: "orphaned question", createdAt: new Date().toISOString(),
    });

    await sweep(flow, runId);
    await sweep(flow, runId);
    const queuedForOrphan = flow.mailTo(runId, leadId).filter((queuedMail) => queuedMail.questionId === orphanQuestionId);
    expect(queuedForOrphan).toHaveLength(1);
    expect(queuedForOrphan[0].text).toContain("orphaned question");
  });

  it("queues an answer the asker never consumed", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Q?" });
    const askedQuestion = onlyQuestion(flow, runId);
    // The answer was stored while the asker's call was already gone, and its mail was lost with a reload.
    flow.store.questions.recordAnswer(askedQuestion.questionId, "A!", new Date().toISOString());
    flow.store.mutate(runId, (run) => { run.mailbox = run.mailbox.filter((queuedMail) => queuedMail.toAgentId !== reviewerId); });

    await sweep(flow, runId);
    await sweep(flow, runId);
    const answerMail = flow.mailTo(runId, reviewerId).filter((queuedMail) => queuedMail.questionId === askedQuestion.questionId);
    expect(answerMail).toHaveLength(1);
    expect(answerMail[0].text).toContain("A!");
    await flow.deliverMail(runId);
    expect(flow.store.questions.require(askedQuestion.questionId).answerDeliveredAt).not.toBeNull();
  });

  it("reminds an idle recipient a limited number of times, only while it is quiet", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Please decide." });
    const askedQuestion = onlyQuestion(flow, runId);
    await flow.deliverMail(runId);
    flow.ctx.questionTiming.reminderAfterMs = 0;

    const reminderCountAfterSweep = async () => {
      await sweep(flow, runId);
      await flow.deliverMail(runId);
      return flow.store.questions.require(askedQuestion.questionId).reminderCount;
    };
    expect(await reminderCountAfterSweep()).toBe(1);
    expect(await reminderCountAfterSweep()).toBe(2);
    // maxReminders is 2: a recipient that keeps ignoring the question is not nagged forever.
    expect(await reminderCountAfterSweep()).toBe(2);
    expect(flow.gateway.promptsTo(leadId).filter((promptText) => promptText.startsWith("Reminder:"))).toHaveLength(2);
  });

  it("does not remind a recipient that is still running its turn", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Busy?" });
    await flow.deliverMail(runId);
    flow.ctx.questionTiming.reminderAfterMs = 0;
    flow.gateway.setStatus(leadId, "running");
    sweepPeerQuestions(flow.ctx, runId, await flow.gateway.liveStatuses(runId));
    expect(onlyQuestion(flow, runId).reminderCount).toBe(0);
  });
});

describe("question rules", () => {
  it("rejects answers from the wrong agent, repeated answers and foreign awaits", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);
    await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "Q?" });
    const { questionId } = onlyQuestion(flow, runId);

    expect((await flow.callAs(reviewerId, "slp_answer", { questionId, answer: "self answer" })).text).toContain("another agent");
    expect((await flow.callAs(leadId, "slp_await_answer", { questionId })).text).toContain("Unknown question");
    expect((await flow.callAs(leadId, "slp_answer", { questionId: "missing", answer: "x" })).isError).toBe(true);
    expect((await flow.callAs(leadId, "slp_answer", { questionId, answer: "first" })).isError).toBe(false);
    expect((await flow.callAs(leadId, "slp_answer", { questionId, answer: "second" })).text).toContain("already answered");
    expect(flow.store.questions.require(questionId).answer).toBe("first");
  });

  it("uses the same recipient rules as notifications and caps open questions per asker", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", questionTiming: { waitWindowMs: 5 } });
    const { runId, reviewerId, leadId } = await reviewerAndLead(flow);

    const unknownRecipient = await flow.callAs(reviewerId, "slp_ask", { toAgentId: "missing-agent", question: "Anyone?" });
    expect(unknownRecipient.isError).toBe(true);
    expect(unknownRecipient.text).toContain("only contact their Lead");
    expect(flow.store.questions.listForRun(runId, 10)).toEqual([]);

    for (const questionNumber of [1, 2, 3]) {
      expect((await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: `Open question ${questionNumber}` })).isError).toBe(false);
    }
    const overLimit = await flow.callAs(reviewerId, "slp_ask", { toAgentId: leadId, question: "One too many" });
    expect(overLimit.isError).toBe(true);
    expect(overLimit.text).toContain("slp_await_answer");
    expect(flow.store.questions.listForRun(runId, 10)).toHaveLength(3);
  });

  it("keeps the Supervisor out of the question tools", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, leadId } = await reviewerAndLead(flow);
    const supervisorId = flow.run(runId).supervisorAgentId;
    const outcome = await flow.callAs(supervisorId, "slp_ask", { toAgentId: leadId, question: "Status?" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not available");
  });
});
