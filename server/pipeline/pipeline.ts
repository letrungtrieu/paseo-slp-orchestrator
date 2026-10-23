// Assemble the shared runtime context. Dynamic stage progression lives in stage-engine and
// stage-control; this module only owns durable logging and ordered mailbox delivery.
import type { SlpSettings } from "../../shared/settings";
import type { ForkRegistry } from "../fork/session-forker";
import type { AgentGateway } from "../runtime/agent-gateway";
import { Mailbox } from "../runtime/mailbox";
import type { PaseoHolder } from "../runtime/paseo-holder";
import type { RunStore } from "../store/run-store";
import type { PipelineContext } from "./context";
import { DEFAULT_QUESTION_TIMING, WaitRegistry, type QuestionTiming } from "./peer-messaging/wait-registry";

export interface PipelineDependencies {
  store: RunStore;
  gateway: AgentGateway;
  forks: ForkRegistry;
  holder: PaseoHolder;
  stateDirectory?: string;
  getSettings?: () => SlpSettings | Promise<SlpSettings>;
  // Tests shorten the wait window and lifetime; production uses the defaults.
  questionTiming?: Partial<QuestionTiming>;
}


export function createPipeline(dependencies: PipelineDependencies): PipelineContext {
  // Audit failures must not undo a successful state transition, but missing runs are ignored
  // because shutdown can race a final lifecycle callback.
  const logEvent: PipelineContext["logEvent"] = (runId, entry) => {
    if (!dependencies.store.find(runId)) return;
    try {
      dependencies.store.appendLog({ ...entry, runId });
    } catch (logError) {
      console.error("[slp] SQLite audit append failed", logError);
    }
  };
  // Mail and tool traffic share one ordered SQLite audit trail and one delivery boundary.
  const mailbox = new Mailbox(dependencies.store, dependencies.gateway, (runId, mailEntry) =>
    logEvent(runId, mailEntry),
  );
  // The context exposes only live dependencies and durable services; stage control owns its state transitions.
  const { questionTiming: questionTimingOverrides, ...contextDependencies } = dependencies;
  return {
    ...contextDependencies,
    mailbox,
    logEvent,
    questionWaits: new WaitRegistry(),
    questionTiming: { ...DEFAULT_QUESTION_TIMING, ...questionTimingOverrides },
  };
}
