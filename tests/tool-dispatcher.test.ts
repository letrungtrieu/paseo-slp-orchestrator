import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusCaller } from "../server/bus/http-mcp";
import type { PipelineContext } from "../server/pipeline/context";
import { createBusDispatcher } from "../server/pipeline/tool-handlers";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun, buildTask } from "./helpers/run-factory";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createTemporaryDirectory = useTemporaryDirectories();

const LONG_CRITERIA = "Billing must support invoices, refunds and tests.";

let store: RunStore;
let enqueueMail: ReturnType<typeof vi.fn>;
let logEvent: ReturnType<typeof vi.fn>;
let dispatcher: ReturnType<typeof createBusDispatcher>;

function callerFor(agentId: string): BusCaller {
  const lookup = store.findAgent(agentId)!;
  return { runId: lookup.run.id, agentId, role: lookup.agentRecord.role, taskId: lookup.agentRecord.taskId };
}

beforeEach(async () => {
  const stateDirectory = await createTemporaryDirectory("dispatcher");
  store = new RunStore(`${stateDirectory}/state.json`);
  store.insert(
    buildRun({
      supervisorAgentId: "sup-agent-1",
      masterLeadAgentId: "lead-agent-1",
      status: "delegating",
      tasks: { t1: buildTask({ id: "t1", phase: "implementing" }) },
      agents: {
        "sup-agent-1": buildAgentRecord({ agentId: "sup-agent-1", role: "supervisor", token: "tok-sup", awaitingTool: "slp_delegate", awaitingSince: "2026-01-01T00:00:00.000Z" }),
        "lead-agent-1": buildAgentRecord({ agentId: "lead-agent-1", role: "master_lead", token: "tok-lead" }),
        "impl-agent-1": buildAgentRecord({ agentId: "impl-agent-1", role: "implementer", taskId: "t1", token: "tok-impl" }),
        "qa-agent-1": buildAgentRecord({ agentId: "qa-agent-1", role: "qa", taskId: "t1", token: "tok-qa" }),
      },
    }),
  );
  enqueueMail = vi.fn();
  logEvent = vi.fn();
  // only the collaborators the exercised tools touch are faked; the rest stays absent on purpose
  const fakeContext = { store, mailbox: { enqueue: enqueueMail }, logEvent, continuations: {} } as unknown as PipelineContext;
  dispatcher = createBusDispatcher(fakeContext);
});

afterEach(async () => {
  await store.flush();
});

// authentication of bus callers
describe("resolveCaller", () => {
  it("maps a token to the caller's run, agent, role and task", () => {
    expect(dispatcher.resolveCaller("tok-impl")).toEqual({ runId: "run-1", agentId: "impl-agent-1", role: "implementer", taskId: "t1" });
  });

  it("returns null for an unknown token", () => {
    expect(dispatcher.resolveCaller("nope")).toBeNull();
  });
});

describe("dispatch rejections", () => {
  // spec 2.1: each agent may only call its own tools, even if it guesses the name
  it("blocks a tool outside the caller's role and does not run the handler", async () => {
    const dispatchOutcome = await dispatcher.dispatch(callerFor("impl-agent-1"), "slp_delegate", { acceptanceCriteria: LONG_CRITERIA });
    expect(dispatchOutcome).toEqual({ isError: true, text: "Tool 'slp_delegate' is not available to your role." });
    // the handler would have queued mail to the master lead
    expect(enqueueMail).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ kind: "slp_delegate", outcome: "blocked", reason: "role implementer may not call slp_delegate" }));
  });

  // unknown names must not reach any handler
  it("blocks an unknown tool name", async () => {
    const dispatchOutcome = await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_format_disk", {});
    expect(dispatchOutcome).toMatchObject({ isError: true, text: "Unknown tool 'slp_format_disk'." });
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ outcome: "blocked", reason: "unknown tool" }));
  });

  it("blocks invalid arguments with the schema message", async () => {
    // criteria shorter than 20 characters violate the tool schema
    const dispatchOutcome = await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", { acceptanceCriteria: "short" });
    expect(dispatchOutcome.isError).toBe(true);
    expect(dispatchOutcome.text).toContain("Invalid arguments");
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ outcome: "blocked", reason: "invalid arguments" }));
  });

  // MCP clients may omit arguments entirely
  it("treats missing arguments as an empty object and fails validation instead of crashing", async () => {
    const dispatchOutcome = await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", undefined);
    expect(dispatchOutcome.text).toContain("Invalid arguments");
  });

  it("maps a ToolError to a blocked outcome", async () => {
    // a task-less caller using a task-only tool raises ToolError("only available to task peers")
    const taskLessImplementer: BusCaller = { runId: "run-1", agentId: "impl-agent-1", role: "implementer", taskId: null };
    const dispatchOutcome = await dispatcher.dispatch(taskLessImplementer, "slp_stage_done", { summary: "x" });
    expect(dispatchOutcome).toEqual({ isError: true, text: "This tool is only available to task peers." });
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ outcome: "blocked", reason: "This tool is only available to task peers." }));
  });

  it("maps a non-ToolError failure to an error outcome", async () => {
    // an unknown task id makes requireTask throw a plain Error, i.e. a pipeline fault
    const dispatchOutcome = await dispatcher.dispatch(callerFor("lead-agent-1"), "slp_archive_task", { taskId: "ghost" });
    expect(dispatchOutcome.isError).toBe(true);
    expect(dispatchOutcome.text).toContain("Unknown task 'ghost'");
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ outcome: "error" }));
  });

  it("reports a ToolError raised deep inside a handler as blocked, with the handler's text", async () => {
    // the task is 'implementing', so archiving is refused with a ToolError
    const dispatchOutcome = await dispatcher.dispatch(callerFor("lead-agent-1"), "slp_archive_task", { taskId: "t1" });
    expect(dispatchOutcome.text).toContain("not ready_for_merge");
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ outcome: "blocked" }));
  });
});

