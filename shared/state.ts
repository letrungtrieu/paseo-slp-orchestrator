// SQLite records use these schemas so restarts and legacy imports restore the same domain model.
import { z } from "zod";
import { RunModeSchema, SlpRoleSchema } from "./roles";
import { StoredAcceptanceReportSchema, StoredPeerReportSchema } from "./reports";
import { ProjectPromptConfigSchema } from "./project-prompts";
import { PipelineStateSchema } from "./pipeline";

// Re-export historical names because persisted-run readers and the old task card still use them.
// New pipeline code imports its contracts from shared/pipeline.ts instead of this compatibility layer.
export * from "./legacy-tasks";
import { GateSchema, TaskSchema } from "./legacy-tasks";

// One entry per agent the plugin created; the bus authenticates callers through `token`.
export const AgentRecordSchema = z.object({
  agentId: z.string(),
  role: SlpRoleSchema,
  // New pipeline agents are identified by stage; these nullable fields keep old task rows
  // readable while the dynamic runtime migrates callers away from fixed task roles.
  pipelineId: z.string().nullable().default(null),
  stageId: z.string().nullable().default(null),
  stagePeerId: z.string().nullable().default(null),
  // Explicit parent agent reference enables recursive bottom-up archival across separate Paseo worktrees.
  parentAgentId: z.string().nullable().default(null),
  archivedAt: z.string().nullable().default(null),
  projectRole: z.string().nullable().default(null),
  // Only additional peers use this explicit grant; primary agents derive access from their pipeline assignment.
  writeScope: z.array(z.string()).default([]),
  // A Lead waiting for an extra expert must not be nudged for the workflow tool it will resume afterward.
  leadContinuationTool: z.string().nullable().default(null),
  // A direct peer conversation can defer the sender's normal obligation until the recipient
  // replies; keeping this explicit prevents the sweeper from treating that wait as a stall.
  waitingForAgentId: z.string().nullable().default(null),
  deferredTool: z.string().nullable().default(null),
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
  // Reminders must not look like fresh work, otherwise delivery would reset the nudge counter forever.
  isReminder: z.boolean().default(false),
  createdAt: z.string(),
});
export type MailboxMessage = z.infer<typeof MailboxMessageSchema>;

// Historical consultation and cross-worktree questions retained for legacy run snapshots.
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

// Explicit engine identity prevents an empty legacy run from being mistaken for a dynamic run.
export const RUN_ENGINE_VERSIONS = ["legacy", "dynamic-stages-v1"] as const;
export const RunEngineVersionSchema = z.enum(RUN_ENGINE_VERSIONS);
export type RunEngineVersion = z.infer<typeof RunEngineVersionSchema>;

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

export const PipelineWorkspaceSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string(),
  branch: z.string(),
  owned: z.boolean(),
});
export type PipelineWorkspace = z.infer<typeof PipelineWorkspaceSchema>;

export const RunSchema = z.object({
  id: z.string(),
  title: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  integrationBranch: z.string(),
  mode: RunModeSchema,
  status: RunStatusSchema,
  providers: ProviderChoicesSchema,
  // Missing markers on old SQLite rows intentionally remain legacy until a new run opts in.
  engineVersion: RunEngineVersionSchema.default("legacy"),
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
  pipelines: z.record(z.string(), PipelineStateSchema).default({}),
  // Worktrees created before a pipeline definition is accepted still need an ownership record
  // so abort/finalize cleanup remains deterministic after a daemon restart.
  pipelineWorkspaces: z.record(z.string(), PipelineWorkspaceSchema).default({}),
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
