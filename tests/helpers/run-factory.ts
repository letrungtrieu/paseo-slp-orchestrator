// Builders for persisted state objects. Defaults are the smallest valid shapes so each test
// states only the fields that matter for the behaviour it checks.
import { randomBytes } from "node:crypto";
import { AgentRecordSchema, RunSchema, TaskSchema, type AgentRecord, type Run, type Task } from "../../shared/state";

export function buildAgentRecord(overrides: Partial<AgentRecord> & Pick<AgentRecord, "agentId" | "role">): AgentRecord {
  // Parsing through the real schema applies the same defaults as a loaded state file, so fixtures cannot drift from production shapes.
  return AgentRecordSchema.parse({
    taskId: null,
    token: randomBytes(12).toString("base64url"),
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

export function buildTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  // Title defaults to the id so a failing assertion names the task without extra fixture data.
  return TaskSchema.parse({
    title: overrides.id,
    purpose: "test purpose",
    writableScope: ["src/"],
    phase: "queued",
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

export function buildRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  // FULL_AUTO by default so unit tests do not stop at human gates unless they ask for one.
  return RunSchema.parse({
    id: "run-1",
    title: "Test run",
    repoPath: "/tmp/does-not-matter",
    baseBranch: "main",
    integrationBranch: "slp/run-1/dev",
    mode: "FULL_AUTO",
    status: "running",
    providers: { supervisor: "claude/x", lead: "claude/x", peer: "claude/x" },
    supervisorAgentId: "sup",
    supervisorWorkspaceId: "ws-sup",
    masterLeadAgentId: "lead",
    devWorkspaceId: "ws-dev",
    devCwd: "/tmp/dev",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}
