// These schemas decode task runs written by the retired task engine.
// The dynamic pipeline engine uses shared/pipeline.ts and must not add new rows here.
import { z } from "zod";
import { StoredAcceptanceReportSchema, StoredPeerReportSchema } from "./reports";

// Historical task phases remain stable so old cards and SQLite rows can be rendered after migration.
export const TASK_PHASES = [
  "queued",
  "handshaking",
  "implementing",
  "verifying",
  "fixing",
  "documenting",
  "ready_for_merge",
  "merged",
  "paused",
  "failed",
] as const;
export const TaskPhaseSchema = z.enum(TASK_PHASES);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

// These gates belonged to the retired task lifecycle; dynamic stages have their own gate contract.
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

// Minimal historical task definition retained only so read-only SQLite rows remain parseable.
export const TaskDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  writableScope: z.array(z.string()).min(1),
  forbidden: z.array(z.string()).default([]),
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
export type TaskWorkspace = z.infer<typeof TaskWorkspaceSchema>;

// These limits are retained only to interpret old task rows and cards.
export const FIX_LOOP_LIMIT = 3;
export const HANDSHAKE_ROUND_LIMIT = 4;
export const SCOPE_VIOLATION_LIMIT = 3;

// Defaults let historical JSON and SQLite snapshots load without fixed capability role fields.
export const TaskSchema = TaskDefinitionSchema.extend({
  phase: TaskPhaseSchema,
  pausedReason: z.string().nullable().default(null),
  pausedFromPhase: TaskPhaseSchema.nullable().default(null),
  fixLoopCount: z.number().int().default(0),
  handshakeRounds: z.number().int().default(0),
  scopeViolations: z.number().int().default(0),
  workspace: TaskWorkspaceSchema.nullable().default(null),
  agentIds: z.record(z.string(), z.string()).default({}),
  plan: PlanSchema.nullable().default(null),
  roundVerdicts: z.record(z.string(), VerdictRecordSchema).default({}),
  gate: GateSchema.nullable().default(null),
  implementationSummary: z.string().nullable().default(null),
  acceptanceReport: StoredAcceptanceReportSchema.nullable().default(null),
  peerReports: z.array(StoredPeerReportSchema).default([]),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;
