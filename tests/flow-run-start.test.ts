import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tailCommLog } from "../server/store/comm-log";
import { runGitSync } from "./helpers/git-fixture";
import { useFlowFixture } from "./helpers/flow-fixture";
import { API_TASK, UI_TASK, delegateAndDefineTasks, eventually, startedRunWithTasks } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("run start (spec phase 1)", () => {
  // spec phase 1: the Supervisor fronts the user, the Master Lead lives on the dev branch
  it("creates a supervisor and a master lead and waits in 'delegating'", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const run = flow.run(runId);

    expect(run.status).toBe("delegating");
    expect(run.supervisorAgentId).toBe(flow.agentId(runId, "supervisor"));
    expect(run.masterLeadAgentId).toBe(flow.agentId(runId, "master_lead"));
    expect(run.baseBranch).toBe("main");
    expect(run.integrationBranch).toMatch(/^slp\/[0-9a-f]{8}\/dev$/);
    // the supervisor works in the user's checkout, the master lead in the integration worktree
    expect(flow.paseo.openedRepositories).toEqual([flow.repoPath]);
    expect(run.devCwd).toBe(flow.paseo.createdWorkspaces[0].directory);
  });

  // role agents must start in the workspace their permissions are computed from
  it("creates the agents in the right workspaces with their awaited tools", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const run = flow.run(runId);
    const [masterLead, supervisor] = flow.gateway.createdAgents;
    expect(masterLead.spec).toMatchObject({ role: "master_lead", workspaceId: run.devWorkspaceId, awaitTool: null });
    expect(supervisor.spec).toMatchObject({ role: "supervisor", workspaceId: run.supervisorWorkspaceId, awaitTool: null });
    // providers come from the run choices
    expect(masterLead.spec.provider).toBe("claude/sonnet");
  });

  // TASK_SPEC.md and .slp/ must never reach a merge commit
  it("keeps pipeline files out of git through the repo exclude file", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await flow.startRun();
    const excludeContent = readFileSync(join(flow.repoPath, ".git", "info", "exclude"), "utf8");
    expect(excludeContent).toContain(".slp/");
    expect(excludeContent).toContain("/TASK_SPEC.md");
  });

  // starting on a non-repo would fail late and leave a half-created run
  it("rejects a directory that is not a git repository", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { startRun } = await import("../server/pipeline/run-lifecycle");
    let startFailure: unknown = null;
    try {
      await startRun(flow.ctx, { repoPath: join(flow.repoPath, "..", "missing-dir"), mode: "FULL_AUTO", providers: {} });
    } catch (caught) {
      startFailure = caught;
    }
    expect(startFailure).toBeInstanceOf(Error);
  });

  // the Master Lead owes slp_define_tasks, which arms the nudge
  it("slp_delegate moves to 'planning' and mails the master lead who owes slp_define_tasks", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "Billing works end to end." });
    expect(delegation.isError).toBe(false);

    expect(flow.run(runId)).toMatchObject({ status: "planning", criteria: "Billing works end to end." });
    const [masterMail] = flow.mailTo(runId, flow.run(runId).masterLeadAgentId);
    expect(masterMail.awaitTool).toBe("slp_define_tasks");
    expect(masterMail.text).toContain("Billing works end to end.");
  });

  // re-delegating would restart planning behind the Lead's back
  it("refuses a second delegation after the project left the delegating state", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "First criteria text here." });
    const secondDelegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", { acceptanceCriteria: "Second criteria text here." });
    expect(secondDelegation).toMatchObject({ isError: true });
    expect(secondDelegation.text).toContain("slp_request_rework");
  });
});

