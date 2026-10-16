import { describe, expect, it } from "vitest";
import { abortRun } from "../server/pipeline/run-lifecycle";
import { tailCommLog } from "../server/store/comm-log";
import { useFlowFixture } from "./helpers/flow-fixture";
import { eventually } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

const ENQUEUE_NO_REPLY = { taskId: null, awaitTool: null, from: "test", summary: "s" };

async function runWithTwoAgents() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const runId = await flow.startRun();
  const { masterLeadAgentId, supervisorAgentId } = flow.run(runId);
  const flush = async () => flow.ctx.mailbox.flush(runId, await flow.gateway.liveStatuses(runId));
  return { flow, runId, masterLeadAgentId, supervisorAgentId, flush };
}

// a prompt to a running agent would cancel its active turn, so delivery waits for idle
describe("delivery rules", () => {
  it("does not deliver to a running agent and keeps the mail queued", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.gateway.setStatus(masterLeadAgentId, "running");
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "hello", ENQUEUE_NO_REPLY);

    expect(await flush()).toBe(0);
    expect(flow.gateway.prompts).toEqual([]);
    expect(flow.mailTo(runId, masterLeadAgentId)).toHaveLength(1);
  });

  it("delivers once the agent turned idle", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.gateway.setStatus(masterLeadAgentId, "running");
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "hello", ENQUEUE_NO_REPLY);
    await flush();
    flow.gateway.setStatus(masterLeadAgentId, "idle");

    expect(await flush()).toBe(1);
    expect(flow.gateway.promptsTo(masterLeadAgentId)).toEqual(["hello"]);
    expect(flow.mailTo(runId, masterLeadAgentId)).toEqual([]);
  });

  // one combined prompt starts one turn instead of several cancelling each other
  it("combines every queued message for an idle agent into one prompt, in order", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    for (const text of ["first", "second", "third"]) flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, text, ENQUEUE_NO_REPLY);

    expect(await flush()).toBe(1);
    expect(flow.gateway.promptsTo(masterLeadAgentId)).toEqual(["first\n\n---\n\nsecond\n\n---\n\nthird"]);
  });

  it("delivers to each idle recipient separately and skips the busy one", async () => {
    const { flow, runId, masterLeadAgentId, supervisorAgentId, flush } = await runWithTwoAgents();
    flow.gateway.setStatus(supervisorAgentId, "running");
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "for lead", ENQUEUE_NO_REPLY);
    flow.ctx.mailbox.enqueue(runId, supervisorAgentId, "for supervisor", ENQUEUE_NO_REPLY);

    expect(await flush()).toBe(1);
    expect(flow.gateway.promptsTo(masterLeadAgentId)).toEqual(["for lead"]);
    expect(flow.mailTo(runId, supervisorAgentId)).toHaveLength(1);
  });

  // answering a permission first avoids prompting a blocked agent
  it("holds mail for agents with a pending permission, archived agents and unknown agents", async () => {
    const { flow, runId, masterLeadAgentId, supervisorAgentId, flush } = await runWithTwoAgents();
    flow.gateway.setPendingPermissions(masterLeadAgentId, [{ id: "perm" }]);
    await flow.gateway.archive(supervisorAgentId);
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "a", ENQUEUE_NO_REPLY);
    flow.ctx.mailbox.enqueue(runId, supervisorAgentId, "b", ENQUEUE_NO_REPLY);
    flow.ctx.mailbox.enqueue(runId, "ghost-agent", "c", ENQUEUE_NO_REPLY);

    expect(await flush()).toBe(0);
    expect(flow.run(runId).mailbox).toHaveLength(3);
  });

  // closed agents resume on the next prompt, with their memory
  it("treats a closed (persisted) agent as reachable", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.gateway.setStatus(masterLeadAgentId, "closed");
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "wake up", ENQUEUE_NO_REPLY);
    expect(await flush()).toBe(1);
  });

  // the sweeper and a hook may race; double delivery would duplicate instructions
  it("does not run two flushes of the same run concurrently", async () => {
    const { flow, runId, masterLeadAgentId } = await runWithTwoAgents();
    let releaseSend: () => void = () => undefined;
    const sendBlocked = new Promise<void>((resolve) => { releaseSend = resolve; });
    const originalPrompt = flow.gateway.prompt.bind(flow.gateway);
    flow.gateway.prompt = async (agentId, text) => {
      await sendBlocked;
      return originalPrompt(agentId, text);
    };
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "once", ENQUEUE_NO_REPLY);
    const statuses = await flow.gateway.liveStatuses(runId);

    const firstFlush = flow.ctx.mailbox.flush(runId, statuses);
    // the sweeper arriving while the first send is in flight must not double deliver
    expect(await flow.ctx.mailbox.flush(runId, statuses)).toBe(0);
    releaseSend();
    expect(await firstFlush).toBe(1);
    expect(flow.gateway.promptsTo(masterLeadAgentId)).toEqual(["once"]);
  });
});

