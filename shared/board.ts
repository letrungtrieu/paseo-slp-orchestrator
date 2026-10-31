// Project-scoped Kanban board contracts for tracking Mockup -> Spec -> Brief -> Score -> Rework across runs.
import { z } from "zod";
import type { PipelineBrief } from "./pipeline";

// The six Kanban columns mirror a feature's lifecycle: ideas take shape in the mockup, the Spec records what was decided, then a Run delivers it.
export const BOARD_COLUMNS = ["mockup", "spec", "brief", "score", "rework", "done"] as const;
export const BoardColumnSchema = z.enum(BOARD_COLUMNS);
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

// Single git-tracked mockup source for the whole project: one HTML file per feature sharing `core/` CSS and JS so every mockup keeps one style.
export const MOCKUP_ROOT = ".slp/mockup";

// Git owns the history of a mockup file, so a ticket only tracks whether the human has approved its current content.
export const MOCKUP_STATUSES = ["draft", "approved"] as const;
export const MockupStatusSchema = z.enum(MOCKUP_STATUSES);
export type MockupStatus = z.infer<typeof MockupStatusSchema>;

// Review comment anchored to a specific HTML element/tag inside a feature mockup file.
export const MockupElementCommentSchema = z.object({
  id: z.string().trim().min(1),
  selector: z.string().trim().min(1).describe("CSS selector or DOM path of the target HTML element"),
  tagName: z.string().trim().default("div").describe("Lowercase HTML tag name such as button, input, or section"),
  elementText: z.string().trim().default("").describe("Short visible text or attribute snippet of the HTML element"),
  comment: z.string().trim().min(1).describe("Human review instructions for modifying this HTML element"),
  createdAt: z.string(),
});
export type MockupElementComment = z.infer<typeof MockupElementCommentSchema>;

export const MockupElementCommentInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1),
  tagName: z.string().trim().default("div"),
  elementText: z.string().trim().default(""),
  comment: z.string().trim().min(1),
});
export type MockupElementCommentInput = z.infer<typeof MockupElementCommentInputSchema>;

// A ticket's link to its feature mockup file, plus the open review notes the Product Agent still has to address.
export const TicketMockupSchema = z.object({
  file: z.string().trim().min(1).describe("Repository-relative path such as .slp/mockup/checkout.html"),
  summary: z.string().trim().default(""),
  status: MockupStatusSchema.default("draft"),
  // Pins the exact content the human approved, because the file itself can keep changing afterwards.
  approvedCommit: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  feedback: z.string().nullable().default(null),
  elementComments: z.array(MockupElementCommentSchema).default([]),
  authorAgentId: z.string(),
  updatedAt: z.string(),
});
export type TicketMockup = z.infer<typeof TicketMockupSchema>;

// Normalize a feature or ticket title into a filesystem-safe slug for `.slp/mockup/<feature>.html`.
export function deriveFeatureMockupSlug(rawFeatureName: string, fallbackKey = "feature"): string {
  const asciiNormalized = rawFeatureName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (asciiNormalized.length > 0) {
    return asciiNormalized.slice(0, 64).replace(/-+$/g, "");
  }
  return fallbackKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "feature";
}

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
  featureSlug: z.string().default(""),
  acceptanceCriteria: z.string().default(""),
  column: BoardColumnSchema.default("spec"),
  currentSpecRev: z.number().int().min(0).default(0),
  currentBriefRev: z.number().int().min(0).default(0),
  // When currentSpecRev > lastSyncedSpecRev, the UI and Lead know the Spec changed since the Brief was written.
  lastSyncedSpecRev: z.number().int().min(0).default(0),
  // Approved mockup commit the current Spec was last written or reviewed against; a different approved commit means the Spec awaits review.
  specMockupCommit: z.string().nullable().default(null),
  specRevisions: z.array(SpecRevisionSchema).default([]),
  mockup: TicketMockupSchema.nullable().default(null),
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

// A draft mockup is still moving, so a Spec written now would describe something the human has not settled on.
export function describeSpecWriteBlocker(ticket: Pick<BoardTicket, "ticketKey" | "mockup">): string | null {
  if (!ticket.mockup || ticket.mockup.status === "approved") return null;
  return `The mockup of '${ticket.ticketKey}' is still a draft, so its Spec cannot be written or changed yet. Change the mockup only; when the human approves it, the engine asks for the Spec.`;
}

// True when the human approved a mockup commit that the existing Spec has not been checked against, which is what re-approval after an edit leaves behind.
export function specNeedsMockupReview(
  ticket: Pick<BoardTicket, "currentSpecRev" | "mockup" | "specMockupCommit">,
): boolean {
  return (
    ticket.currentSpecRev >= 1 &&
    ticket.mockup?.status === "approved" &&
    ticket.specMockupCommit !== ticket.mockup.approvedCommit
  );
}

// Explains why a ticket cannot start a Run yet, or returns null when it is ready; shared so the UI and daemon apply the same gate.
export function describeTicketRunBlocker(
  ticket: Pick<BoardTicket, "ticketKey" | "currentSpecRev" | "mockup" | "activeRunId" | "specMockupCommit">,
): string | null {
  if (ticket.activeRunId) return `Ticket '${ticket.ticketKey}' already belongs to a Run.`;
  // An unapproved mockup means the idea is still moving, so a Run would build something the human has not settled on.
  if (ticket.mockup && ticket.mockup.status !== "approved") {
    return `Approve the mockup of '${ticket.ticketKey}' before starting a Run.`;
  }
  if (ticket.currentSpecRev < 1) return `Write the Spec of '${ticket.ticketKey}' before starting a Run.`;
  // After a mockup edit and re-approval the Spec may no longer match what the Run would build.
  if (specNeedsMockupReview(ticket)) {
    return `Review the Spec of '${ticket.ticketKey}' against its re-approved mockup before starting a Run.`;
  }
  return null;
}

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
