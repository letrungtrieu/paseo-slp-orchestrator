import { describe, expect, it } from "vitest";
import { FIX_LOOP_LIMIT, type RunMode } from "../shared/roles";
import type { GateKind } from "../shared/state";
import { approveGate } from "../server/pipeline/gates";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  API_TASK, approveHandshake, approveVerification, driveToReadyForMerge, eventually, finishImplementation,
  startedRunWithTasks, waitForPhase, COMPLETE_ACCEPTANCE_REPORT,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();
const TASK_ID = API_TASK.id;

async function runWithOneTask(mode: RunMode) {
  const flow = await createFlow({ mode });
  const runId = await startedRunWithTasks(flow, [API_TASK]);
  const gateOf = () => flow.task(runId, TASK_ID).gate;
  const implementerMails = () => flow.mailTo(runId, flow.task(runId, TASK_ID).agentIds.implementer);
  const masterMails = () => flow.mailTo(runId, flow.run(runId).masterLeadAgentId);
  return { flow, runId, gateOf, implementerMails, masterMails };
}

// spec section 5: the three modes differ only in where they stop
describe("which gates open per mode", () => {
  const EXPECTED_GATES: Record<RunMode, GateKind[]> = {
    STEP_BY_STEP_DEBUG: ["after_handshake", "after_implementation", "after_verification", "before_merge"],
    SEMI_AUTO: ["before_merge"],
    FULL_AUTO: [],
  };

  for (const [mode, expectedGateKinds] of Object.entries(EXPECTED_GATES) as Array<[RunMode, GateKind[]]>) {
    it(`${mode} stops at ${expectedGateKinds.join(", ") || "no task gate"} on the happy path`, async () => {
      const { flow, runId } = await runWithOneTask(mode);
      const openedGateKinds: GateKind[] = [];
      await driveToReadyForMerge(flow, runId, TASK_ID, (gateKind) => openedGateKinds.push(gateKind));
      expect(openedGateKinds).toEqual(expectedGateKinds);
    });
  }
});

describe("STEP_BY_STEP_DEBUG: each approval resumes exactly its own step", () => {
  // the handshake is complete but coding must wait for the human
  it("after_handshake: waits with the plan approved, then unlocks implementation only", async () => {
    const { flow, runId, gateOf, implementerMails, masterMails } = await runWithOneTask("STEP_BY_STEP_DEBUG");
    await approveHandshake(flow, runId, TASK_ID);

    expect(gateOf()).toMatchObject({ kind: "after_handshake" });
    expect(gateOf()!.note).toContain(`[${TASK_ID}]`);
    // the handshake itself is finished (forked lead retired, master briefed) but coding is not unlocked
    expect(flow.task(runId, TASK_ID).phase).toBe("handshaking");
    expect(flow.task(runId, TASK_ID).agentIds.forked_lead).toBeUndefined();
    expect(masterMails().some((message) => message.text.includes("handshake finished"))).toBe(true);
    expect(implementerMails().some((message) => message.awaitTool === "slp_stage_done")).toBe(false);

    const approval = await approveGate(flow.ctx, runId, TASK_ID);
    expect(approval).toBe("Gate after_handshake approved");
    expect(gateOf()).toBeNull();
    expect(flow.task(runId, TASK_ID).phase).toBe("implementing");
    expect(implementerMails().some((message) => message.awaitTool === "slp_stage_done")).toBe(true);
    expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(0);
  });

  // the human may inspect the worktree before reviewers start
  it("after_implementation: accepts the stage but holds the reviewers back", async () => {
    const { flow, runId, gateOf } = await runWithOneTask("STEP_BY_STEP_DEBUG");
    await approveHandshake(flow, runId, TASK_ID);
    await approveGate(flow.ctx, runId, TASK_ID);
    await finishImplementation(flow, runId, TASK_ID);

    expect(gateOf()).toMatchObject({ kind: "after_implementation" });
    expect(flow.task(runId, TASK_ID).phase).toBe("verifying");
    expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(0);
    expect(flow.gateway.createdAgentsOfRole("security")).toHaveLength(0);

    await approveGate(flow.ctx, runId, TASK_ID);
    await eventually(() => expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(1));
    expect(flow.gateway.createdAgentsOfRole("security")).toHaveLength(1);
    expect(gateOf()).toBeNull();
  });

  // the human sees the QA/Security outcome before documentation
  it("after_verification: holds the documentation until approved", async () => {
    const { flow, runId, gateOf, implementerMails } = await runWithOneTask("STEP_BY_STEP_DEBUG");
    await approveHandshake(flow, runId, TASK_ID);
    await approveGate(flow.ctx, runId, TASK_ID);
    await finishImplementation(flow, runId, TASK_ID);
    await approveGate(flow.ctx, runId, TASK_ID);
    await approveVerification(flow, runId, TASK_ID);

    await eventually(() => expect(gateOf()).toMatchObject({ kind: "after_verification" }));
    expect(flow.task(runId, TASK_ID).phase).toBe("verifying");
    expect(implementerMails().some((message) => message.awaitTool === "slp_doc_done")).toBe(false);

    await approveGate(flow.ctx, runId, TASK_ID);
    expect(flow.task(runId, TASK_ID).phase).toBe("documenting");
    expect(implementerMails().some((message) => message.awaitTool === "slp_doc_done")).toBe(true);
  });

  // SEMI_AUTO also stops here: last look before the Lead merges
  it("before_merge: marks the task ready but only tells the master lead once approved", async () => {
    const { flow, runId, gateOf, masterMails } = await runWithOneTask("STEP_BY_STEP_DEBUG");
    await approveHandshake(flow, runId, TASK_ID);
    await approveGate(flow.ctx, runId, TASK_ID);
    await finishImplementation(flow, runId, TASK_ID);
    await approveGate(flow.ctx, runId, TASK_ID);
    await approveVerification(flow, runId, TASK_ID);
    await eventually(() => expect(gateOf()).toMatchObject({ kind: "after_verification" }));
    await approveGate(flow.ctx, runId, TASK_ID);
    // The merge gate opens only after the acceptance report has been saved through the tool.
    await flow.callAsRole(runId, "implementer", TASK_ID, "slp_doc_done", { report: COMPLETE_ACCEPTANCE_REPORT });

    expect(flow.task(runId, TASK_ID).phase).toBe("ready_for_merge");
    expect(gateOf()).toMatchObject({ kind: "before_merge" });
    expect(masterMails().some((message) => message.text.includes("READY FOR MERGE"))).toBe(false);

    await approveGate(flow.ctx, runId, TASK_ID);
    expect(masterMails().some((message) => message.awaitTool === "slp_archive_task")).toBe(true);
  });

  it("publishes the gate note on the progress card", async () => {
    const { flow, runId } = await runWithOneTask("STEP_BY_STEP_DEBUG");
    await approveHandshake(flow, runId, TASK_ID);
    await eventually(() => {
      const latestCard = flow.paseo.cardsForTask(TASK_ID).at(-1) as { gateNote: string | null } | undefined;
      if (!latestCard?.gateNote?.includes("Handshake finished")) throw new Error("card has no gate note yet");
    });
  });

  it("refuses to approve when nothing is waiting", async () => {
    const { flow, runId } = await runWithOneTask("STEP_BY_STEP_DEBUG");
    await expect(approveGate(flow.ctx, runId, TASK_ID)).rejects.toThrow(/no open gate/);
    await expect(approveGate(flow.ctx, runId, null)).rejects.toThrow(/no open gate/);
  });
});

