// Project-scoped Kanban board contracts for tracking Spec -> Brief -> Score -> Rework across runs.
import { z } from "zod";
import type { PipelineBrief } from "./pipeline";

// The five Kanban columns mirror the lifecycle of a feature from requirement to verified delivery.
export const BOARD_COLUMNS = ["spec", "brief", "score", "rework", "done"] as const;
export const BoardColumnSchema = z.enum(BOARD_COLUMNS);
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

// Tracks each bullet item's execution and grading state so rework only targets failing bullets.
export const BRIEF_ITEM_STATUSES = [
  "todo",
  "in_progress",
  "implemented",
  "pass",
  "fail",
  "blocked",
  "rework",
] as const;
export const BriefItemStatusSchema = z.enum(BRIEF_ITEM_STATUSES);
export type BriefItemStatus = z.infer<typeof BriefItemStatusSchema>;

// Out-of-scope items remain visible on the ticket so tempting extras are explicitly excluded, not forgotten.
export const BRIEF_ITEM_SCOPES = ["in", "out"] as const;
export const BriefItemScopeSchema = z.enum(BRIEF_ITEM_SCOPES);
export type BriefItemScope = z.infer<typeof BriefItemScopeSchema>;

// Highlights which brief bullets were added or modified in the latest revision so developers focus on the delta.
export const BRIEF_ITEM_DIFF_BADGES = ["added", "modified", "unchanged"] as const;
export const BriefItemDiffBadgeSchema = z.enum(BRIEF_ITEM_DIFF_BADGES);
export type BriefItemDiffBadge = z.infer<typeof BriefItemDiffBadgeSchema>;

// Captures the QA grading verdict directly on the brief bullet so scorecards live in one canonical place.
export const BriefItemScoreSchema = z.object({
  status: z.enum(["pass", "fail", "blocked"]),
  reason: z.string().trim().min(1),
  evidence: z.string().trim().default(""),
  gradedBy: z.string().nullable().default(null),
  gradedAt: z.string(),
});
export type BriefItemScore = z.infer<typeof BriefItemScoreSchema>;

// Represents a single actionable bullet in the Lead's technical brief.
export const BriefItemSchema = z.object({
  id: z.string().trim().min(1).describe("Stable bullet id such as B1 or C1"),
  requirement: z.string().trim().min(1).describe("Problem or observable requirement to solve"),
  verification: z.string().trim().default("").describe("Command, test or manual check to verify this item"),
  scope: BriefItemScopeSchema.default("in"),
  status: BriefItemStatusSchema.default("todo"),
  // Tracks which Spec revision this bullet was derived from so Spec diffs can flag stale bullets.
  specRev: z.number().int().min(1).default(1),
  // Tracks which Brief revision last changed this bullet when the Lead switches technical approaches.
  briefRev: z.number().int().min(1).default(1),
  diffBadge: BriefItemDiffBadgeSchema.default("added"),
  implementationNote: z.string().nullable().default(null),
  score: BriefItemScoreSchema.nullable().default(null),
  reworkNote: z.string().nullable().default(null),
});
export type BriefItem = z.infer<typeof BriefItemSchema>;

// Immutable snapshot of a Spec version authored by the human operator or the Supervisor.
export const SpecRevisionSchema = z.object({
  rev: z.number().int().min(1),
  author: z.enum(["human", "supervisor"]),
  summary: z.string().trim().default(""),
  content: z.string(),
  // Git-style unified diff against the immediately preceding Spec revision.
  diff: z.string().default(""),
  createdAt: z.string(),
});
export type SpecRevision = z.infer<typeof SpecRevisionSchema>;

// Immutable snapshot of a Brief version authored by a Lead when planning or adapting to implementation conflicts.
export const BriefRevisionSchema = z.object({
  rev: z.number().int().min(1),
  specRev: z.number().int().min(1),
  authorAgentId: z.string(),
  // Explains why the brief changed (for example switching techniques after an implementation or merge conflict).
  reason: z.string().trim().default(""),
  approach: z.string().trim().default(""),
  items: z.array(BriefItemSchema).default([]),
  // Git-style unified diff against the immediately preceding Brief revision.
  diff: z.string().default(""),
  createdAt: z.string(),
});
export type BriefRevision = z.infer<typeof BriefRevisionSchema>;

// Live agent projection attached to a Kanban card so the human can see who is working or paused in realtime.
export const BoardAgentActivitySchema = z.object({
  agentId: z.string(),
  role: z.string(),
  projectRole: z.string().nullable().default(null),
  stageName: z.string().nullable().default(null),
  pausedAt: z.string().nullable().default(null),
  pausedReason: z.string().nullable().default(null),
  awaitingTool: z.string().nullable().default(null),
});
export type BoardAgentActivity = z.infer<typeof BoardAgentActivitySchema>;