describe("task definition and fork checkpoint (spec phase 2)", () => {
  // spec phase 2: each task gets a worktree, a Forked Lead and a read-only Implementer
  it("turns two disjoint tasks into handshaking tasks with forked lead and implementer agents", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow);
    const run = flow.run(runId);

    expect(run.status).toBe("running");
    for (const taskId of [API_TASK.id, UI_TASK.id]) {
      const task = run.tasks[taskId];
      expect(task.phase).toBe("handshaking");
      expect(task.agentIds.forked_lead).toBeTruthy();
      expect(task.agentIds.implementer).toBeTruthy();
      expect(task.workspace?.branch).toBe(`slp/${runId.slice(0, 8)}/${taskId}`);
      expect(task.taskSpecSha256).toHaveLength(64);
      // TASK_SPEC.md is placed in the real worktree
      expect(readFileSync(join(task.workspace!.cwd, "TASK_SPEC.md"), "utf8")).toContain(`(\`${taskId}\`)`);
    }
    expect(run.masterSpecPath).toBe(".slp/MASTER_SPEC.md");
  });

  // task branches must fork from dev so diffs against it are the task's own work
  it("cuts each task worktree from the integration branch", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow);
    const run = flow.run(runId);
    const taskWorktree = run.tasks[API_TASK.id].workspace!.cwd;
    expect(runGitSync(taskWorktree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(run.tasks[API_TASK.id].workspace!.branch);
    expect(runGitSync(taskWorktree, ["merge-base", "HEAD", run.integrationBranch]).trim()).toBe(runGitSync(taskWorktree, ["rev-parse", "HEAD"]).trim());
  });

  // verified fork recipe: resume the master session with fork-session, in the same cwd
  it("passes the Claude fork options to the forked lead only", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", forker: "claude" });
    const runId = await startedRunWithTasks(flow);
    const masterLeadId = flow.run(runId).masterLeadAgentId;

    const forkedLeadCreations = flow.gateway.createdAgentsOfRole("forked_lead");
    expect(forkedLeadCreations).toHaveLength(2);
    for (const { spec } of forkedLeadCreations) {
      // resume = the master lead's provider session, plus a bare --fork-session flag (null)
      expect(spec.extraOptions).toEqual({ extraArgs: { resume: `session-of-${masterLeadId}`, "fork-session": null } });
      // the fork must share the master lead's checkout, or Claude cannot find the source session
      expect(spec.workspaceId).toBe(flow.run(runId).devWorkspaceId);
      expect(spec.provider).toBe("claude/sonnet");
    }
    for (const { spec } of flow.gateway.createdAgentsOfRole("implementer")) expect(spec.extraOptions).toBeUndefined();
    expect(flow.run(runId).forkDegradedReason).toBeNull();
  });

  it("starts the implementer in its own worktree owing slp_submit_plan", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow);
    const task = flow.task(runId, API_TASK.id);
    const { spec } = flow.gateway.createdAgents.find((created) => created.record.agentId === task.agentIds.implementer)!;
    expect(spec).toMatchObject({ workspaceId: task.workspace!.workspaceId, awaitTool: "slp_submit_plan", provider: "codex/gpt" });
    expect(spec.initialPrompt).toContain("READ-ONLY");
  });

  // providers without a wired fork must still complete the handshake
  it("degrades to the spec-file briefing when the forker cannot fork", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", forker: "unwired" });
    const runId = await startedRunWithTasks(flow);

    expect(flow.run(runId).forkDegradedReason).toBe("claude native fork is not wired into this plugin");
    for (const { spec } of flow.gateway.createdAgentsOfRole("forked_lead")) {
      expect(spec.extraOptions).toBeUndefined();
      // the briefing tells the forked lead to rebuild context from the spec file
      expect(spec.initialPrompt).toContain("Native session fork was unavailable");
    }
    // the degraded run still reaches the handshake
    expect(flow.task(runId, API_TASK.id).phase).toBe("handshaking");
  });

  // a broken adapter must not abort the run
  it("degrades instead of failing when the forker throws", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", forker: "throwing" });
    const runId = await startedRunWithTasks(flow);
    expect(flow.run(runId).forkDegradedReason).toBe("claude fork failed: fork adapter exploded");
    expect(flow.task(runId, API_TASK.id).phase).toBe("handshaking");
  });

  // without a session id there is nothing to fork from
  it("degrades when the master lead has no provider session id yet", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    flow.gateway.setSessionId(flow.run(runId).masterLeadAgentId, null);
    await delegateAndDefineTasks(flow, runId);
    expect(flow.run(runId).forkDegradedReason).toBe("master lead has no provider session id yet");
  });

  it("records the fork checkpoint in the comm log", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO", forker: "unwired" });
    const runId = await startedRunWithTasks(flow);
    await eventually(async () => {
      const logEntries = await tailCommLog(flow.repoPath, runId, 200);
      if (!logEntries.some((entry) => entry.kind === "fork.checkpoint" && entry.outcome === "error")) throw new Error("no degraded checkpoint entry");
    });
  });

  // spec section 5: in-chat cards update as the task moves through phases
  it("publishes a progress card per task with the Vietnamese phase label", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await startedRunWithTasks(flow);
    await eventually(() => {
      const cards = flow.paseo.cardsForTask(API_TASK.id);
      if (!cards.some((card) => card.phase === "handshaking")) throw new Error("no handshaking card");
    });
    expect(flow.paseo.timelineAppends.every((append) => append.agentId === flow.run(runId).supervisorAgentId)).toBe(true);
  });

  // spec phase 1, step 3: overlapping scopes would cause merge conflicts
  it("rejects tasks whose writable scopes overlap and registers nothing", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const definition = await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", {
      masterSpecPath: "spec.md",
      tasks: [
        { id: "a", title: "A", purpose: "p", writableScope: ["src/"] },
        { id: "b", title: "B", purpose: "p", writableScope: ["src/api/"] },
      ],
    });
    expect(definition.isError).toBe(true);
    expect(definition.text).toContain("a overlaps b");
    expect(Object.keys(flow.run(runId).tasks)).toEqual([]);
    expect(flow.gateway.createdAgentsOfRole("implementer")).toEqual([]);
  });

  it("rejects a duplicated task id and an id that already exists", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const duplicated = await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", {
      masterSpecPath: "spec.md",
      tasks: [
        { id: "same", title: "A", purpose: "p", writableScope: ["a/"] },
        { id: "same", title: "B", purpose: "p", writableScope: ["b/"] },
      ],
    });
    expect(duplicated.text).toContain("duplicated or already exists");
  });

  // a task without scope could never write anything
  it("rejects an empty writable scope at the schema level", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const definition = await flow.callAsRole(runId, "master_lead", null, "slp_define_tasks", {
      masterSpecPath: "spec.md",
      tasks: [{ id: "a", title: "A", purpose: "p", writableScope: [] }],
    });
    expect(definition.text).toContain("Invalid arguments");
  });
});
