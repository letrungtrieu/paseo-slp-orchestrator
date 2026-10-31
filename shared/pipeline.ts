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

// planning: advisor peers discuss techniques/design with the Lead;
// implement: the single developer builds the brief; verify: QA peers grade it (QA pipelines only).
export const STAGE_KINDS = ["planning", "implement", "verify"] as const;
export const StageKindSchema = z.enum(STAGE_KINDS);
export type StageKind = z.infer<typeof StageKindSchema>;

export const BriefCriterionSchema = z.object({
  id: z.string().trim().min(1).describe("Short stable id, e.g. C1"),
  requirement: z.string().trim().min(1).describe("Observable condition that must hold"),
  verification: z.string().trim().min(1).describe("How QA checks it: command, manual step or evidence"),
});
export type BriefCriterion = z.infer<typeof BriefCriterionSchema>;

// The brief is the contract every later stage follows; outOfScope exists so "nice to have" ideas are written down, not built.
export const PipelineBriefSchema = z.object({
  approach: z.string().trim().min(1).describe("Chosen technique/design in a few sentences"),
  criteria: z.array(BriefCriterionSchema).min(1),
  inScope: z.array(z.string().trim().min(1)).min(1),
  outOfScope: z.array(z.string().trim().min(1)).default([]),
});
export type PipelineBrief = z.infer<typeof PipelineBriefSchema>;

export const PipelineStageDefinitionSchema = z.object({
  name: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  // Optional on input: the engine infers it from the peers' kinds and rejects shapes that break the single-writer rules.
  kind: StageKindSchema.optional(),
  peers: z.array(PipelinePeerDefinitionSchema).min(1, "Each stage must assign at least one peer."),
});
export type PipelineStageDefinition = z.infer<typeof PipelineStageDefinitionSchema>;

export const PipelineDefinitionSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  worktree: z.string().trim().min(1),
  description: z.string().trim().min(1),
  // Required up front when the pipeline has no planning stage; a planning stage produces it on approval instead.
  brief: PipelineBriefSchema.optional(),
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

// A spec shorter than this cannot describe screens, states and scenarios, so it is treated as missing.
export const PRODUCT_SPEC_MIN_LENGTH = 80;
const ProductSpecSchema = z.string().trim().min(PRODUCT_SPEC_MIN_LENGTH);

// Describes one parallel feature track delegated by the Supervisor to a dedicated Lead and worktree.
export const DelegatedFeatureSchema = z.object({
  name: z.string().trim().min(1),
  acceptanceCriteria: z.string().trim().min(10),
  // Human-approved screens, states and Given/When/Then interactions; required per feature by DelegationSubmissionSchema.
  productSpec: ProductSpecSchema.optional(),
  worktree: z.string().trim().min(1).optional(),
});
export type DelegatedFeature = z.infer<typeof DelegatedFeatureSchema>;

// Supports both single-feature delegation (`acceptanceCriteria`) and N-Lead parallel feature decomposition (`tasks`).
export const DelegationSubmissionSchema = z
  .object({
    acceptanceCriteria: z.string().trim().min(10).optional(),
    // Single-feature form: the human-approved product spec for the whole request.
    productSpec: ProductSpecSchema.optional(),
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
  )
  // Without an approved spec, developers improvise the UI and QA has nothing to verify behavior against.
  .refine(
    (submission) =>
      submission.tasks && submission.tasks.length > 0
        ? submission.tasks.every((task) => Boolean(task.productSpec))
        : Boolean(submission.productSpec),
    {
      message: `Provide the human-approved productSpec (at least ${PRODUCT_SPEC_MIN_LENGTH} characters: screens and elements, states, Given/When/Then interactions, business rules, out of scope) for every feature before delegating.`,
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

// One row per brief criterion; reason is mandatory even for a pass so the Lead never has to ask "why".
export const ScorecardEntrySchema = z.object({
  criterionId: z.string().trim().min(1),
  status: z.enum(["pass", "fail", "blocked"]),
  reason: z.string().trim().min(1),
  evidence: z.string().trim().default(""),
});
export type ScorecardEntry = z.infer<typeof ScorecardEntrySchema>;

export const StageReportSubmissionSchema = z.object({
  summary: z.string().trim().min(1),
  findings: z.array(z.string().trim().min(1)).default([]),
  status: z.enum(["completed", "blocked"]).default("completed"),
  // Required from QA peers only: the graded brief criteria the Lead decides on.
  scorecard: z.array(ScorecardEntrySchema).optional(),
  // Things QA noticed outside the criteria; reported for the Lead's judgement, never graded.
  observations: z.array(z.string().trim().min(1)).optional(),
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
  // Null only for stages stored before stage kinds existed; those keep the old free-form behavior.
  // Runs persisted before mockups moved out of pipelines may hold a "mockup" stage; both end by locking the brief, so it reads as planning.
  kind: z.preprocess(
    (persistedKind) => (persistedKind === "mockup" ? "planning" : persistedKind),
    StageKindSchema.nullable(),
  ).default(null),
  status: StageStatusSchema.default("pending"),
  forkedLeadAgentId: z.string().nullable().default(null),
  peerAgentIds: z.array(z.string()).default([]),
  reports: z.array(StoredStageReportSchema).default([]),
  // Counts slp_stage_rework calls; reaching the run's cap hands the decision to the human via the Supervisor.
  reworkRounds: z.number().int().min(0).default(0),
  // How many of `reports` the stage coordinator has already been briefed on, so later review mail
  // carries only the new evidence instead of resending the whole history every round.
  coordinatorSeenReports: z.number().int().min(0).default(0),
  // Direct peer messages stay attached to the stage, making the review history auditable after
  // its agents are archived and preventing cross-stage conversations from being conflated.
  messages: z.array(StageMessageSchema).default([]),
  result: StageResultSchema.nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});
export type StageState = z.infer<typeof StageStateSchema>;

// Feature pipelines run in a Lead's own worktree and merge into the QA branch; QA pipelines run on the QA branch itself.
export const PIPELINE_KINDS = ["feature", "qa"] as const;
export const PipelineKindSchema = z.enum(PIPELINE_KINDS);
export type PipelineKind = z.infer<typeof PipelineKindSchema>;

export const PipelineStateSchema = PipelineDefinitionSchema.extend({
  id: z.string().min(1),
  // Older snapshots predate QA pipelines, so a missing kind means a feature pipeline.
  kind: PipelineKindSchema.default("feature"),
  status: PipelineStatusSchema.default("queued"),
  // Tracks the Lead agent that owns this pipeline's worktree and directly supervises all of its stages.
  leadAgentId: z.string().nullable().default(null),
  currentStageIndex: z.number().int().min(0).default(0),
  workspaceId: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  baseCommit: z.string().nullable().default(null),
  stages: z.array(StageStateSchema).min(1),
  // Set once (at definition or planning approval) and never edited, so later stages cannot drift from it.
  brief: PipelineBriefSchema.nullable().default(null),
  briefLockedAt: z.string().nullable().default(null),
  pausedReason: z.string().nullable().default(null),
  // True while a rework-capped stage waits for the human's decision relayed by the Supervisor;
  // the Lead cannot resume it on its own and recovery must not assign it slp_resume_pipeline.
  awaitingHumanDecision: z.boolean().default(false),
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

// A paused pipeline only owes its Lead slp_resume_pipeline when neither a human gate nor a capped-rework decision holds it.
export function awaitsLeadRecovery(pipeline: Pick<PipelineState, "status" | "gate" | "awaitingHumanDecision">): boolean {
  return pipeline.status === "paused" && !pipeline.gate && !pipeline.awaitingHumanDecision;
}
