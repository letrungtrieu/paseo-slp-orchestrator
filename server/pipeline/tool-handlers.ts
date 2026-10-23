// The bus authenticates runtime identity and delegates Lead-authored pipeline operations to focused modules.
import type { z } from "zod";
import type { BusCaller, BusToolOutcome, BusTransportDeps } from "../bus/http-mcp";
import { BUS_TOOL_DEFINITIONS, isBusToolName, type BusToolName } from "../bus/tool-schemas";
import { SLP_ROLES, type SlpRole } from "../../shared/roles";
import type { PipelineContext } from "./context";
import { reviveAgentsOnDemand } from "./agent-revival";
import { definePipeline } from "./define-pipeline";
import { finalizePipeline } from "./finalize-pipeline";
import { createPipelineWorktree } from "./pipeline-workspaces";
import { delegate, presentToManager, report, requestRework } from "./run-lifecycle";
import { listPipelines, readPipeline, readRun } from "./read-tools";
import { approveStage, resumePipeline } from "./stage-control";
import { answerQuestion } from "./peer-messaging/answer-question";
import { askQuestion } from "./peer-messaging/ask-question";
import { awaitAnswer } from "./peer-messaging/await-answer";
import { notifyAgent } from "./peer-messaging/notify";
import { escalateStage, requestStageRework, submitStageReport } from "./stage-messages";
import { handlePeerShell } from "./shell-watchdog";
import { ToolError } from "./tool-error";

type ToolInput<Name extends BusToolName> = z.output<(typeof BUS_TOOL_DEFINITIONS)[Name]["input"]>;
// The abort signal fires when the agent's HTTP connection closes, which only matters to handlers that block (slp_ask).
type ToolHandler<Name extends BusToolName> = (
  ctx: PipelineContext,
  caller: BusCaller,
  input: ToolInput<Name>,
  abortSignal?: AbortSignal,
) => string | Promise<string>;

// A complete mapped type makes every exposed tool require an implementation at compile time.
const TOOL_HANDLERS: { [Name in BusToolName]: ToolHandler<Name> } = {
  slp_define_pipeline: (ctx, caller, input) => definePipeline(ctx, caller.runId, input, caller),
  slp_create_worktree: (ctx, caller, input) => createPipelineWorktree(ctx, caller.runId, input.name),
  slp_list_pipelines: (ctx, caller) => listPipelines(ctx, caller),
  slp_get_pipeline: (ctx, caller, input) => readPipeline(ctx, caller, input.pipelineId),
  slp_finalize_pipeline: (ctx, caller, input) => finalizePipeline(ctx, caller, input.pipelineId, input.summary),
  slp_resume_pipeline: (ctx, caller, input) => resumePipeline(ctx, caller.runId, input.pipelineId, input.feedback),
  slp_notify: (ctx, caller, input) => notifyAgent(ctx, caller, input),
  slp_ask: (ctx, caller, input, abortSignal) => askQuestion(ctx, caller, input, abortSignal),
  slp_await_answer: (ctx, caller, input, abortSignal) => awaitAnswer(ctx, caller, input, abortSignal),
  slp_answer: (ctx, caller, input) => answerQuestion(ctx, caller, input),
  slp_stage_report: (ctx, caller, input) => submitStageReport(ctx, caller, input),
  slp_approve_stage: (ctx, caller, input) => approveStage(ctx, caller, input.summary),
  slp_stage_rework: (ctx, caller, input) => requestStageRework(ctx, caller, input),
  slp_escalate: (ctx, caller, input) => escalateStage(ctx, caller, input.reason),
  slp_delegate: (ctx, caller, input) => delegate(ctx, caller.runId, input),
  slp_request_rework: (ctx, caller, input) => requestRework(ctx, caller.runId, input.feedback),
  slp_present_to_manager: (ctx, caller, input) => presentToManager(ctx, caller.runId, input.report),
  slp_report: (ctx, caller, input) => report(ctx, caller.runId, input.summary, caller.agentId),
  slp_revive_agent: (ctx, caller, input) => reviveAgentsOnDemand(ctx, caller, input),
  slp_handle_peer_shell: (ctx, caller, input) => handlePeerShell(ctx, caller, input),
  slp_get_run: (ctx, caller) => readRun(ctx, caller),
};

