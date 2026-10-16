import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { API_TASK, UI_TASK, approveHandshake, startedRunWithTasks, waitForPhase } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

async function twoTaskRun() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await startedRunWithTasks(flow, [API_TASK, UI_TASK]);
  const implementerOf = (taskId: string) => flow.task(runId, taskId).agentIds.implementer;
  const masterLeadId = flow.run(runId).masterLeadAgentId;
  const questionIdFrom = (callText: string) => /Question (\w+)/.exec(callText)![1];
  return { flow, runId, implementerOf, masterLeadId, questionIdFrom };
}

// spec phase 4: the Lead asks the idle Implementer that still remembers its code
describe("slp_consult_peer (Master Lead -> Implementer)", () => {
  it("queues the question for the task's implementer who owes slp_answer", async () => {
    const { flow, runId, implementerOf } = await twoTaskRun();
    const consult = await flow.callAsRole(runId, "master_lead", null, "slp_consult_peer", { taskId: API_TASK.id, question: "why a retry loop here?" });

    expect(consult.isError).toBe(false);
    const questionId = /Question (\w+)/.exec(consult.text)![1];
    const [questionMail] = flow.mailTo(runId, implementerOf(API_TASK.id));
    expect(questionMail.awaitTool).toBe("slp_answer");
    expect(questionMail.text).toContain("why a retry loop here?");
    expect(questionMail.text).toContain(`questionId "${questionId}"`);
    expect(flow.run(runId).questions).toEqual([
      expect.objectContaining({ id: questionId, kind: "consult", toAgentId: implementerOf(API_TASK.id), taskId: API_TASK.id, answer: null }),
    ]);
  });

  it("routes the implementer's answer back to the master lead", async () => {
    const { flow, runId, implementerOf, masterLeadId, questionIdFrom } = await twoTaskRun();
    const consult = await flow.callAsRole(runId, "master_lead", null, "slp_consult_peer", { taskId: API_TASK.id, question: "why?" });
    const questionId = questionIdFrom(consult.text);

    const answer = await flow.callAs(implementerOf(API_TASK.id), "slp_answer", { questionId, answer: "idempotency on timeouts" });

    expect(answer.isError).toBe(false);
    expect(flow.run(runId).questions[0].answer).toBe("idempotency on timeouts");
    const answerMail = flow.mailTo(runId, masterLeadId).at(-1)!;
    expect(answerMail.text).toContain("idempotency on timeouts");
    expect(answerMail.awaitTool).toBeNull();
  });

  // archived tasks have no peer to wake
  it("refuses to consult a task without an implementer (already archived)", async () => {
    const { flow, runId } = await twoTaskRun();
    flow.store.mutate(runId, (run) => {
      run.tasks[API_TASK.id].agentIds = {};
    });
    const consult = await flow.callAsRole(runId, "master_lead", null, "slp_consult_peer", { taskId: API_TASK.id, question: "?" });
    expect(consult.text).toContain("has no Implementer to ask");
  });

  it("fails clearly for an unknown task id", async () => {
    const { flow, runId } = await twoTaskRun();
    const consult = await flow.callAsRole(runId, "master_lead", null, "slp_consult_peer", { taskId: "ghost", question: "?" });
    expect(consult).toMatchObject({ isError: true });
    expect(consult.text).toContain("Unknown task 'ghost'");
  });
});

// spec section 4, rule 1: cross-worktree traffic is read-only
describe("slp_ask_sibling (worktree A -> worktree B)", () => {
  it("wraps the question in a read-only instruction before it reaches the other worktree", async () => {
    const { flow, runId, implementerOf } = await twoTaskRun();
    const query = await flow.callAs(implementerOf(API_TASK.id), "slp_ask_sibling", { taskId: UI_TASK.id, question: "what does renderTotal() return?" });

    expect(query.isError).toBe(false);
    const [siblingMail] = flow.mailTo(runId, implementerOf(UI_TASK.id));
    expect(siblingMail.awaitTool).toBe("slp_answer");
    expect(siblingMail.text).toContain("what does renderTotal() return?");
    expect(siblingMail.text).toContain(`task "${API_TASK.id}"`);
    // spec section 4, rule 1: facts only, no code changes, no design agreements
    expect(siblingMail.text).toContain("Answer ONLY with facts about the current code");
    expect(siblingMail.text).toContain("must not change code");
    expect(flow.run(runId).questions[0]).toMatchObject({ kind: "sibling", fromAgentId: implementerOf(API_TASK.id), taskId: UI_TASK.id });
  });

  it("returns the answer to the asking agent", async () => {
    const { flow, runId, implementerOf, questionIdFrom } = await twoTaskRun();
    const query = await flow.callAs(implementerOf(API_TASK.id), "slp_ask_sibling", { taskId: UI_TASK.id, question: "q" });
    await flow.callAs(implementerOf(UI_TASK.id), "slp_answer", { questionId: questionIdFrom(query.text), answer: "a number" });
    expect(flow.mailTo(runId, implementerOf(API_TASK.id)).at(-1)!.text).toContain("a number");
  });

  // asking oneself would just burn a turn
  it("rejects a query to the asker's own task", async () => {
    const { flow, runId, implementerOf } = await twoTaskRun();
    const query = await flow.callAs(implementerOf(API_TASK.id), "slp_ask_sibling", { taskId: API_TASK.id, question: "q" });
    expect(query).toMatchObject({ isError: true });
    expect(query.text).toContain("own task");
    expect(flow.run(runId).questions).toEqual([]);
  });

  it("lets verifiers of one task query another task too", async () => {
    const { flow, runId, implementerOf } = await twoTaskRun();
    flow.store.mutate(runId, (run) => {
      // This legacy-style reviewer has no project profile or additional write grant.
      run.agents["qa-x"] = { agentId: "qa-x", role: "qa", projectRole: null, writeScope: [], leadContinuationTool: null, taskId: API_TASK.id, token: "t-qa", awaitingTool: null, awaitingSince: null, nudges: 0, createdAt: new Date().toISOString() };
    });
    const query = await flow.callAs("qa-x", "slp_ask_sibling", { taskId: UI_TASK.id, question: "q" });
    expect(query.isError).toBe(false);
    expect(flow.mailTo(runId, implementerOf(UI_TASK.id))).toHaveLength(1);
  });

  it("is not available to the master lead or the supervisor", async () => {
    const { flow, runId } = await twoTaskRun();
    for (const role of ["master_lead", "supervisor"] as const) {
      const query = await flow.callAsRole(runId, role, null, "slp_ask_sibling", { taskId: API_TASK.id, question: "q" });
      expect(query.text).toContain("not available to your role");
    }
  });
});

