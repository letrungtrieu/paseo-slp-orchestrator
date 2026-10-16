import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectPrompts } from "../server/project-prompts/load";
import { RunStore } from "../server/store/run-store";
import { reviewerAgentKey } from "../server/pipeline/peer-assignments";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import { API_TASK, approveHandshake, driveToReadyForMerge, startedRunWithTasks, waitForPhase } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

async function addProjectRole(flow: Flow, name: string) {
  await loadProjectPrompts(flow.repoPath);
  await writeFile(join(flow.repoPath, `.slp/peers/${name}.md`),
    `---\nrole: ${name}\ndescription: Project-specific ${name} expertise.\n---\nInspect the task and apply ${name} project conventions.`);
}

describe("Lead-selected project role assignments", () => {
  it("uses custom primary, reviewer and report-author workflows through a complete task", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    for (const roleName of ["Frontend", "Performance", "Writer"]) await addProjectRole(flow, roleName);
    const runId = await startedRunWithTasks(flow, [{ ...API_TASK, implementerRole: "frontend",
      verifiers: ["performance"], reviewerPermissions: { performance: "tests" }, documentedBy: "writer" }]);
    await driveToReadyForMerge(flow, runId, API_TASK.id);
    const primary = flow.gateway.createdAgentsOfRole("implementer")[0];
    expect(primary.spec.projectRole).toBe("frontend");
    expect(primary.spec.title).toContain("[Frontend]");
    // Test-writing access comes from this assignment, not from a fixed kind in Performance.md.
    expect(flow.gateway.createdAgentsOfRole("qa")[0].spec.projectRole).toBe("performance");
    expect(flow.gateway.createdAgentsOfRole("doc")[0].spec.projectRole).toBe("writer");
    expect(flow.task(runId, API_TASK.id).roundVerdicts.performance.verdict).toBe("APPROVED");
    expect(flow.task(runId, API_TASK.id).phase).toBe("ready_for_merge");
  });

  it("can assign one project role to separate implementation and review instances", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await addProjectRole(flow, "Frontend");
    const runId = await startedRunWithTasks(flow, [{ ...API_TASK, implementerRole: "frontend", verifiers: ["frontend"] }]);
    await driveToReadyForMerge(flow, runId, API_TASK.id);
    const task = flow.task(runId, API_TASK.id);
    // Distinct participant keys prevent a reviewer from overwriting the task's main Implementer.
    expect(task.agentIds.implementer).not.toBe(task.agentIds[reviewerAgentKey("frontend")]);
    expect(flow.gateway.createdAgentsOfRole("security")[0].spec.projectRole).toBe("frontend");
    expect(task.roundVerdicts.frontend.verdict).toBe("APPROVED");
  });

  it("rejects unknown roles without storing a partial task split", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "Implement billing with tests." });
    const definition = await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", {
      masterSpec: "Billing contracts", tasks: [{ ...API_TASK, implementerRole: "missing" }],
    });
    expect(definition.isError).toBe(true);
    expect(definition.text).toContain("Unknown project peer role 'missing'");
    expect(flow.run(runId).tasks).toEqual({});
    expect(flow.run(runId).masterSpec).toBeNull();
  });

  it("keeps independent verdicts when two business roles share test-writing capabilities", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    for (const roleName of ["Performance", "Accessibility"]) await addProjectRole(flow, roleName);
    const runId = await startedRunWithTasks(flow, [{ ...API_TASK, verifiers: ["performance", "accessibility"],
      reviewerPermissions: { performance: "tests", accessibility: "tests" } }]);
    await driveToReadyForMerge(flow, runId, API_TASK.id);
    // A shared runtime capability must never collapse two domain reviews into one quorum slot.
    expect(flow.gateway.createdAgentsOfRole("qa")).toHaveLength(2);
    expect(Object.keys(flow.task(runId, API_TASK.id).roundVerdicts).sort()).toEqual(["accessibility", "performance"]);
  });

  it("uses the provider selected in LEAD.md for the native fork decision", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await loadProjectPrompts(flow.repoPath);
    await writeFile(join(flow.repoPath, ".slp/LEAD.md"), "---\nrole: Lead\ndescription: Plan the project\nmodel: codex/project-planner\nthinking: high\n---\nPlan and delegate through the task tools.");
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    expect(flow.gateway.createdAgentsOfRole("master_lead")[0].spec.provider).toBe("codex/project-planner");
    // The form selected Claude, but forking with Claude flags would target the wrong provider session.
    expect(flow.run(runId).forkDegradedReason).toContain("codex");
    const forkedLead = flow.gateway.createdAgentsOfRole("forked_lead")[0];
    expect(forkedLead.spec.provider).toBe("codex/project-planner");
    expect(forkedLead.spec.thinkingOptionId).toBe("high");
    expect(forkedLead.spec.extraOptions).toBeUndefined();
  });

  it("rejects invalid project Markdown before creating worktrees or agents", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await loadProjectPrompts(flow.repoPath);
    await writeFile(join(flow.repoPath, ".slp/peers/QA.md"), "missing front matter");
    await expect(flow.startRun()).rejects.toThrow(".slp/peers/QA.md");
    expect(flow.paseo.createdWorkspaces).toHaveLength(0);
    expect(flow.gateway.createdAgents).toHaveLength(0);
    expect(flow.store.list()).toHaveLength(0);
  });

  // Editing files prepares the next run; an in-flight run must retain one reproducible prompt catalog.
  it("persists the run's workflow snapshot independently of later project edits", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await addProjectRole(flow, "Frontend");
    const runId = await flow.startRun();
    await writeFile(join(flow.repoPath, ".slp/peers/Frontend.md"), "---\nrole: Frontend\ndescription: Changed\n---\nNEW_WORKFLOW");
    const reloadedStore = new RunStore(flow.databasePath);
    try {
      reloadedStore.load();
      expect(reloadedStore.require(runId).promptConfig?.peers.find((peer) => peer.role === "frontend")?.workflow)
        .toContain("Frontend project conventions");
    } finally { reloadedStore.close(); }
  });
});

