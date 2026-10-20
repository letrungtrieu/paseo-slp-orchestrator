// Dynamic pipeline contracts shared by the daemon, the agent bus and persisted run state.
import { z } from "zod";
import { ProjectRoleIdSchema } from "./project-prompts";

// Lead-authored role names may use the spelling a human naturally chooses; persistence uses
// the same slug convention as .slp files so lookups cannot split on underscores or spaces.
export function normalizePipelineRoleId(roleText: string): string {
  return roleText
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Piping through the project-role schema rejects punctuation and leading digits after the
// friendly normalization, while still accepting roles such as `qa_engineer` from the model.
export const PipelineRoleIdSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizePipelineRoleId)
  .pipe(ProjectRoleIdSchema);
export type PipelineRoleId = z.infer<typeof PipelineRoleIdSchema>;

export const PipelinePeerDefinitionSchema = z.object({
  role: PipelineRoleIdSchema,
  // The engine normally loads this from .slp; accepting an explicit value keeps the wire
  // contract compatible with Lead-produced plans while the daemon remains authoritative.
  systemPrompt: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1),
});
export type PipelinePeerDefinition = z.infer<typeof PipelinePeerDefinitionSchema>;

export const PipelineStageDefinitionSchema = z.object({
  name: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  // An array is intentional: peers in one stage share authority and may challenge each other.
  peers: z.array(PipelinePeerDefinitionSchema).min(1, "Each stage must assign at least one peer."),
});
export type PipelineStageDefinition = z.infer<typeof PipelineStageDefinitionSchema>;

export const PipelineDefinitionSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  worktree: z.string().trim().min(1),
  description: z.string().trim().min(1),
  // Stage order is the dependency graph: the next stage is opened only after the Lead
  // closes the current one, so the Lead does not need a second hidden dependency format.
  stages: z.array(PipelineStageDefinitionSchema).min(1),
});
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

export const PipelineInputDefinitionSchema = PipelineDefinitionSchema.extend({
  // Default version to "1.0" when a Lead omits it during pipeline definition.
  version: z.string().trim().min(1).default("1.0"),
  // Optional on input: when omitted, definePipeline uses the Lead's own worktree or provisions a dedicated worktree.
  worktree: z.string().trim().min(1).optional(),
});
export type PipelineInputDefinition = z.infer<typeof PipelineInputDefinitionSchema>;

export const PipelineEnvelopeSchema = z.object({
  pipeline: PipelineInputDefinitionSchema.optional(),
  pipelines: z.array(PipelineInputDefinitionSchema).min(1).optional(),
});
export type PipelineEnvelope = z.infer<typeof PipelineEnvelopeSchema>;

// Describes one parallel feature track delegated by the Supervisor to a dedicated Lead and worktree.
export const DelegatedFeatureSchema = z.object({
  name: z.string().trim().min(1),
  acceptanceCriteria: z.string().trim().min(10),
  worktree: z.string().trim().min(1).optional(),
});
export type DelegatedFeature = z.infer<typeof DelegatedFeatureSchema>;

// Supports both single-feature delegation (`acceptanceCriteria`) and N-Lead parallel feature decomposition (`tasks`).
export const DelegationSubmissionSchema = z
  .object({
    acceptanceCriteria: z.string().trim().min(10).optional(),
    sharedContext: z.string().trim().min(1).optional(),
    tasks: z.array(DelegatedFeatureSchema).min(1).optional(),
  })
  .refine(
    (submission) =>
      (typeof submission.acceptanceCriteria === "string" && submission.acceptanceCriteria.trim().length >= 20) ||
      Boolean(submission.tasks && submission.tasks.length > 0),
    {
      message: "Provide either acceptanceCriteria (at least 20 characters) or a non-empty tasks array.",
    },
  );
export type DelegationSubmission = z.infer<typeof DelegationSubmissionSchema>;

export const PIPELINE_STATUSES = [
  "queued",
  "starting",
  "running",
  "paused",
  "completed",
  "integrated",
  "failed",
] as const;
export const PipelineStatusSchema = z.enum(PIPELINE_STATUSES);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const STAGE_STATUSES = ["pending", "starting", "running", "completing", "completed", "failed"] as const;
export const StageStatusSchema = z.enum(STAGE_STATUSES);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageReportSubmissionSchema = z.object({
  summary: z.string().trim().min(1),
  findings: z.array(z.string().trim().min(1)).default([]),
  status: z.enum(["completed", "blocked"]).default("completed"),
});
export type StageReportSubmission = z.infer<typeof StageReportSubmissionSchema>;

export const StoredStageReportSchema = StageReportSubmissionSchema.extend({
  agentId: z.string().min(1),
  role: PipelineRoleIdSchema,
  submittedAt: z.string(),
});
export type StoredStageReport = z.infer<typeof StoredStageReportSchema>;

export const StageMessageSchema = z.object({
  id: z.string().min(1),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  message: z.string().trim().min(1),
  createdAt: z.string(),
});
export type StageMessage = z.infer<typeof StageMessageSchema>;

export const StageResultSchema = z.object({
  summary: z.string().trim().min(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
});
export type StageResult = z.infer<typeof StageResultSchema>;

export const PipelineGateSchema = z.object({
  kind: z.enum(["after_stage", "before_integration"]),
  stageId: z.string().nullable(),
  openedAt: z.string(),
  note: z.string().trim().min(1),
});
export type PipelineGate = z.infer<typeof PipelineGateSchema>;

export const StageStateSchema = PipelineStageDefinitionSchema.extend({
  id: z.string().min(1),
  status: StageStatusSchema.default("pending"),
  forkedLeadAgentId: z.string().nullable().default(null),
  peerAgentIds: z.array(z.string()).default([]),
  reports: z.array(StoredStageReportSchema).default([]),
  // Direct peer messages stay attached to the stage, making the review history auditable after
  // its agents are archived and preventing cross-stage conversations from being conflated.
  messages: z.array(StageMessageSchema).default([]),
  result: StageResultSchema.nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});
export type StageState = z.infer<typeof StageStateSchema>;

export const PipelineStateSchema = PipelineDefinitionSchema.extend({
  id: z.string().min(1),
  status: PipelineStatusSchema.default("queued"),
  // Tracks the Lead agent that owns this pipeline's worktree and directly supervises all of its stages.
  leadAgentId: z.string().nullable().default(null),
  currentStageIndex: z.number().int().min(0).default(0),
  workspaceId: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  baseCommit: z.string().nullable().default(null),
  stages: z.array(StageStateSchema).min(1),
  pausedReason: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  finalReport: z.string().nullable().default(null),
  // STEP_BY_STEP_DEBUG pauses after each stage and SEMI_AUTO pauses before integration; FULL_AUTO
  // leaves this null while still requiring Forked Lead approval for every stage.
  gate: PipelineGateSchema.nullable().default(null),
  // The integration step records the commit that was actually checked, so finalization cannot
  // be mistaken for a merely requested merge after a restart.
  mergedCommit: z.string().nullable().default(null),
  integratedAt: z.string().nullable().default(null),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;
