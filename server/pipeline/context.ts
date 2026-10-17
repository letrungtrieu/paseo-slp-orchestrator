// Shared dependencies used by every pipeline module. Passing one context object keeps the
// dynamic stage engine testable with fakes and avoids hidden daemon singletons.
import type { ForkRegistry } from "../fork/session-forker";
import type { AgentGateway } from "../runtime/agent-gateway";
import type { Mailbox } from "../runtime/mailbox";
import type { PaseoHolder } from "../runtime/paseo-holder";
import type { CommLogInput } from "../store/comm-log";
import type { RunStore } from "../store/run-store";

export type PipelineLogEntry = Omit<CommLogInput, "runId">;

export interface PipelineContext {
  store: RunStore;
  gateway: AgentGateway;
  mailbox: Mailbox;
  forks: ForkRegistry;
  holder: PaseoHolder;
  logEvent(runId: string, entry: PipelineLogEntry): void;
}

// Retiring an agent must never stop the pipeline, but a silent failure leaves orphan agents
// running, so the failure is written to the audit log instead of being swallowed.
export async function archiveAgentLogged(
  ctx: PipelineContext,
  runId: string,
  taskId: string | null,
  agentId: string,
): Promise<boolean> {
  try {
    await ctx.gateway.archive(agentId);
    return true;
  } catch (archiveError) {
    ctx.logEvent(runId, {
      taskId,
      from: "pipeline",
      to: agentId,
      kind: "agent.archive_failed",
      summary: "could not archive agent",
      outcome: "error",
      reason: archiveError instanceof Error ? archiveError.message : String(archiveError),
    });
    return false;
  }
}
