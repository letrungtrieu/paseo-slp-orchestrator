// RPC contracts between the app UI and the daemon-side orchestrator.
// Both runtimes import these so the Zod schemas validate every call on both ends.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RunModeSchema } from "./roles";
import { BoardTicketSchema, MockupElementCommentInputSchema } from "./board";
import { CommLogEntrySchema, RunSchema, RunStatusSchema } from "./state";
import { ProjectRoleSchema } from "./project-prompts";
import { PeerQuestionMetricsSchema, PeerQuestionStatusSchema, PeerQuestionViewSchema } from "./peer-questions";

export const initializeProjectPromptsRpc = defineRpc({
  name: "slp.project.prompts.init",
  input: z.object({ repoPath: z.string().trim().min(1) }),
  // The form only needs discovery metadata; large workflow bodies remain on the daemon.
  output: z.object({ directory: z.string(), peers: z.array(ProjectRoleSchema.pick({ role: true, name: true, description: true, model: true, thinking: true, sourcePath: true })) }),
});

// Provisions or updates the `slp-manager` skill inside the selected project repository.
export const initSlpManagerSkillRpc = defineRpc({
  name: "slp.skill.init",
  input: z.object({ repoPath: z.string().trim().min(1) }),
  output: z.object({
    skillName: z.string(),
    installedPaths: z.array(z.string()),
  }),
});

