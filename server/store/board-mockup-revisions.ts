// Pure state transition helpers for multi-version HTML/CSS/JS Mockup revisions on Kanban tickets.
import { randomUUID } from "node:crypto";
import {
  deriveFeatureMockupSlug,
  type BoardColumn,
  type BoardTicket,
  type MockupElementComment,
  type MockupElementCommentInput,
  type MockupRevision,
} from "../../shared/board";

export interface SaveMockupRevisionParams {
  authorAgentId: string;
  title?: string;
  summary?: string;
  featureSlug?: string;
  workingDirPath: string;
  versionDirPath: string;
  entryHtmlPath: string;
  activePipelineId?: string | null;
  leadAgentId?: string | null;
}

export interface ReviewMockupRevisionParams {
  decision: "approve" | "rework";
  version?: number;
  feedback?: string;
  elementComments?: readonly MockupElementCommentInput[];
}

// Format element-level HTML tag comments into a structured Markdown list for Lead and peer rework prompts.
export function formatMockupElementCommentsMarkdown(
  elementComments: readonly Pick<MockupElementComment, "selector" | "tagName" | "elementText" | "comment">[],
): string {
  if (elementComments.length === 0) return "";
  const formattedLines = elementComments.map((commentEntry, commentIndex) => {
    const snippetLabel = commentEntry.elementText.trim()
      ? ` ("${commentEntry.elementText.trim().slice(0, 60)}")`
      : "";
    return `${commentIndex + 1}. \`<${commentEntry.tagName}>\` selector \`${commentEntry.selector}\`${snippetLabel}: ${commentEntry.comment.trim()}`;
  });
  return `### HTML Element Comments\n${formattedLines.join("\n")}`;
}

// Appends a newly snapshotted HTML mockup version (v1, v2, ...) to a ticket and transitions SPEC -> MOCKUP.
export function applyMockupSubmissionToTicket(
  existingTicket: BoardTicket,
  submission: SaveMockupRevisionParams,
): BoardTicket {
  const nowIsoTimestamp = new Date().toISOString();
  const nextMockupVersion = existingTicket.currentMockupRev + 1;
  const targetSpecRevision = Math.max(1, existingTicket.currentSpecRev);
  const resolvedFeatureSlug =
    submission.featureSlug?.trim() ||
    existingTicket.featureSlug ||
    deriveFeatureMockupSlug(existingTicket.title, existingTicket.ticketKey);

  // Supersede any older unreviewed mockup draft when a newer version is submitted.
  const priorMockupRevisions: MockupRevision[] = existingTicket.mockupRevisions.map(
    (previousRevision) =>
      previousRevision.status === "pending_review"
        ? { ...previousRevision, status: "superseded" as const }
        : previousRevision,
  );

  const createdMockupRevision: MockupRevision = {
    version: nextMockupVersion,
    specRev: targetSpecRevision,
    title: submission.title?.trim() || existingTicket.title,
    summary:
      submission.summary?.trim() ||
      (nextMockupVersion === 1
        ? "Initial interactive HTML/CSS/JS mockup"
        : `Updated interactive HTML/CSS/JS mockup (v${nextMockupVersion})`),
    featureSlug: resolvedFeatureSlug,
    workingDirPath: submission.workingDirPath,
    versionDirPath: submission.versionDirPath,
    entryHtmlPath: submission.entryHtmlPath,
    status: "pending_review",
    feedback: null,
    elementComments: [],
    authorAgentId: submission.authorAgentId,
    createdAt: nowIsoTimestamp,
    reviewedAt: null,
  };

  // Transition the ticket into the MOCKUP column while preserving later columns if already in BRIEF/SCORE.
  const nextBoardColumn: BoardColumn =
    existingTicket.column === "spec" ||
    existingTicket.column === "mockup" ||
    existingTicket.column === "done"
      ? "mockup"
      : existingTicket.column;

  return {
    ...existingTicket,
    featureSlug: resolvedFeatureSlug,
    column: nextBoardColumn,
    currentMockupRev: nextMockupVersion,
    mockupRevisions: [...priorMockupRevisions, createdMockupRevision],
    activePipelineId:
      submission.activePipelineId !== undefined
        ? submission.activePipelineId
        : existingTicket.activePipelineId,
    leadAgentId:
      submission.leadAgentId !== undefined ? submission.leadAgentId : existingTicket.leadAgentId,
    updatedAt: nowIsoTimestamp,
  };
}

// Records human/Supervisor approval or rework feedback (including element-tag comments) on a mockup version.
export function applyMockupReviewToTicket(
  existingTicket: BoardTicket,
  review: ReviewMockupRevisionParams,
): BoardTicket {
  if (existingTicket.mockupRevisions.length === 0) {
    throw new Error(
      `Ticket '${existingTicket.ticketKey}' has no submitted HTML mockup versions to review yet.`,
    );
  }

  const targetMockupVersion = review.version ?? existingTicket.currentMockupRev;
  const matchingRevisionExists = existingTicket.mockupRevisions.some(
    (candidateRevision) => candidateRevision.version === targetMockupVersion,
  );
  if (!matchingRevisionExists) {
    throw new Error(
      `Ticket '${existingTicket.ticketKey}' does not have mockup version v${targetMockupVersion}.`,
    );
  }

  const nowIsoTimestamp = new Date().toISOString();
  const normalizedElementComments: MockupElementComment[] = (review.elementComments ?? []).map(
    (rawComment) => ({
      id: rawComment.id?.trim() || randomUUID(),
      selector: rawComment.selector.trim(),
      tagName: rawComment.tagName.trim().toLowerCase() || "div",
      elementText: rawComment.elementText.trim(),
      comment: rawComment.comment.trim(),
      createdAt: nowIsoTimestamp,
    }),
  );

  const elementCommentsMarkdown = formatMockupElementCommentsMarkdown(normalizedElementComments);
  const rawFeedbackText = review.feedback?.trim() || "";
  const combinedFeedbackText = [rawFeedbackText, elementCommentsMarkdown]
    .filter((sectionText) => sectionText.length > 0)
    .join("\n\n");

  const updatedMockupRevisions: MockupRevision[] = existingTicket.mockupRevisions.map(
    (candidateRevision) => {
      if (candidateRevision.version !== targetMockupVersion) {
        return candidateRevision;
      }
      return {
        ...candidateRevision,
        status: review.decision === "approve" ? "approved" : "rework_requested",
        feedback:
          combinedFeedbackText ||
          (review.decision === "rework"
            ? "Human requested adjustments in a new mockup version."
            : candidateRevision.feedback),
        elementComments:
          normalizedElementComments.length > 0
            ? normalizedElementComments
            : candidateRevision.elementComments,
        reviewedAt: nowIsoTimestamp,
      };
    },
  );

  // Keep the ticket in MOCKUP when rework is requested so the human sees it awaiting the next version.
  const nextBoardColumn: BoardColumn =
    review.decision === "rework" &&
    (existingTicket.column === "spec" || existingTicket.column === "mockup")
      ? "mockup"
      : existingTicket.column;

  return {
    ...existingTicket,
    column: nextBoardColumn,
    approvedMockupRev:
      review.decision === "approve" ? targetMockupVersion : existingTicket.approvedMockupRev,
    mockupRevisions: updatedMockupRevisions,
    updatedAt: nowIsoTimestamp,
  };
}
