// Tells a ticket's Supervisor when a Spec or mockup changes from outside its Run, so the owning Lead never builds a stale contract.
import type { BoardTicket } from "../../shared/board";
import type { Run } from "../../shared/state";
import type { PipelineContext } from "./context";

// Only a live Supervisor can act on a notice; finished or aborted work has nobody left to tell.
export function liveRunForTicket(ctx: PipelineContext, ticket: BoardTicket): Run | undefined {
  const boundRun = ticket.activeRunId ? ctx.store.find(ticket.activeRunId) : undefined;
  if (!boundRun || boundRun.status === "aborted" || !boundRun.supervisorAgentId) return undefined;
  return boundRun.agents[boundRun.supervisorAgentId]?.archivedAt ? undefined : boundRun;
}

// Flushes at once when the Supervisor is idle so the human sees instant responsiveness; the sweeper retries anything left queued.
async function flushRunMailbox(ctx: PipelineContext, runId: string): Promise<void> {
  if (!ctx.holder.isReady()) return;
  await ctx.gateway
    .liveStatuses(runId)
    .then((liveStatuses) => ctx.mailbox.flush(runId, liveStatuses))
    .catch(() => undefined);
}

function requiredSpecAction(ticket: BoardTicket): string {
  return ticket.leadAgentId
    ? `2. Notify the assigned Lead (\`${ticket.leadAgentId}\`) via \`slp_board_notify_lead({ ticketId: "${ticket.ticketKey}", message: "..." })\` so the Lead pauses its stage peers (\`slp_pause_peers\`), updates the Brief (\`slp_board_update_brief\`) and resumes them (\`slp_resume_peers\`).`
    : "2. If this feature is ready to run, delegate it with `slp_delegate` or inform the human in Vietnamese.";
}

export async function notifySupervisorOfSpecChange(
  ctx: PipelineContext,
  activeRun: Run,
  ticket: BoardTicket,
  changedBy: "human" | "product-agent",
): Promise<void> {
  const latestSpecRevision = ticket.specRevisions.at(-1);
  const supervisorNotice = [
    `## Spec Updated on Kanban Board — Ticket \`${ticket.ticketKey}\` (${ticket.title})`,
    `- **Updated By**: ${changedBy}`,
    `- **New Spec Revision**: \`v${ticket.currentSpecRev}\``,
    `- **Summary**: ${latestSpecRevision?.summary ?? "Spec edited on the Kanban board"}`,
    latestSpecRevision?.diff
      ? `### Spec Diff\n\`\`\`diff\n${latestSpecRevision.diff}\n\`\`\``
      : `### Updated Spec\n${latestSpecRevision?.content ?? ""}`,
    [
      "### Required Supervisor Action",
      `1. Inspect the updated Spec and diff on ticket \`${ticket.ticketKey}\` using \`slp_board_get_ticket({ ticketId: "${ticket.ticketKey}" })\`.`,
      requiredSpecAction(ticket),
    ].join("\n"),
  ].join("\n\n");

  ctx.store.mutate(activeRun.id, (mutableRun) => {
    mutableRun.productSpec = latestSpecRevision?.content ?? mutableRun.productSpec;
  });
  ctx.mailbox.enqueue(activeRun.id, activeRun.supervisorAgentId, supervisorNotice, {
    taskId: ticket.activePipelineId,
    awaitTool: null,
    from: changedBy,
    supersedeKey: `spec-edit:${ticket.id}`,
    summary: `Spec v${ticket.currentSpecRev} updated on ${ticket.ticketKey} by ${changedBy}`,
  });
  await flushRunMailbox(ctx, activeRun.id);
}

export async function notifySupervisorOfMockupChange(
  ctx: PipelineContext,
  activeRun: Run,
  ticket: BoardTicket,
): Promise<void> {
  const mockupState = ticket.mockup;
  if (!mockupState) return;
  const isApproved = mockupState.status === "approved";
  const supervisorNotice = [
    `## Mockup ${isApproved ? "Re-approved" : "Reopened"} — Ticket \`${ticket.ticketKey}\` (${ticket.title})`,
    `- **File**: \`${mockupState.file}\`${mockupState.approvedCommit ? ` at commit \`${mockupState.approvedCommit}\`` : ""}`,
    mockupState.summary ? `- **Summary**: ${mockupState.summary}` : "",
    ticket.leadAgentId
      ? `### Required Supervisor Action\nTell the assigned Lead (\`${ticket.leadAgentId}\`) with \`slp_board_notify_lead({ ticketId: "${ticket.ticketKey}", message: "..." })\` so it can ${isApproved ? "align the Brief with the approved mockup" : "pause work that depends on this mockup"}.`
      : "",
  ].filter(Boolean).join("\n\n");

  ctx.mailbox.enqueue(activeRun.id, activeRun.supervisorAgentId, supervisorNotice, {
    taskId: ticket.activePipelineId,
    awaitTool: null,
    from: "product-agent",
    supersedeKey: `mockup-change:${ticket.id}`,
    summary: `Mockup ${mockupState.status} on ${ticket.ticketKey}`,
  });
  await flushRunMailbox(ctx, activeRun.id);
}
