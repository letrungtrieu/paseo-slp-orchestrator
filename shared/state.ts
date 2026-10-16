// SQLite records use these schemas so restarts and legacy imports restore the same domain model.
import { z } from "zod";
import { RunModeSchema, SlpRoleSchema } from "./roles";
import { StoredAcceptanceReportSchema, StoredPeerReportSchema } from "./reports";
import { ProjectPromptConfigSchema, ProjectRoleIdSchema } from "./project-prompts";

// Order follows the happy path; paused and failed are side states that any phase can fall into.
export const TASK_PHASES = [
  "queued", // defined by the Master Lead, waiting for the fork checkpoint
  "handshaking", // Implementer and Forked Lead align on the plan (read-only)
  "implementing",
  "verifying",
  "fixing",
  "documenting",
  "ready_for_merge",
  "merged", // Master Lead merged it and asked for archive
  "paused", // circuit breaker, repeated scope violations or an open escalation
  "failed",
] as const;
export const TaskPhaseSchema = z.enum(TASK_PHASES);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

// Order follows the pipeline; the first four are per task, final_approval is the only run-level gate.
export const GATE_KINDS = [
  "after_handshake",
  "after_implementation",
  "after_verification",
  "before_merge",
  "circuit_breaker",
  "final_approval",
] as const;
export const GateKindSchema = z.enum(GATE_KINDS);
export type GateKind = z.infer<typeof GateKindSchema>;

export const GateSchema = z.object({
  kind: GateKindSchema,
  openedAt: z.string(),
  note: z.string(),
});
export type Gate = z.infer<typeof GateSchema>;

// What the Master Lead supplies for each work package (spec phase 1, step 3).
export const TaskDefinitionSchema = z.object({
  // Lowercase slug because the id becomes part of a git branch name and a worktree directory.
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  // Defaults keep the Master Lead's call short: omitting optional lists is valid and means 'none'.
  assumptions: z.array(z.string()).default([]),
  writableScope: z.array(z.string()).min(1),
  forbidden: z.array(z.string()).default([]),
  // Both reviewers by default; a Lead must opt out explicitly, so skipping review is a deliberate decision.
  verifiers: z.array(ProjectRoleIdSchema).default(["qa", "security"]).describe("Project role IDs selected by the Lead to review this task"),
  // A business role can occupy different assignments on different tasks; YAML does not prescribe its capabilities.
  implementerRole: ProjectRoleIdSchema.default("implementer").describe("Project role ID for the primary implementation assignment"),
  reviewerPermissions: z.record(ProjectRoleIdSchema, z.enum(["read-only", "tests"])).default({})
    .describe("Per-task reviewer access; custom roles default to read-only, QA defaults to tests"),
  verifyParallel: z.boolean().default(true),
  // The Implementer documents by default because it already knows the change; a separate Doc peer costs an extra agent.
  documentedBy: ProjectRoleIdSchema.default("implementer").describe("Use implementer to reuse the primary peer, or a project role ID to spawn a dedicated report author"),
});
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

export const PlanSchema = z.object({
  restatedGoal: z.string(),
  discrepancies: z.array(z.string()),
  plannedFiles: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

export const VerdictRecordSchema = z.object({
  verdict: z.enum(["APPROVED", "REJECTED"]),
  issues: z.array(z.string()),
});
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;

export const TaskWorkspaceSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string(),
  branch: z.string(),
});