// Compact row for the run picker; the full Run is only fetched for the selected run.
// Carries only what the picker renders, so a 3 s poll of many runs does not ship whole task tables.
export const RunSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  repoPath: z.string(),
  status: RunStatusSchema,
  mode: RunModeSchema,
  taskCount: z.number(),
  mergedTaskCount: z.number(),
  openGateCount: z.number(),
  supervisorAgentId: z.string(),
  supervisorWorkspaceId: z.string(),
  // Exposes archive metadata in the 3 s summary poll so the UI can show the warning dialog and restore list immediately.
  archivedAt: z.string().nullable().default(null),
  archivedFromStatus: RunStatusSchema.nullable().default(null),
  archiveWarningPending: z.boolean().default(false),
  updatedAt: z.string(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const listRunsRpc = defineRpc({
  name: "slp.run.list",
  input: z.object({}),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});

export const getRunRpc = defineRpc({
  name: "slp.run.get",
  input: z.object({ runId: z.string() }),
  // Nullable instead of an error: a run may legitimately vanish (state reset) while the UI still polls its id.
  output: z.object({ run: RunSchema.nullable() }),
});

export const startRunRpc = defineRpc({
  name: "slp.run.start",
  input: z.object({
    // min(1) rejects an empty path on both ends before any worktree is created.
    repoPath: z.string().min(1),
    // Required run name; the daemon appends a "#<sequence>" suffix so repeated names stay distinguishable.
    name: z.string().min(1),
    baseBranch: z.string().optional(),
    // The handler inherits host-wide settings when a non-UI caller omits its run mode.
    mode: RunModeSchema.optional(),
    supervisorProvider: z.string().optional(),
    leadProvider: z.string().optional(),
    peerProvider: z.string().optional(),
    // Thinking choices follow each role's selected model and are omitted when unsupported.
    supervisorThinkingOptionId: z.string().optional(),
    leadThinkingOptionId: z.string().optional(),
    peerThinkingOptionId: z.string().optional(),
    // Permission modes are provider-native IDs; the client sends only choices from Paseo's catalog.
    supervisorPermissionModeId: z.string().optional(),
    leadPermissionModeId: z.string().optional(),
    peerPermissionModeId: z.string().optional(),
    // Optional per-run override controlling whether SLP spawns git worktrees or runs directly on baseBranch.
    spawnWorktrees: z.boolean().optional(),
    // The prepared Kanban ticket this Run delivers; its Spec and approved mockup become the Supervisor's starting point.
    ticketId: z.string().trim().min(1).optional(),
  }),
  output: z.object({
    runId: z.string(),
    supervisorAgentId: z.string(),
    supervisorWorkspaceId: z.string(),
  }),
});

export const setRunModeRpc = defineRpc({
  name: "slp.run.set_mode",
  input: z.object({ runId: z.string(), mode: RunModeSchema }),
  output: z.object({ ok: z.boolean() }),
});

// Approves the gate of one task, or the run level gate when taskId is omitted.
export const approveGateRpc = defineRpc({
  name: "slp.gate.approve",
  // note is optional and currently unused by the UI; it is kept so approvals can later carry a reason in the audit log.
  input: z.object({ runId: z.string(), taskId: z.string().optional(), note: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// Dynamic pipelines own their gates by pipeline id; this contract keeps the old task gate RPC separate for legacy snapshots.
export const approvePipelineGateRpc = defineRpc({
  name: "slp.pipeline.approve_gate",
  input: z.object({ runId: z.string(), pipelineId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// Resumes a paused task (circuit breaker or repeated scope violations) with optional guidance.
export const resumeTaskRpc = defineRpc({
  name: "slp.task.resume",
  input: z.object({ runId: z.string(), taskId: z.string(), guidance: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// The Supreme Manager's final button: merge the integration branch into the base branch.
export const approveMainRpc = defineRpc({
  name: "slp.run.approve_main",
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const abortRunRpc = defineRpc({
  name: "slp.run.abort",
  // When archiveOnly is true, the run is paused and stored in the archive list with all worktrees intact for later restoration.
  input: z.object({ runId: z.string(), archiveOnly: z.boolean().optional() }),
  output: z.object({ ok: z.boolean() }),
});

// Restores an archived or interrupted SLP run, re-attaching its worktrees and respawning its Supervisor, Leads, and Peers.
export const restoreRunRpc = defineRpc({
  name: "slp.run.restore",
  input: z.object({ runId: z.string() }),
  output: z.object({
    ok: z.boolean(),
    runId: z.string(),
    supervisorAgentId: z.string(),
    supervisorWorkspaceId: z.string(),
    status: RunStatusSchema,
  }),
});

// Clears the unexpected-archive warning banner/modal once the user chooses to keep the run in the archive list.
export const dismissArchiveWarningRpc = defineRpc({
  name: "slp.run.dismiss_archive_warning",
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const tailLogRpc = defineRpc({
  name: "slp.log.tail",
  // Bounded by 500 so one request cannot read an unbounded log file; the UI asks for 200.
  input: z.object({ runId: z.string(), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ entries: z.array(CommLogEntrySchema) }),
});

// Audit of agent-to-agent questions: every ask/answer plus aggregate metrics for judging communication quality.
export const listPeerQuestionsRpc = defineRpc({
  name: "slp.questions.list",
  input: z.object({
    runId: z.string(),
    status: PeerQuestionStatusSchema.optional(),
    // Newest first; the cap keeps a long run's ledger from being shipped to the UI in one response.
    limit: z.number().int().min(1).max(2000).default(500),
  }),
  output: z.object({ questions: z.array(PeerQuestionViewSchema), metrics: PeerQuestionMetricsSchema }),
});

// Returns all Kanban tickets for a project repository (or the repository of the selected run) with live agent statuses.
export const listBoardTicketsRpc = defineRpc({
  name: "slp.board.list",
  input: z.object({
    repoPath: z.string().optional(),
    runId: z.string().optional(),
  }),
  output: z.object({
    repoPath: z.string(),
    tickets: z.array(BoardTicketSchema),
  }),
});

// Saves a human-authored Spec creation or edit from the Kanban UI, computes the Git-style diff, and notifies the Supervisor.
export const saveBoardSpecFromUiRpc = defineRpc({
  name: "slp.board.save_spec",
  input: z.object({
    repoPath: z.string().min(1),
    runId: z.string().optional(),
    ticketId: z.string().optional(),
    title: z.string().trim().min(1),
    acceptanceCriteria: z.string().optional(),
    specContent: z.string().trim().min(1),
    summary: z.string().optional(),
  }),
  output: z.object({
    ticket: BoardTicketSchema,
    notifiedSupervisor: z.boolean(),
  }),
});

// Spawns a standalone Product Agent so the human can shape a feature's mockup and Spec in chat before any Run exists.
export const spawnBoardProductAgentRpc = defineRpc({
  name: "slp.board.spawn_product_agent",
  input: z.object({
    repoPath: z.string().trim().min(1),
    runId: z.string().optional(),
    ticketId: z.string().optional(),
  }),
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string(),
  }),
});

// Reads and bundles a ticket's mockup file (inlining relative .css and .js files) for instant live preview on the Kanban board.
export const readBoardMockupPreviewRpc = defineRpc({
  name: "slp.board.read_mockup_preview",
  input: z.object({
    repoPath: z.string().trim().min(1),
    ticketId: z.string().trim().min(1),
  }),
  output: z.object({
    ticketId: z.string(),
    title: z.string(),
    file: z.string(),
    absoluteHtmlPath: z.string(),
    bundledHtml: z.string(),
  }),
});

// Stores the human's mockup notes on the ticket and hands them to the Product Agent, opening a new session when none is reachable.
export const sendBoardMockupFeedbackRpc = defineRpc({
  name: "slp.board.send_mockup_feedback",
  input: z.object({
    repoPath: z.string().trim().min(1),
    ticketId: z.string().trim().min(1),
    feedback: z.string().optional(),
    elementComments: z.array(MockupElementCommentInputSchema).optional(),
  }),
  output: z.object({
    ticket: BoardTicketSchema,
    productAgentId: z.string(),
  }),
});

// Approves a ticket's mockup at the current commit; the daemon refuses while `.slp/mockup` has uncommitted changes.
export const approveBoardMockupRpc = defineRpc({
  name: "slp.board.approve_mockup",
  input: z.object({
    repoPath: z.string().trim().min(1),
    ticketId: z.string().trim().min(1),
  }),
  output: z.object({
    ticket: BoardTicketSchema,
  }),
});

