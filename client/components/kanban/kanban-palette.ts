// Color palette, tag formatting, and card-column routing linking each Spec to its Brief and gradable Option cards.
import type { BoardColumn, BoardTicket, BriefItem } from "../../../shared/board";

export interface SpecColorIdentity {
  borderColor: string;
  badgeBackground: string;
  badgeTextColor: string;
  briefTagCode: string;
}

// Selection state discriminating whether the user clicked a Spec card, a Brief overview card, or a single Option card.
export type KanbanCardSelection =
  | { kind: "spec"; ticketId: string }
  | { kind: "brief"; ticketId: string }
  | { kind: "option"; ticketId: string; optionId: string };

// Distinct, high-contrast color palette so each Spec and all of its child Brief/Option cards share a recognizable border color.
const SPEC_COLOR_PALETTE: ReadonlyArray<{
  borderColor: string;
  badgeBackground: string;
  badgeTextColor: string;
}> = [
  { borderColor: "#3B82F6", badgeBackground: "rgba(59, 130, 246, 0.16)", badgeTextColor: "#60A5FA" },
  { borderColor: "#A855F7", badgeBackground: "rgba(168, 85, 247, 0.16)", badgeTextColor: "#C084FC" },
  { borderColor: "#10B981", badgeBackground: "rgba(16, 185, 129, 0.16)", badgeTextColor: "#34D399" },
  { borderColor: "#F59E0B", badgeBackground: "rgba(245, 158, 11, 0.16)", badgeTextColor: "#FBBF24" },
  { borderColor: "#EC4899", badgeBackground: "rgba(236, 72, 153, 0.16)", badgeTextColor: "#F472B6" },
  { borderColor: "#06B6D4", badgeBackground: "rgba(6, 182, 212, 0.16)", badgeTextColor: "#22D3EE" },
];

// Extracts the numeric suffix from a ticket key like SLP-1 so color assignment stays stable across refreshes.
function parseTicketSequenceNumber(ticketKey: string): number {
  const numericMatch = /(\d+)$/.exec(ticketKey.trim());
  if (!numericMatch) return 0;
  return Math.max(0, Number.parseInt(numericMatch[1], 10) - 1);
}

// Computes the shared border color and tag codes that visually bind a Spec card, its Brief card, and its Option cards together.
export function resolveSpecColorIdentity(ticket: BoardTicket): SpecColorIdentity {
  const paletteIndex = parseTicketSequenceNumber(ticket.ticketKey) % SPEC_COLOR_PALETTE.length;
  const chosenPaletteEntry = SPEC_COLOR_PALETTE[paletteIndex];
  // Derive a short Brief code (e.g. B-SLP-1) so every Option card can tag both its parent Spec and parent Brief.
  return {
    borderColor: chosenPaletteEntry.borderColor,
    badgeBackground: chosenPaletteEntry.badgeBackground,
    badgeTextColor: chosenPaletteEntry.badgeTextColor,
    briefTagCode: `B-${ticket.ticketKey}`,
  };
}

// Separates gradable Brief options (each rendered as its own Kanban card) from general in-scope/out-of-scope notes.
export function partitionTicketBriefItems(ticket: BoardTicket): {
  gradableOptions: BriefItem[];
  inScopeNotes: BriefItem[];
  outOfScopeNotes: BriefItem[];
} {
  const outOfScopeNotes = ticket.items.filter((briefBullet) => briefBullet.scope === "out");
  const inScopeItems = ticket.items.filter((briefBullet) => briefBullet.scope === "in");

  // Detect auto-generated S1..Sn scope bullets when explicit C1..Cn criteria exist so only real options become cards.
  const isGeneratedScopeEcho = (briefBullet: BriefItem): boolean =>
    /^S\d+$/i.test(briefBullet.id) &&
    briefBullet.verification === "Inspect implementation and fast-tier tests" &&
    briefBullet.score === null;

  const explicitGradableOptions = inScopeItems.filter((briefBullet) => !isGeneratedScopeEcho(briefBullet));
  // If a ticket only has S1..Sn items and no explicit C1..Cn criteria, treat those in-scope items as the gradable options.
  if (explicitGradableOptions.length === 0) {
    return {
      gradableOptions: inScopeItems,
      inScopeNotes: [],
      outOfScopeNotes,
    };
  }

  return {
    gradableOptions: explicitGradableOptions,
    inScopeNotes: inScopeItems.filter(isGeneratedScopeEcho),
    outOfScopeNotes,
  };
}

// Routes each individual Option card to its own Kanban column (BRIEF -> SCORE -> REWORK -> DONE) based on its grading state.
export function resolveOptionCardColumn(
  parentTicket: BoardTicket,
  optionBullet: BriefItem,
): Exclude<BoardColumn, "spec"> {
  // Failing or rework-flagged options always appear in 4. REWORK so the operator sees what needs fixing.
  if (
    optionBullet.status === "fail" ||
    optionBullet.status === "rework" ||
    optionBullet.score?.status === "fail"
  ) {
    return "rework";
  }
  // Once the parent feature run is merged and completed, passing options rest in 5. DONE.
  if (parentTicket.column === "done" && optionBullet.status === "pass") {
    return "done";
  }
  // Options that have been graded by QA (pass or blocked) or belong to a ticket in the score phase appear in 3. SCORE.
  if (
    optionBullet.score !== null ||
    optionBullet.status === "pass" ||
    optionBullet.status === "blocked"
  ) {
    return "score";
  }
  // Unscored options (todo, in_progress, implemented) stay in 2. BRIEF while the Lead and developer work on them.
  return "brief";
}