export function createBusDispatcher(ctx: PipelineContext): BusTransportDeps {
  return {
    resolveCaller(token: string): BusCaller | null {
      const lookup = ctx.store.findCallerByToken(token);
      if (!lookup || lookup.agentRecord.archivedAt) return null;
      const { agentRecord, run } = lookup;
      // Old persisted capability names never become authority in the new orchestration bus.
      if (!(SLP_ROLES as readonly string[]).includes(agentRecord.role)) return null;
      if (run.engineVersion !== "dynamic-stages-v1") return null;
      return { runId: run.id, agentId: agentRecord.agentId, role: agentRecord.role,
        projectRole: agentRecord.projectRole, taskId: null };
    },
    async dispatch(caller: BusCaller, toolName: string, rawArguments: unknown, abortSignal?: AbortSignal): Promise<BusToolOutcome> {
      const logCall = (outcome: "delivered" | "blocked" | "error", reason?: string) => {
        const argumentsText = JSON.stringify(rawArguments ?? {});
        ctx.logEvent(caller.runId, { taskId: null, from: `${caller.role}:${caller.agentId.slice(0, 8)}`,
          to: "pipeline", kind: toolName, summary: `${toolName} ${argumentsText.slice(0, 240)}`, outcome, reason: reason ?? null });
      };
      try {
        const lookup = ctx.store.findAgent(caller.agentId);
        // Recheck identity at dispatch too: a stale in-flight request may outlive token resolution and stage closure.
        if (!lookup || lookup.run.id !== caller.runId || lookup.agentRecord.archivedAt || lookup.agentRecord.role !== caller.role) {
          throw new ToolError("Agent is no longer authorized for this run.");
        }
        if (lookup.run.engineVersion !== "dynamic-stages-v1") throw new ToolError("This historical run uses a retired engine. Start a new run.");
        // Only aborted runs are permanently closed; completed runs keep Supervisor and Master Lead alive for follow-up pipelines.
        if (lookup.run.status === "aborted") throw new ToolError("This run has finished.");
        if (!isBusToolName(toolName)) throw new ToolError(`Unknown tool '${toolName}'.`);
        const definition = BUS_TOOL_DEFINITIONS[toolName];
        if (!(definition.roles as readonly SlpRole[]).includes(caller.role)) throw new ToolError(`Tool '${toolName}' is not available to ${caller.role}.`);
        const parsedInput = definition.input.safeParse(rawArguments ?? {});
        if (!parsedInput.success) throw new ToolError(parsedInput.error.message);
        // The same catalogue selects the schema and handler; the cast only bridges their mapped-type correlation.
        const invoke = TOOL_HANDLERS[toolName] as ToolHandler<typeof toolName>;
        const text = await invoke(ctx, caller, parsedInput.data, abortSignal);
        const refreshedRun = ctx.store.require(caller.runId);
        const callerRecord = refreshedRun.agents[caller.agentId];
        const hasSatisfiedMail = refreshedRun.mailbox.some(
          (queuedMessage) => queuedMessage.toAgentId === caller.agentId && queuedMessage.awaitTool === toolName,
        );
        if (callerRecord?.awaitingTool === toolName || hasSatisfiedMail) {
          ctx.store.mutate(caller.runId, (mutableRun) => {
            const mutableCaller = mutableRun.agents[caller.agentId];
            if (mutableCaller?.awaitingTool === toolName) {
              mutableCaller.awaitingTool = null;
              mutableCaller.awaitingSince = null;
              mutableCaller.nudges = 0;
            }
            // Purge retry or reminder mail for the obligation that this tool execution just satisfied.
            mutableRun.mailbox = mutableRun.mailbox.filter(
              (queuedMessage) => !(queuedMessage.toAgentId === caller.agentId && queuedMessage.awaitTool === toolName),
            );
          });
        }
        logCall("delivered");
        return { text, isError: false };
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        logCall(failure instanceof ToolError ? "blocked" : "error", reason);
        return { text: reason, isError: true };
      }
    },
  };
}