// answers must come from the addressed agent only
describe("slp_answer authorisation", () => {
  it("rejects an answer from an agent the question was not addressed to", async () => {
    const { flow, runId, implementerOf, questionIdFrom } = await twoTaskRun();
    const consult = await flow.callAsRole(runId, "master_lead", null, "slp_consult_peer", { taskId: API_TASK.id, question: "q" });
    const hijack = await flow.callAs(implementerOf(UI_TASK.id), "slp_answer", { questionId: questionIdFrom(consult.text), answer: "I will answer for them" });

    expect(hijack).toMatchObject({ isError: true });
    expect(hijack.text).toContain("not addressed to you");
    expect(flow.run(runId).questions[0].answer).toBeNull();
  });

  it("rejects an answer to an unknown question", async () => {
    const { flow, implementerOf, runId } = await twoTaskRun();
    expect(await flow.callAs(implementerOf(API_TASK.id), "slp_answer", { questionId: "nope", answer: "a" })).toMatchObject({ isError: true, text: "Unknown question 'nope'." });
    expect(flow.run(runId).questions).toEqual([]);
  });

  // the first answer is final so replies cannot be rewritten
  it("rejects a second answer to the same question", async () => {
    const { flow, runId, implementerOf, questionIdFrom } = await twoTaskRun();
    const consult = await flow.callAsRole(runId, "master_lead", null, "slp_consult_peer", { taskId: API_TASK.id, question: "q" });
    const questionId = questionIdFrom(consult.text);
    await flow.callAs(implementerOf(API_TASK.id), "slp_answer", { questionId, answer: "first" });
    const secondAnswer = await flow.callAs(implementerOf(API_TASK.id), "slp_answer", { questionId, answer: "second" });
    expect(secondAnswer.text).toContain("already answered");
    expect(flow.run(runId).questions[0].answer).toBe("first");
  });

  it("does not let the asker answer their own question", async () => {
    const { flow, runId, implementerOf, questionIdFrom } = await twoTaskRun();
    const query = await flow.callAs(implementerOf(API_TASK.id), "slp_ask_sibling", { taskId: UI_TASK.id, question: "q" });
    const selfAnswer = await flow.callAs(implementerOf(API_TASK.id), "slp_answer", { questionId: questionIdFrom(query.text), answer: "me" });
    expect(selfAnswer.text).toContain("not addressed to you");
    expect(flow.run(runId).questions[0].answer).toBeNull();
  });
});

// spec section 4, rule 2: contract disputes are never settled between peers
describe("slp_escalate (contract escalation)", () => {
  it("pauses the task and mails the master lead from any task peer", async () => {
    const { flow, runId, implementerOf, masterLeadId } = await twoTaskRun();
    await approveHandshake(flow, runId, API_TASK.id);
    await waitForPhase(flow, runId, API_TASK.id, "implementing");
    const escalation = await flow.callAs(implementerOf(API_TASK.id), "slp_escalate", { reason: "DB schema in TASK_SPEC conflicts with the UI task" });

    expect(escalation.isError).toBe(false);
    expect(flow.task(runId, API_TASK.id)).toMatchObject({ phase: "paused", pausedFromPhase: "implementing" });
    const [escalationMail] = flow.mailTo(runId, masterLeadId).filter((message) => message.text.includes("ESCALATION"));
    expect(escalationMail.text).toContain("DB schema in TASK_SPEC conflicts with the UI task");
    expect(escalationMail.awaitTool).toBe("slp_spec_decision");
    expect(flow.task(runId, UI_TASK.id).phase).toBe("handshaking");
  });

  it("resumes an implementing task at the right step after the master lead's decision", async () => {
    const { flow, runId, implementerOf } = await twoTaskRun();
    await approveHandshake(flow, runId, API_TASK.id);
    await waitForPhase(flow, runId, API_TASK.id, "implementing");
    await flow.callAs(implementerOf(API_TASK.id), "slp_escalate", { reason: "contract mismatch" });
    await flow.callAsRole(runId, "master_lead", null, "slp_spec_decision", { taskId: API_TASK.id, decision: "UI adapts, API stays" });

    expect(flow.task(runId, API_TASK.id).phase).toBe("implementing");
    const resumeMail = flow.mailTo(runId, implementerOf(API_TASK.id)).at(-1)!;
    expect(resumeMail).toMatchObject({ awaitTool: "slp_stage_done" });
    expect(resumeMail.text).toContain("UI adapts, API stays");
  });

  it("is not available to the master lead", async () => {
    const { flow, runId } = await twoTaskRun();
    const escalation = await flow.callAsRole(runId, "master_lead", null, "slp_escalate", { reason: "x" });
    expect(escalation.text).toContain("not available to your role");
  });
});