describe("dispatch success and bookkeeping", () => {
  it("runs the handler and returns its text", async () => {
    const dispatchOutcome = await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", { acceptanceCriteria: LONG_CRITERIA });
    expect(dispatchOutcome.isError).toBe(false);
    expect(dispatchOutcome.text).toContain("Delegated to the Master Lead");
    expect(enqueueMail).toHaveBeenCalledTimes(1);
    expect(store.require("run-1")).toMatchObject({ criteria: LONG_CRITERIA, status: "planning" });
  });

  // this is what stops the nudge loop for an agent that did its job
  it("clears awaitingTool once the owed tool succeeds", async () => {
    await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", { acceptanceCriteria: LONG_CRITERIA });
    expect(store.require("run-1").agents["sup-agent-1"].awaitingTool).toBeNull();
  });

  it("keeps awaitingTool when a different tool is called", async () => {
    store.mutate("run-1", (run) => {
      run.agents["qa-agent-1"].awaitingTool = "slp_verdict";
    });
    // slp_ask_sibling is allowed for qa but is not the owed tool; it fails on the unknown task, which is fine here
    await dispatcher.dispatch(callerFor("qa-agent-1"), "slp_ask_sibling", { taskId: "ghost", question: "?" });
    expect(store.require("run-1").agents["qa-agent-1"].awaitingTool).toBe("slp_verdict");
  });

  it("keeps awaitingTool when the owed tool itself fails", async () => {
    // the agent still owes a valid call, so nudging must continue
    await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", { acceptanceCriteria: "short" });
    expect(store.require("run-1").agents["sup-agent-1"].awaitingTool).toBe("slp_delegate");
  });

  it("logs every call exactly once with caller, tool, outcome and duration", async () => {
    await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", { acceptanceCriteria: LONG_CRITERIA });
    await dispatcher.dispatch(callerFor("impl-agent-1"), "slp_delegate", {});
    await dispatcher.dispatch(callerFor("sup-agent-1"), "nope", {});
    await dispatcher.dispatch(callerFor("lead-agent-1"), "slp_archive_task", { taskId: "ghost" });
    expect(logEvent).toHaveBeenCalledTimes(4);
    expect(logEvent.mock.calls.map(([, entry]) => entry.outcome)).toEqual(["delivered", "blocked", "blocked", "error"]);
    const [, firstEntry] = logEvent.mock.calls[0];
    expect(firstEntry).toMatchObject({ from: "supervisor:sup-agen", to: "pipeline", kind: "slp_delegate", taskId: null });
    expect(typeof firstEntry.durationMs).toBe("number");
    expect(firstEntry.summary).toContain("slp_delegate");
  });

  // the audit log must stay readable and small
  it("truncates very long arguments in the log summary", async () => {
    await dispatcher.dispatch(callerFor("sup-agent-1"), "slp_delegate", { acceptanceCriteria: "x".repeat(1000) });
    const [, loggedEntry] = logEvent.mock.calls[0];
    // 240 characters of arguments plus the tool name and an ellipsis
    expect(loggedEntry.summary.length).toBeLessThan(300);
    expect(loggedEntry.summary.endsWith("…")).toBe(true);
  });

  it("passes the task id of a task peer into the log entry", async () => {
    await dispatcher.dispatch(callerFor("impl-agent-1"), "slp_delegate", {});
    expect(logEvent).toHaveBeenCalledWith("run-1", expect.objectContaining({ taskId: "t1" }));
  });
});
