// Assembles the pipeline: builds the context and registers what each human gate resumes.
// Kept apart from the step modules so they never import each other in a cycle.
import type { GateKind } from "../../shared/state";
import type { ForkRegistry } from "../fork/session-forker";
import type { AgentGateway } from "../runtime/agent-gateway";
import { Mailbox } from "../runtime/mailbox";
import type { PaseoHolder } from "../runtime/paseo-holder";
import type { RunStore } from "../store/run-store";
import type { PipelineContext } from "./context";
import { resumeTask } from "./task-pause";
import { unlockImplementation } from "./task-handshake";
import { notifyMasterLeadReady, startDocumentation, startVerification } from "./task-execution";

export interface PipelineDependencies {
  store: RunStore;
  gateway: AgentGateway;
  forks: ForkRegistry;
  holder: PaseoHolder;
}

export function createPipeline(dependencies: PipelineDependencies): PipelineContext {
  // Diagnostic failures must not undo a successful pipeline transition.
  const logEvent: PipelineContext["logEvent"] = (runId, entry) => {
    if (!dependencies.store.find(runId)) return;
    try {
      dependencies.store.appendLog({ ...entry, runId });
    } catch (logError) {
      console.error("[slp] SQLite audit append failed", logError);
    }
  };
  // Mail and tool traffic share one ordered SQLite audit trail.
  const mailbox = new Mailbox(dependencies.store, dependencies.gateway, (runId, mailEntry) =>
    logEvent(runId, mailEntry),
  );
  const pipelineContext: PipelineContext = { ...dependencies, mailbox, logEvent, continuations: {} };

  const requireTaskId = (taskId: string | null): string => {
    if (!taskId) throw new Error("This gate belongs to a task");
    return taskId;
  };
  // Typed as a complete Record so a new GateKind cannot be added without deciding what approving it resumes.
  const continuations: Record<GateKind, (runId: string, taskId: string | null) => Promise<void>> = {
    after_handshake: async (runId, taskId) => unlockImplementation(pipelineContext, runId, requireTaskId(taskId)),
    after_implementation: (runId, taskId) => startVerification(pipelineContext, runId, requireTaskId(taskId)),
    after_verification: (runId, taskId) => startDocumentation(pipelineContext, runId, requireTaskId(taskId)),
    before_merge: async (runId, taskId) => notifyMasterLeadReady(pipelineContext, runId, requireTaskId(taskId)),
    // approving a tripped breaker resumes the task with a fresh budget and no extra guidance
    circuit_breaker: async (runId, taskId) => resumeTask(pipelineContext, runId, requireTaskId(taskId), null),
    // final_approval is consumed by approveMain in run-lifecycle, so there is nothing left to resume here.
    final_approval: async () => undefined,
  };
  // Assigned after construction because the continuations close over the context itself.
  pipelineContext.continuations = continuations;
  return pipelineContext;
}