// Defaults allow old JSON imports and earlier SQLite snapshots to acquire new runtime fields safely.
export const TaskSchema = TaskDefinitionSchema.extend({
  phase: TaskPhaseSchema,
  pausedReason: z.string().nullable().default(null),
  // phase to return to when a paused task is resumed (escalation, circuit breaker, scope)
  pausedFromPhase: TaskPhaseSchema.nullable().default(null),
  fixLoopCount: z.number().int().default(0),
  handshakeRounds: z.number().int().default(0),
  scopeViolations: z.number().int().default(0),
  workspace: TaskWorkspaceSchema.nullable().default(null),
  // agent ids by role; forked lead is removed once the handshake is approved
  // Plain record keyed by role name so a role can be removed (the Forked Lead) without a structural change.
  agentIds: z.record(z.string(), z.string()).default({}),
  plan: PlanSchema.nullable().default(null),
  // verdicts collected for the current verification round only
  roundVerdicts: z.record(z.string(), VerdictRecordSchema).default({}),
  // verifiers still to be woken in a sequential (non parallel) stage
  verifierQueue: z.array(ProjectRoleIdSchema).default([]),
  // Task-level gate: parallel tasks can wait for the human independently of each other.
  gate: GateSchema.nullable().default(null),
  // Reports travel through authenticated tools rather than files in the task worktree.
  implementationSummary: z.string().nullable().default(null),
  acceptanceReport: StoredAcceptanceReportSchema.nullable().default(null),
  // Additional expert reports remain available even after the peer or task workspace is archived.
  peerReports: z.array(StoredPeerReportSchema).default([]),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

// One entry per agent the plugin created; the bus authenticates callers through `token`.
export const AgentRecordSchema = z.object({
  agentId: z.string(),
  role: SlpRoleSchema,
  projectRole: z.string().nullable().default(null),
  // Only additional peers use this explicit grant; primary agents derive access from their pipeline assignment.
  writeScope: z.array(z.string()).default([]),
  // A Lead waiting for an extra expert must not be nudged for the workflow tool it will resume afterward.
  leadContinuationTool: z.string().nullable().default(null),
  taskId: z.string().nullable(),
  token: z.string(),
  // name of the bus tool the agent owes us; used to nudge agents that end a turn without it
  awaitingTool: z.string().nullable().default(null),
  // when the owed tool was requested; a turn must start after this to count as the agent's reply
  awaitingSince: z.string().nullable().default(null),
  // Counts reminders for the current obligation only; reset whenever new mail changes what is owed.
  nudges: z.number().int().default(0),
  createdAt: z.string(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

// A queued prompt; delivered only when the target agent is idle so no turn is interrupted.
export const MailboxMessageSchema = z.object({
  id: z.string(),
  toAgentId: z.string(),
  text: z.string(),
  taskId: z.string().nullable(),
  // bus tool the recipient owes once this message is delivered (drives nudging)
  awaitTool: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type MailboxMessage = z.infer<typeof MailboxMessageSchema>;

// Consult (Master Lead -> Implementer) and sibling (worktree A -> worktree B) questions.
export const QuestionSchema = z.object({
  id: z.string(),
  kind: z.enum(["consult", "sibling"]),
  fromAgentId: z.string(),
  toAgentId: z.string(),
  taskId: z.string(),
  text: z.string(),
  answer: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const RUN_STATUSES = [
  "initializing",
  "delegating",
  "planning",
  "running",
  "reporting",
  "awaiting_user",
  "completed",
  "aborted",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ProviderChoicesSchema = z.object({
  supervisor: z.string(),
  lead: z.string(),
  peer: z.string(),
  // Older saved runs have no reasoning choice, so missing values remain compatible.
  supervisorThinkingOptionId: z.string().nullable().default(null),
  leadThinkingOptionId: z.string().nullable().default(null),
  peerThinkingOptionId: z.string().nullable().default(null),
  // Missing values in older runs resolve to the provider's unattended mode when new agents are created.
  supervisorPermissionModeId: z.string().nullable().default(null),
  leadPermissionModeId: z.string().nullable().default(null),
  peerPermissionModeId: z.string().nullable().default(null),
});
export type ProviderChoices = z.infer<typeof ProviderChoicesSchema>;

export const RunSchema = z.object({
  id: z.string(),
  title: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  integrationBranch: z.string(),
  mode: RunModeSchema,
  status: RunStatusSchema,
  providers: ProviderChoicesSchema,
  // Null until the Supervisor delegates, so a run in 'initializing' is still a valid stored object.
  criteria: z.string().nullable().default(null),
  masterSpec: z.string().nullable().default(null),
  // Legacy runs retain built-in defaults; new runs snapshot all project-authored role workflows.
  promptConfig: ProjectPromptConfigSchema.nullable().default(null),
  supervisorAgentId: z.string(),
  supervisorWorkspaceId: z.string(),
  masterLeadAgentId: z.string(),
  devWorkspaceId: z.string(),
  devCwd: z.string(),
  // Defaults let a run be inserted before its tasks, agents or mail exist, and let older state files load.
  tasks: z.record(z.string(), TaskSchema).default({}),
  agents: z.record(z.string(), AgentRecordSchema).default({}),
  mailbox: z.array(MailboxMessageSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  // Run-level gate, used only for final_approval; task gates live on the task.
  gate: GateSchema.nullable().default(null),
  finalReport: z.string().nullable().default(null),
  // Keep the Supervisor's independent assessment alongside the Lead's integration report.
  supervisorReport: z.string().nullable().default(null),
  // Lead may consult domain experts before tasks exist; those reports belong to the run itself.
  peerReports: z.array(StoredPeerReportSchema).default([]),
  forkDegradedReason: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const StateFileSchema = z.object({
  // Version literal makes a future incompatible state layout fail loudly at load instead of being half-read.
  version: z.literal(1),
  runs: z.record(z.string(), RunSchema),
});
export type StateFile = z.infer<typeof StateFileSchema>;

// Audit entries share one SQLite database with the run they describe.
export const CommLogEntrySchema = z.object({
  ts: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  summary: z.string(),
  outcome: z.enum(["delivered", "queued", "blocked", "error", "info"]),
  // Nullable with defaults so log lines written before these fields existed still validate when tailed.
  reason: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
});
export type CommLogEntry = z.infer<typeof CommLogEntrySchema>;