// tripped breakers need a human in every mode except FULL_AUTO
describe("circuit_breaker gate", () => {
  // reject FIX_LOOP_LIMIT + 1 rounds, approving earlier gates on the way
  async function trippedBreaker(mode: RunMode) {
    const setup = await runWithOneTask(mode);
    const { flow, runId } = setup;
    await approveHandshake(flow, runId, TASK_ID);
    await eventually(() => undefined);
    if (setup.gateOf()) await approveGate(flow.ctx, runId, TASK_ID);
    await waitForPhase(flow, runId, TASK_ID, "implementing");
    await finishImplementation(flow, runId, TASK_ID);
    if (setup.gateOf()) await approveGate(flow.ctx, runId, TASK_ID);
    await eventually(() => flow.agentId(runId, "qa", TASK_ID));
    for (let round = 1; round <= FIX_LOOP_LIMIT + 1; round += 1) {
      await flow.callAsRole(runId, "qa", TASK_ID, "slp_verdict", { verdict: "REJECTED", issues: [`bug ${round}`] });
      await flow.callAsRole(runId, "security", TASK_ID, "slp_verdict", { verdict: "APPROVED" });
      await waitForPhase(flow, runId, TASK_ID, round > FIX_LOOP_LIMIT ? "paused" : "fixing");
      if (round <= FIX_LOOP_LIMIT) {
        await flow.callAsRole(runId, "implementer", TASK_ID, "slp_stage_done", { summary: "fix" });
        await eventually(() => expect(flow.task(runId, TASK_ID).phase).toBe("verifying"));
      }
    }
    return setup;
  }

  it("opens in SEMI_AUTO and resumes the task with a fresh budget on approval", async () => {
    const { flow, runId, gateOf } = await trippedBreaker("SEMI_AUTO");
    expect(gateOf()).toMatchObject({ kind: "circuit_breaker" });

    await approveGate(flow.ctx, runId, TASK_ID);
    expect(flow.task(runId, TASK_ID)).toMatchObject({ phase: "fixing", fixLoopCount: 0, gate: null });
  });

  it("opens in STEP_BY_STEP_DEBUG too", async () => {
    const { gateOf } = await trippedBreaker("STEP_BY_STEP_DEBUG");
    expect(gateOf()).toMatchObject({ kind: "circuit_breaker" });
  });

  it("does not open in FULL_AUTO: the master lead alone decides", async () => {
    const { gateOf, flow, runId } = await trippedBreaker("FULL_AUTO");
    expect(gateOf()).toBeNull();
    expect(flow.task(runId, TASK_ID).phase).toBe("paused");
    expect(flow.mailTo(runId, flow.run(runId).masterLeadAgentId).some((message) => message.text.includes("CIRCUIT BREAKER"))).toBe(true);
  });
});