describe("Lead-controlled additional peers", () => {
  it("can consult a role before task creation without requiring a fixed kind", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await addProjectRole(flow, "Database");
    const runId = await flow.startRun();
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "Plan transaction-safe billing." });
    await flow.deliverMail(runId);
    expect(flow.run(runId).agents[flow.run(runId).masterLeadAgentId].awaitingTool).toBe("slp_define_tasks");
    const spawn = await flow.callAsRole(runId, "master_lead", null, "slp_spawn_peer", {
      role: "database", brief: "Survey transaction boundaries before task decomposition.",
    });
    expect(spawn.isError).toBe(false);
    // Waiting for an expert is legitimate; the nudge loop must not force premature task decomposition.
    expect(flow.run(runId).agents[flow.run(runId).masterLeadAgentId].awaitingTool).toBeNull();
    const agentId = JSON.parse(spawn.text).agentId as string;
    // No task/worktree is needed for a read-only expert consultation in the integration checkout.
    expect(flow.store.findAgent(agentId)?.agentRecord.taskId).toBeNull();
    expect(flow.gateway.createdAgentsOfRole("peer")[0].spec.workspaceId).toBe(flow.run(runId).devWorkspaceId);
    expect((await flow.callAs(agentId, "slp_peer_report", { summary: "Use a single invoice transaction." })).isError).toBe(false);
    expect(flow.run(runId).peerReports[0].role).toBe("database");
    expect(flow.run(runId).status).toBe("planning");
    await flow.deliverMail(runId);
    expect(flow.run(runId).agents[flow.run(runId).masterLeadAgentId].awaitingTool).toBe("slp_define_tasks");
  });
  async function activeProjectTask() {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await addProjectRole(flow, "Database");
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    await approveHandshake(flow, runId, API_TASK.id);
    await waitForPhase(flow, runId, API_TASK.id, "implementing");
    return { flow, runId };
  }

  it("spawns any configured business role and records authenticated reports for the Lead", async () => {
    const { flow, runId } = await activeProjectTask();
    const spawn = await flow.callAsRole(runId, "master_lead", null, "slp_spawn_peer", {
      taskId: API_TASK.id, role: "database", brief: "Review invoice transaction boundaries.",
    });
    expect(spawn.isError).toBe(false);
    const agentId = JSON.parse(spawn.text).agentId as string;
    expect(flow.store.findAgent(agentId)?.agentRecord).toMatchObject({ role: "peer", projectRole: "database", writeScope: [] });
    expect((await flow.callAs(agentId, "slp_peer_report", { summary: "Transaction boundary verified", findings: ["Rollback is covered."] })).isError).toBe(false);
    const report = flow.task(runId, API_TASK.id).peerReports[0];
    expect(report).toMatchObject({ agentId, role: "database", summary: "Transaction boundary verified" });
    // The main task stays in control of its own stage; extra evidence is delivered to the Lead.
    expect(flow.task(runId, API_TASK.id).phase).toBe("implementing");
    expect(flow.mailTo(runId, flow.run(runId).masterLeadAgentId).at(-1)?.text).toContain("Transaction boundary verified");
    const followup = await flow.callAsRole(runId, "master_lead", null, "slp_prompt_peer", { agentId, brief: "Check cancellation too." });
    expect(followup.isError).toBe(false);
    expect(flow.mailTo(runId, agentId).at(-1)?.awaitTool).toBe("slp_peer_report");
  });

  it("lets only the Lead create peers and requires an explicit grant for scoped writes", async () => {
    const { flow, runId } = await activeProjectTask();
    const assignment = { taskId: API_TASK.id, role: "database", brief: "Fix the transaction boundary.", allowWrites: true };
    expect((await flow.callAsRole(runId, "implementer", API_TASK.id, "slp_spawn_peer", assignment)).isError).toBe(true);
    const spawn = await flow.callAsRole(runId, "master_lead", null, "slp_spawn_peer", assignment);
    const agentId = JSON.parse(spawn.text).agentId as string;
    expect(flow.store.findAgent(agentId)?.agentRecord.writeScope).toEqual(API_TASK.writableScope);
  });

  // An extra role cannot be used to skip the human/handshake gate before coding is approved.
  it("blocks writable spawning before the task's coding phase", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await addProjectRole(flow, "Database");
    const runId = await startedRunWithTasks(flow, [API_TASK]);
    const spawn = await flow.callAsRole(runId, "master_lead", null, "slp_spawn_peer", {
      taskId: API_TASK.id, role: "database", brief: "Change transactions.", allowWrites: true,
    });
    expect(spawn.text).toContain("require a task in implementing or fixing");
    expect(flow.gateway.createdAgentsOfRole("peer")).toHaveLength(0);
  });
});