// awaitingTool/awaitingSince drive nudging
describe("owed tool bookkeeping", () => {
  it("stamps the recipient with the last owed tool, the send time and a reset nudge counter", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.store.mutate(runId, (run) => {
      run.agents[masterLeadAgentId].nudges = 2;
    });
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "a", { ...ENQUEUE_NO_REPLY, awaitTool: "slp_define_tasks" });
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "b", { ...ENQUEUE_NO_REPLY, awaitTool: "slp_report" });
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "c", ENQUEUE_NO_REPLY);
    const before = new Date().toISOString();
    await flush();

    const record = flow.run(runId).agents[masterLeadAgentId];
    expect(record.awaitingTool).toBe("slp_report");
    expect(record.awaitingSince! >= before).toBe(true);
    expect(record.nudges).toBe(0);
  });

  // information-only mail must not erase an obligation the agent still has to fulfil
  it("keeps the owed tool when the delivered mail expects no reply", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.store.mutate(runId, (run) => {
      run.agents[masterLeadAgentId].awaitingTool = "slp_report";
      run.agents[masterLeadAgentId].awaitingSince = "2020-01-01T00:00:00.000Z";
    });
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "fyi", ENQUEUE_NO_REPLY);
    await flush();
    expect(flow.run(runId).agents[masterLeadAgentId]).toMatchObject({ awaitingTool: "slp_report", awaitingSince: "2020-01-01T00:00:00.000Z" });
  });
});

// a failed prompt must never lose instructions
describe("failed sends", () => {
  it("puts the mail back at the front of the queue when prompt() throws", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "old-1", ENQUEUE_NO_REPLY);
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "old-2", ENQUEUE_NO_REPLY);
    flow.gateway.failNextPrompt = true;

    expect(await flush()).toBe(0);
    expect(flow.mailTo(runId, masterLeadAgentId).map((message) => message.text)).toEqual(["old-1", "old-2"]);
    // mail enqueued after the failure stays behind the re-queued messages
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "new", ENQUEUE_NO_REPLY);
    expect(flow.mailTo(runId, masterLeadAgentId).map((message) => message.text)).toEqual(["old-1", "old-2", "new"]);
  });

  // retry is the whole point of re-queuing
  it("delivers the re-queued mail on the next sweep", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "retry me", ENQUEUE_NO_REPLY);
    flow.gateway.failNextPrompt = true;
    await flush();
    flow.gateway.setStatus(masterLeadAgentId, "idle");

    expect(await flush()).toBe(1);
    expect(flow.gateway.promptsTo(masterLeadAgentId)).toEqual(["retry me"]);
    expect(flow.mailTo(runId, masterLeadAgentId)).toEqual([]);
  });

  // one unreachable agent must not starve the rest of the run
  it("does not block other recipients when one send fails", async () => {
    const { flow, runId, masterLeadAgentId, supervisorAgentId, flush } = await runWithTwoAgents();
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "x", ENQUEUE_NO_REPLY);
    flow.ctx.mailbox.enqueue(runId, supervisorAgentId, "y", ENQUEUE_NO_REPLY);
    flow.gateway.failNextPrompt = true;

    expect(await flush()).toBe(1);
    expect(flow.run(runId).mailbox).toHaveLength(1);
  });

  it("writes queued, delivered and failed events to the comm log", async () => {
    const { flow, runId, masterLeadAgentId, flush } = await runWithTwoAgents();
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "x", ENQUEUE_NO_REPLY);
    flow.gateway.failNextPrompt = true;
    await flush();
    flow.gateway.setStatus(masterLeadAgentId, "idle");
    await flush();

    await eventually(async () => {
      const mailOutcomes = (await tailCommLog(flow.repoPath, runId, 100)).filter((entry) => entry.kind === "mail").map((entry) => entry.outcome);
      // appends are fire-and-forget, so file order is not guaranteed; compare as a set
      if (mailOutcomes.sort().join() !== "delivered,error,queued") throw new Error(`got ${mailOutcomes.join()}`);
    });
  });
});

// an aborted run must not keep waking agents
describe("abortRun", () => {
  it("archives every agent, drops queued mail and marks the run aborted", async () => {
    const { flow, runId, masterLeadAgentId, supervisorAgentId } = await runWithTwoAgents();
    flow.ctx.mailbox.enqueue(runId, masterLeadAgentId, "never delivered", ENQUEUE_NO_REPLY);
    await abortRun(flow.ctx, runId);

    expect(flow.run(runId)).toMatchObject({ status: "aborted", mailbox: [] });
    expect(flow.gateway.archivedAgentIds.sort()).toEqual([masterLeadAgentId, supervisorAgentId].sort());
  });
});
