// MCP bus tool and UI operations for the single HTML/CSS/JS mockup file linked to a Kanban ticket.
import {
  deriveFeatureMockupSlug,
  type BoardTicket,
  type MockupElementCommentInput,
} from "../../shared/board";
import type { BusCaller } from "../bus/http-mcp";
import { formatMockupElementCommentsMarkdown } from "../store/board-mockup";
import { resolveTargetTicketForCaller } from "./board-tools";
import type { PipelineContext } from "./context";
import {
  assertMockupFileExists,
  normalizeMockupFilePath,
  resolveApprovedMockupCommit,
} from "./mockup-files";
import { bindProductAgentToTicket, promptProductAgentForTicket } from "./product-agent";
import { liveRunForTicket, notifySupervisorOfMockupChange } from "./ticket-change-notices";
import { ToolError } from "./tool-error";

// `slp_board_set_mockup`: links the file the Product Agent wrote to its card, creating the card for a brand-new idea.
export async function setBoardMockup(
  ctx: PipelineContext,
  caller: BusCaller,
  input: { ticketId?: string; title?: string; file?: string; summary: string },
): Promise<string> {
  const repoPath = caller.repoPath ?? "";
  if (!repoPath) throw new ToolError("No project repository is associated with this session.");
  const existingTicket = input.ticketId
    ? resolveTargetTicketForCaller(ctx, undefined, caller, input.ticketId)
    : null;
  const fallbackFeatureName = input.title?.trim() || existingTicket?.title;
  if (!input.file && !fallbackFeatureName) {
    throw new ToolError("Provide file (for example 'checkout.html') or title for a new mockup.");
  }
  const mockupFile = normalizeMockupFilePath(
    input.file ?? `${deriveFeatureMockupSlug(fallbackFeatureName ?? "feature")}.html`,
  );
  await assertMockupFileExists(repoPath, mockupFile);

  const wasApproved = existingTicket?.mockup?.status === "approved";
  const updatedTicket = ctx.store.board.saveMockup({
    repoPath,
    ticketIdOrKey: existingTicket?.id,
    title: input.title,
    file: mockupFile,
    summary: input.summary,
    authorAgentId: caller.agentId,
  });
  bindProductAgentToTicket(caller.agentId, updatedTicket.id);

  // Editing an approved mockup withdraws what a running Lead may be building against, so that Lead's Supervisor must hear about it.
  const boundRun = wasApproved ? liveRunForTicket(ctx, updatedTicket) : undefined;
  if (boundRun) await notifySupervisorOfMockupChange(ctx, boundRun, updatedTicket);

  return JSON.stringify({
    ticketId: updatedTicket.id,
    ticketKey: updatedTicket.ticketKey,
    file: mockupFile,
    status: updatedTicket.mockup?.status,
    message: `Linked '${mockupFile}' to ${updatedTicket.ticketKey}. Tell the human it is ready to preview in the MOCKUP column.`,
  });
}

// Stores the human's Studio notes first so they survive even when no Product Agent session can receive them right now.
export async function sendMockupFeedback(
  ctx: PipelineContext,
  params: {
    repoPath: string;
    ticketIdOrKey: string;
    feedback?: string;
    elementComments?: readonly MockupElementCommentInput[];
    openProductAgent: (ticket: BoardTicket) => Promise<string>;
  },
): Promise<{ ticket: BoardTicket; productAgentId: string }> {
  const updatedTicket = ctx.store.board.recordMockupFeedback(params);
  const mockupState = updatedTicket.mockup;
  const feedbackPrompt = [
    `## Góp ý mockup — \`${updatedTicket.ticketKey}\` (\`${mockupState?.file ?? ""}\`)`,
    mockupState?.feedback ?? "",
    formatMockupElementCommentsMarkdown(mockupState?.elementComments ?? []),
    `Hãy sửa file này theo mọi góp ý trên rồi gọi \`slp_board_set_mockup({ ticketId: "${updatedTicket.ticketKey}", file: "${mockupState?.file ?? ""}", summary: "..." })\`.`,
  ].filter(Boolean).join("\n\n");

  const productAgentId =
    await promptProductAgentForTicket(ctx, updatedTicket.id, feedbackPrompt)
    ?? await params.openProductAgent(updatedTicket);
  return { ticket: updatedTicket, productAgentId };
}

// Approval pins the current commit; commits stay the human's or agent's explicit action, so uncommitted work is refused, not committed here.
export async function approveBoardMockup(
  ctx: PipelineContext,
  params: { repoPath: string; ticketIdOrKey: string },
): Promise<BoardTicket> {
  const existingTicket = ctx.store.board.requireTicket(params.ticketIdOrKey, params.repoPath);
  if (!existingTicket.mockup) {
    throw new ToolError(`Ticket '${existingTicket.ticketKey}' has no mockup to approve yet.`);
  }
  const approvedCommit = await resolveApprovedMockupCommit(params.repoPath, existingTicket.mockup.file);
  const approvedTicket = ctx.store.board.approveMockup({ ...params, approvedCommit });

  const boundRun = liveRunForTicket(ctx, approvedTicket);
  if (boundRun) await notifySupervisorOfMockupChange(ctx, boundRun, approvedTicket);
  // Writing the Spec is the next step, and the session that built the mockup knows why each decision was made.
  await promptProductAgentForTicket(
    ctx,
    approvedTicket.id,
    `Mockup \`${approvedTicket.mockup?.file ?? ""}\` đã được chốt tại commit \`${approvedCommit}\`. Hãy soạn Spec mỏng và lưu bằng \`slp_board_save_spec({ ticketId: "${approvedTicket.ticketKey}", spec: "...", summary: "..." })\`.`,
  );
  return approvedTicket;
}
