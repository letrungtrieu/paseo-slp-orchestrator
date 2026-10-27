// Pure domain transitions for merging Brief revisions, grading QA scorecards, and marking Rework on Kanban items.
import type {
  BoardColumn,
  BoardTicket,
  BriefItem,
  BriefItemInput,
  BriefItemStatus,
} from "../../shared/board";
import type { ScorecardEntry } from "../../shared/pipeline";

// Merges incoming Brief bullets with prior ticket state so unchanged bullets preserve their QA scores while modified bullets reset.
export function mergeBriefItemsForRevision(
  priorItems: readonly BriefItem[],
  incomingItems: readonly BriefItemInput[],
  targetSpecRev: number,
  nextBriefRev: number,
): BriefItem[] {
  // Index existing bullets by their stable id (e.g. C1, B1) so reordered bullets still retain their history.
  const priorBulletById = new Map(priorItems.map((bulletItem) => [bulletItem.id, bulletItem]));

  return incomingItems.map((incomingBullet) => {
    const priorBullet = priorBulletById.get(incomingBullet.id);
    // Brand-new bullets start in 'todo' with an 'added' diff badge so developers know to implement them.
    if (!priorBullet) {
      return {
        id: incomingBullet.id,
        requirement: incomingBullet.requirement,
        verification: incomingBullet.verification,
        scope: incomingBullet.scope ?? "in",
        status: "todo",
        specRev: targetSpecRev,
        briefRev: nextBriefRev,
        diffBadge: "added",
        implementationNote: null,
        score: null,
        reworkNote: null,
      };
    }

    // Compare normalized requirement, verification, and scope to detect whether the Lead altered this bullet's contract.
    const hasContractChanged =
      priorBullet.requirement.trim() !== incomingBullet.requirement.trim()
      || priorBullet.verification.trim() !== (incomingBullet.verification ?? "").trim()
      || priorBullet.scope !== (incomingBullet.scope ?? "in");

    // When the Lead pivots technical approach on a bullet, invalidate any prior QA pass/fail score and reset to todo.
    return {
      ...priorBullet,
      requirement: incomingBullet.requirement,
      verification: incomingBullet.verification,
      scope: incomingBullet.scope ?? "in",
      status: hasContractChanged ? "todo" : priorBullet.status,
      specRev: targetSpecRev,
      briefRev: hasContractChanged ? nextBriefRev : priorBullet.briefRev,
      diffBadge: hasContractChanged ? "modified" : "unchanged",
      score: hasContractChanged ? null : priorBullet.score,
    };
  });
}

// Applies a developer or Lead status update to a single Brief bullet without disturbing sibling bullets.
export function applyBriefItemProgressUpdate(
  existingTicket: BoardTicket,
  itemId: string,
  nextStatus: BriefItemStatus,
  implementationNote?: string,
  nowIso: string = new Date().toISOString(),
): BoardTicket {
  // Reject unknown bullet ids early so agents do not silently report progress against a typoed id.
  const bulletExists = existingTicket.items.some((bulletItem) => bulletItem.id === itemId);
  if (!bulletExists) {
    throw new Error(`Brief item '${itemId}' does not exist on ticket '${existingTicket.ticketKey}'.`);
  }

  // Update only the targeted bullet while preserving existing implementation notes when no new note is supplied.
  const updatedItems = existingTicket.items.map((bulletItem) =>
    bulletItem.id === itemId
      ? {
          ...bulletItem,
          status: nextStatus,
          implementationNote: implementationNote?.trim() ?? bulletItem.implementationNote,
        }
      : bulletItem,
  );

  // Advancing any bullet out of todo ensures the ticket sits at least in the BRIEF column.
  return {
    ...existingTicket,
    column: existingTicket.column === "spec" ? "brief" : existingTicket.column,
    items: updatedItems,
    updatedAt: nowIso,
  };
}

// Applies QA scorecard verdicts to matching Brief bullets and transitions the ticket between SCORE and REWORK columns.
export function applyScorecardToTicket(
  existingTicket: BoardTicket,
  gradedBy: string,
  scorecard: readonly ScorecardEntry[],
  nowIso: string = new Date().toISOString(),
): BoardTicket {
  // Map scorecard entries by criterionId so each Brief bullet can look up its latest QA verdict in O(1).
  const scoreByCriterionId = new Map(scorecard.map((scoreEntry) => [scoreEntry.criterionId, scoreEntry]));

  const updatedItems: BriefItem[] = existingTicket.items.map((bulletItem) => {
    const matchedScore = scoreByCriterionId.get(bulletItem.id);
    if (!matchedScore) return bulletItem;
    // Copy failing reasons into reworkNote so the developer immediately sees what failed on the card.
    return {
      ...bulletItem,
      status: matchedScore.status,
      score: {
        status: matchedScore.status,
        reason: matchedScore.reason,
        evidence: matchedScore.evidence ?? "",
        gradedBy,
        gradedAt: nowIso,
      },
      reworkNote: matchedScore.status === "fail" ? matchedScore.reason : bulletItem.reworkNote,
    };
  });

  // Any failing or blocked in-scope bullet moves the card to REWORK; otherwise it stays in SCORE awaiting final approval.
  const inScopeItems = updatedItems.filter((bulletItem) => bulletItem.scope === "in");
  const hasFailingBullets = inScopeItems.some(
    (bulletItem) => bulletItem.status === "fail" || bulletItem.status === "blocked",
  );
  const nextColumn: BoardColumn = hasFailingBullets ? "rework" : "score";

  return {
    ...existingTicket,
    column: nextColumn,
    items: updatedItems,
    updatedAt: nowIso,
  };
}

// Marks targeted (or failing) in-scope Brief bullets as needing rework and moves the ticket into the REWORK column.
export function applyReworkToTicket(
  existingTicket: BoardTicket,
  feedback: string,
  itemIds?: readonly string[],
  nowIso: string = new Date().toISOString(),
): BoardTicket {
  const explicitTargetIdSet = itemIds && itemIds.length > 0 ? new Set(itemIds) : null;
  const anyBulletCurrentlyFailing = existingTicket.items.some(
    (bulletItem) => bulletItem.scope === "in" && (bulletItem.status === "fail" || bulletItem.status === "blocked"),
  );

  // If specific itemIds were given, mark those; otherwise mark failing bullets (or all in-scope bullets if none were graded yet).
  const updatedItems = existingTicket.items.map((bulletItem) => {
    if (bulletItem.scope === "out") return bulletItem;
    const shouldMarkRework = explicitTargetIdSet
      ? explicitTargetIdSet.has(bulletItem.id)
      : anyBulletCurrentlyFailing
        ? bulletItem.status === "fail" || bulletItem.status === "blocked"
        : true;
    if (!shouldMarkRework) return bulletItem;
    return {
      ...bulletItem,
      status: "rework" as const,
      reworkNote: feedback.trim(),
    };
  });

  return {
    ...existingTicket,
    column: "rework",
    items: updatedItems,
    updatedAt: nowIso,
  };
}
