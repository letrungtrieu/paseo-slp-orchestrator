// Pure state transitions for the single HTML/CSS/JS mockup file linked to a Kanban ticket.
import { randomUUID } from "node:crypto";
import {
  deriveFeatureMockupSlug,
  TicketMockupSchema,
  type BoardColumn,
  type BoardTicket,
  type MockupElementComment,
  type MockupElementCommentInput,
  type MockupElementTarget,
  type TicketMockup,
} from "../../shared/board";

export interface SaveTicketMockupParams {
  file: string;
  summary: string;
  authorAgentId: string;
}

export interface RecordMockupFeedbackParams {
  feedback?: string;
  elementComments?: readonly MockupElementCommentInput[];
}

// Format element-level HTML tag comments and Design-mode image/Canvas sprite asset comments into a structured Markdown list for Product Agent / Codex prompts.
export function formatMockupElementCommentsMarkdown(
  elementComments: readonly Pick<
    MockupElementComment,
    "selector" | "tagName" | "elementText" | "assetPath" | "imageDimensions" | "comment" | "targets"
  >[],
): string {
  if (elementComments.length === 0) return "";
  let hasImageAssetComment = false;
  const describeTarget = (
    target: Pick<MockupElementTarget, "selector" | "tagName" | "elementText" | "assetPath" | "imageDimensions">,
  ): string => {
    const snippetLabel = target.elementText.trim() ? ` ("${target.elementText.trim().slice(0, 60)}")` : "";
    const trimmedAssetPath = target.assetPath?.trim() ?? "";
    const trimmedDimensions = target.imageDimensions?.trim() ?? "";
    if (trimmedAssetPath) {
      hasImageAssetComment = true;
    }
    // Include the relative disk path and resolution when the human commented on an image or <canvas> sprite in Design mode.
    const assetBadge = trimmedAssetPath
      ? ` [Image Asset: \`${trimmedAssetPath}\`${trimmedDimensions ? ` · ${trimmedDimensions}` : ""}]`
      : "";
    return `\`<${target.tagName}>\` selector \`${target.selector}\`${snippetLabel}${assetBadge}`;
  };
  const formattedLines = elementComments.map((commentEntry, commentIndex) => {
    // A drag-select note names every picked element or sprite on its own line so the agent edits all of them.
    if (commentEntry.targets.length > 1) {
      const targetLines = commentEntry.targets.map((target) => `   - ${describeTarget(target)}`).join("\n");
      return `${commentIndex + 1}. ${commentEntry.targets.length} elements: ${commentEntry.comment.trim()}\n${targetLines}`;
    }
    return `${commentIndex + 1}. ${describeTarget(commentEntry)}: ${commentEntry.comment.trim()}`;
  });
  const imageEditInstruction = hasImageAssetComment
    ? "\n> **Design / Image Asset Edit Note:** Với các mục có `[Image Asset: ...]`, hãy chỉnh sửa hoặc tái tạo trực tiếp file ảnh/SVG/sprite tương ứng trên ổ đĩa (trong `.slp/mockup/`) cùng với HTML/CSS/JS."
    : "";
  return `### HTML & Design Asset Comments\n${formattedLines.join("\n")}${imageEditInstruction}`;
}

// A feature that is back under review returns to MOCKUP, while tickets already in Brief or later stay where delivery has them.
function reviewColumnFor(ticket: BoardTicket): BoardColumn {
  return ticket.column === "spec" || ticket.column === "mockup" || ticket.column === "done"
    ? "mockup"
    : ticket.column;
}

// Mockup-first features have no Spec yet, so the ticket is created here with zero Spec revisions.
export function createMockupTicket(params: {
  ticketKey: string;
  repoPath: string;
  title: string;
  nowIso: string;
}): BoardTicket {
  return {
    id: randomUUID(),
    ticketKey: params.ticketKey,
    repoPath: params.repoPath,
    title: params.title,
    featureSlug: deriveFeatureMockupSlug(params.title, params.ticketKey),
    acceptanceCriteria: "",
    column: "mockup",
    currentSpecRev: 0,
    currentBriefRev: 0,
    lastSyncedSpecRev: 0,
    specMockupCommit: null,
    specRevisions: [],
    mockup: null,
    briefRevisions: [],
    approach: "",
    items: [],
    activeRunId: null,
    activePipelineId: null,
    leadAgentId: null,
    activeAgents: [],
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
  };
}

