// Gives a ticket back when the Run that held it is over, so the feature can start a new Run.
import type { PipelineContext } from "./context";

// A Run that no longer exists, or was aborted, delivers nothing more; completed Runs keep their ticket as the delivery record.
function runHasEnded(ctx: PipelineContext, runId: string): boolean {
  const boundRun = ctx.store.find(runId);
  return !boundRun || boundRun.status === "aborted";
}

// Aborts release immediately; this also frees tickets of Runs aborted before releases existed, whenever the board is read.
export function releaseEndedRunTickets(ctx: PipelineContext, repoPath: string): void {
  const releasedRunIds = new Set<string>();
  for (const ticket of ctx.store.board.listByRepo(repoPath)) {
    if (!ticket.activeRunId || releasedRunIds.has(ticket.activeRunId)) continue;
    if (runHasEnded(ctx, ticket.activeRunId)) {
      ctx.store.board.releaseRun(ticket.activeRunId);
      releasedRunIds.add(ticket.activeRunId);
    }
  }
}