// Project-scoped Kanban ticket uniting Spec revisions, mutable Brief bullets, QA Scores and Rework items.
export const BoardTicketSchema = z.object({
  id: z.string().min(1),
  ticketKey: z.string().min(1),
  repoPath: z.string().min(1),
  title: z.string().trim().min(1),
  acceptanceCriteria: z.string().default(""),
  column: BoardColumnSchema.default("spec"),
  currentSpecRev: z.number().int().min(0).default(0),
  currentBriefRev: z.number().int().min(0).default(0),
  // When currentSpecRev > lastSyncedSpecRev, the UI and Lead know the Spec changed since the Brief was written.
  lastSyncedSpecRev: z.number().int().min(0).default(0),
  specRevisions: z.array(SpecRevisionSchema).default([]),
  briefRevisions: z.array(BriefRevisionSchema).default([]),
  approach: z.string().default(""),
  items: z.array(BriefItemSchema).default([]),
  activeRunId: z.string().nullable().default(null),
  activePipelineId: z.string().nullable().default(null),
  leadAgentId: z.string().nullable().default(null),
  activeAgents: z.array(BoardAgentActivitySchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BoardTicket = z.infer<typeof BoardTicketSchema>;

// Input schema for the Lead's tool to create or revise the Brief when planning or resolving conflicts.
export const BriefItemInputSchema = z.object({
  id: z.string().trim().min(1).describe("Stable bullet id, e.g. B1 or C1"),
  requirement: z.string().trim().min(1).describe("Problem or observable requirement to solve"),
  verification: z.string().trim().default("").describe("How to verify this bullet (command, test or manual check)"),
  scope: BriefItemScopeSchema.default("in"),
});
export type BriefItemInput = z.infer<typeof BriefItemInputSchema>;

// Converts a legacy or pipeline-level PipelineBrief into structured Kanban BriefItem entries.
export function briefItemsFromPipelineBrief(
  pipelineBrief: PipelineBrief,
  specRev: number,
  briefRev: number,
): BriefItem[] {
  const inScopeBullets: BriefItem[] = pipelineBrief.criteria.map((criterion) => ({
    id: criterion.id,
    requirement: criterion.requirement,
    verification: criterion.verification,
    scope: "in",
    status: "todo",
    specRev,
    briefRev,
    diffBadge: "added",
    implementationNote: null,
    score: null,
    reworkNote: null,
  }));
  // Include explicit inScope bullets that are not already covered verbatim by criteria requirements.
  const criterionRequirements = new Set(pipelineBrief.criteria.map((criterion) => criterion.requirement.trim().toLowerCase()));
  for (const [scopeIndex, scopeItemText] of pipelineBrief.inScope.entries()) {
    if (criterionRequirements.has(scopeItemText.trim().toLowerCase())) continue;
    inScopeBullets.push({
      id: `S${scopeIndex + 1}`,
      requirement: scopeItemText,
      verification: "Inspect implementation and fast-tier tests",
      scope: "in",
      status: "todo",
      specRev,
      briefRev,
      diffBadge: "added",
      implementationNote: null,
      score: null,
      reworkNote: null,
    });
  }
  const outOfScopeBullets: BriefItem[] = pipelineBrief.outOfScope.map((outScopeText, outIndex) => ({
    id: `OUT-${outIndex + 1}`,
    requirement: outScopeText,
    verification: "Out of scope — do not build",
    scope: "out",
    status: "todo",
    specRev,
    briefRev,
    diffBadge: "added",
    implementationNote: null,
    score: null,
    reworkNote: null,
  }));
  return [...inScopeBullets, ...outOfScopeBullets];
}

// Converts Kanban BriefItem entries back into a PipelineBrief so existing stage briefings and QA scorecards stay aligned.
export function pipelineBriefFromTicket(approach: string, items: readonly BriefItem[]): PipelineBrief {
  const inScopeItems = items.filter((bulletItem) => bulletItem.scope === "in");
  const outOfScopeItems = items.filter((bulletItem) => bulletItem.scope === "out");
  const effectiveInScope = inScopeItems.length > 0
    ? inScopeItems
    : [{
        id: "B1",
        requirement: approach || "Implement ticket specification",
        verification: "Verify against acceptance criteria",
        scope: "in" as const,
        status: "todo" as const,
        specRev: 1,
        briefRev: 1,
        diffBadge: "added" as const,
        implementationNote: null,
        score: null,
        reworkNote: null,
      }];
  return {
    approach: approach.trim() || "Implement ticket specification",
    criteria: effectiveInScope.map((bulletItem) => ({
      id: bulletItem.id,
      requirement: bulletItem.requirement,
      verification: bulletItem.verification || "Verify implementation and tests",
    })),
    inScope: effectiveInScope.map((bulletItem) => bulletItem.requirement),
    outOfScope: outOfScopeItems.map((bulletItem) => bulletItem.requirement),
  };
}