// Any edit invalidates an earlier approval, and open notes are cleared because the author was told to address them all.
export function applyMockupUpdateToTicket(
  existingTicket: BoardTicket,
  update: SaveTicketMockupParams,
): BoardTicket {
  const nowIsoTimestamp = new Date().toISOString();
  return {
    ...existingTicket,
    column: reviewColumnFor(existingTicket),
    mockup: {
      file: update.file,
      summary: update.summary.trim(),
      status: "draft",
      approvedCommit: null,
      approvedAt: null,
      feedback: null,
      elementComments: [],
      authorAgentId: update.authorAgentId,
      updatedAt: nowIsoTimestamp,
    },
    updatedAt: nowIsoTimestamp,
  };
}

// Replaces the open notes with the Studio's full draft list, and asking for changes withdraws any earlier approval.
export function applyMockupFeedbackToTicket(
  existingTicket: BoardTicket,
  review: RecordMockupFeedbackParams,
): BoardTicket {
  if (!existingTicket.mockup) {
    throw new Error(`Ticket '${existingTicket.ticketKey}' has no mockup to review yet.`);
  }
  const nowIsoTimestamp = new Date().toISOString();
  const normalizedElementComments: MockupElementComment[] = (review.elementComments ?? []).map(
    (rawComment) => ({
      id: rawComment.id?.trim() || randomUUID(),
      selector: rawComment.selector.trim(),
      tagName: rawComment.tagName.trim().toLowerCase() || "div",
      elementText: rawComment.elementText.trim(),
      assetPath: rawComment.assetPath?.trim() || undefined,
      imagePreviewUri: rawComment.imagePreviewUri?.trim() || undefined,
      imageDimensions: rawComment.imageDimensions?.trim() || undefined,
      targets: (rawComment.targets ?? []).map((targetItem) => ({
        selector: targetItem.selector.trim(),
        tagName: targetItem.tagName.trim().toLowerCase() || "div",
        elementText: targetItem.elementText.trim(),
        assetPath: targetItem.assetPath?.trim() || undefined,
        imagePreviewUri: targetItem.imagePreviewUri?.trim() || undefined,
        imageDimensions: targetItem.imageDimensions?.trim() || undefined,
      })),
      comment: rawComment.comment.trim(),
      createdAt: nowIsoTimestamp,
    }),
  );
  return {
    ...existingTicket,
    column: reviewColumnFor(existingTicket),
    mockup: {
      ...existingTicket.mockup,
      status: "draft",
      approvedCommit: null,
      approvedAt: null,
      feedback: review.feedback?.trim() || null,
      elementComments: normalizedElementComments,
      updatedAt: nowIsoTimestamp,
    },
    updatedAt: nowIsoTimestamp,
  };
}

// Approval moves the ticket on to SPEC so the decided mockup can be written up.
export function applyMockupApprovalToTicket(
  existingTicket: BoardTicket,
  approvedCommit: string,
): BoardTicket {
  if (!existingTicket.mockup) {
    throw new Error(`Ticket '${existingTicket.ticketKey}' has no mockup to approve yet.`);
  }
  const nowIsoTimestamp = new Date().toISOString();
  return {
    ...existingTicket,
    column: existingTicket.column === "mockup" ? "spec" : existingTicket.column,
    mockup: {
      ...existingTicket.mockup,
      status: "approved",
      approvedCommit,
      approvedAt: nowIsoTimestamp,
      feedback: null,
      elementComments: [],
      updatedAt: nowIsoTimestamp,
    },
    updatedAt: nowIsoTimestamp,
  };
}

interface LegacyMockupRevision {
  entryHtmlPath?: string;
  summary?: string;
  status?: string;
  feedback?: string | null;
  elementComments?: unknown[];
  authorAgentId?: string;
  createdAt?: string;
  reviewedAt?: string | null;
}

// Tickets saved before the single-file mockup keep pointing at their newest archived version, so old work stays previewable.
export function upgradeLegacyTicketPayload(storedPayload: Record<string, unknown>): Record<string, unknown> {
  const legacyRevisions = storedPayload.mockupRevisions as LegacyMockupRevision[] | undefined;
  const newestRevision = legacyRevisions?.at(-1);
  if (storedPayload.mockup !== undefined || !newestRevision?.entryHtmlPath) return storedPayload;
  const wasApproved = storedPayload.approvedMockupRev != null;
  const upgradedMockup: TicketMockup = TicketMockupSchema.parse({
    file: newestRevision.entryHtmlPath,
    summary: newestRevision.summary ?? "",
    status: wasApproved ? "approved" : "draft",
    approvedAt: wasApproved ? newestRevision.reviewedAt ?? null : null,
    feedback: newestRevision.feedback ?? null,
    elementComments: newestRevision.elementComments ?? [],
    authorAgentId: newestRevision.authorAgentId ?? "",
    updatedAt: newestRevision.createdAt ?? new Date(0).toISOString(),
  });
  return { ...storedPayload, mockup: upgradedMockup };
}
