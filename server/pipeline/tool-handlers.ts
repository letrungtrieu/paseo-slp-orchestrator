// Binds each bus tool to the pipeline step that implements it and enforces the cross-cutting
// rules: role check, schema check, audit log and clearing the "owed tool" bookkeeping.
import type { SlpRole } from "../../shared/roles";
import type { Run } from "../../shared/state";
import type { z } from "zod";
import type { BusCaller, BusToolOutcome, BusTransportDeps } from "../bus/http-mcp";
import { BUS_TOOL_DEFINITIONS, isBusToolName, type BusToolName } from "../bus/tool-schemas";
import { type PipelineContext } from "./context";
import {
  defineTasks,
  delegate,
  presentToManager,
  report,
  requestRework,
} from "./run-lifecycle";
import { onPlanSubmitted } from "./task-handshake";
import {
  answerQuestion,
  archiveTask,
  askSibling,
  consultPeer,
  escalate,
  specDecision,
} from "./task-collaboration";
import { onDocDone, onStageDone, onVerdict } from "./task-execution";
import { ToolError } from "./tool-error";
import { listPeerRoles, listTasks, readReport, readRun, readTask } from "./read-tools";
import { promptProjectPeer, reportProjectPeer, spawnProjectPeer } from "./project-peers";

type ToolInput<Name extends BusToolName> = z.output<(typeof BUS_TOOL_DEFINITIONS)[Name]["input"]>;
type ToolHandler<Name extends BusToolName> = (ctx: PipelineContext, caller: BusCaller, input: ToolInput<Name>) => string | Promise<string>;

// Task-scoped tools need a task context; the Supervisor and Master Lead have none, so fail with a clear message instead of a null id.
function requireTaskId(caller: BusCaller): string {
  if (!caller.taskId) throw new ToolError("This tool is only available to task peers.");
  return caller.taskId;
}

// Mapped type: adding a tool to the catalogue without a handler becomes a compile error rather than a runtime 'unknown tool'.
const TOOL_HANDLERS: { [Name in BusToolName]: ToolHandler<Name> } = {
  slp_list_peer_roles: (ctx, caller) => listPeerRoles(ctx, caller),
  slp_spawn_peer: (ctx, caller, input) => spawnProjectPeer(ctx, caller.runId, input),
  slp_prompt_peer: (ctx, caller, input) => promptProjectPeer(ctx, caller.runId, input.agentId, input.brief),
  slp_peer_report: (ctx, caller, input) => reportProjectPeer(ctx, caller, input),
  // Reads return immediately and do not satisfy the caller's outstanding workflow obligation.
  slp_get_run: (ctx, caller) => readRun(ctx, caller),
  slp_list_tasks: (ctx, caller, input) => listTasks(ctx, caller, input),
  slp_get_task: (ctx, caller, input) => readTask(ctx, caller, input.taskId),
  slp_get_report: (ctx, caller, input) => readReport(ctx, caller, input.taskId),
  slp_delegate: (ctx, caller, input) => delegate(ctx, caller.runId, input.acceptanceCriteria),
  slp_request_rework: (ctx, caller, input) => requestRework(ctx, caller.runId, input.feedback),
  slp_present_to_manager: (ctx, caller, input) => presentToManager(ctx, caller.runId, input.report),
  slp_define_tasks: (ctx, caller, input) => defineTasks(ctx, caller.runId, input.masterSpec, input.tasks),
  slp_consult_peer: (ctx, caller, input) => consultPeer(ctx, caller.runId, caller.agentId, input.taskId, input.question),
  slp_spec_decision: (ctx, caller, input) => specDecision(ctx, caller.runId, input.taskId, input.decision),
  slp_archive_task: (ctx, caller, input) => archiveTask(ctx, caller.runId, input.taskId),
  slp_report: (ctx, caller, input) => report(ctx, caller.runId, input.summary),
  slp_submit_plan: (ctx, caller, input) => onPlanSubmitted(ctx, caller.runId, requireTaskId(caller), input),
  slp_stage_done: (ctx, caller, input) => onStageDone(ctx, caller.runId, requireTaskId(caller), input.summary),
  slp_doc_done: (ctx, caller, input) => onDocDone(ctx, caller.runId, requireTaskId(caller), input.report, caller.agentId),
  // The verdict role comes from the authenticated token, never from the arguments, so a reviewer cannot vote as another role.
  slp_verdict: (ctx, caller, input) =>
    onVerdict(ctx, caller.runId, requireTaskId(caller), caller.projectRole ?? caller.role, {
      verdict: input.verdict,
      issues: input.issues,
    }),
  slp_ask_sibling: (ctx, caller, input) => askSibling(ctx, caller.runId, caller.agentId, caller.taskId, input.taskId, input.question),
  slp_answer: (ctx, caller, input) => answerQuestion(ctx, caller.runId, caller.agentId, input.questionId, input.answer),
  slp_escalate: (ctx, caller, input) => escalate(ctx, caller.runId, caller.taskId, caller.role, input.reason),
};

function describeCall(toolName: string, rawArguments: unknown): string {
  // Audit summaries are bounded; complete specifications and reports have their own database records.
  const argumentsText = JSON.stringify(rawArguments ?? {});
  return `${toolName} ${argumentsText.length > 240 ? `${argumentsText.slice(0, 240)}…` : argumentsText}`;
}

// Cleared only after the handler succeeds: a rejected call leaves the debt in place so the sweeper still nudges the agent.
// A caller that invokes the tool it owes is no longer waiting to be nudged.
function clearOwedTool(ctx: PipelineContext, caller: BusCaller, toolName: string): void {
  // Read queries must not rewrite run timestamps or pay a workflow obligation they did not complete.
  if (ctx.store.require(caller.runId).agents[caller.agentId]?.awaitingTool !== toolName) return;
  ctx.store.mutate(caller.runId, (run: Run) => {
    const agentRecord = run.agents[caller.agentId];
    if (agentRecord && agentRecord.awaitingTool === toolName) agentRecord.awaitingTool = null;
  });
}

export function createBusDispatcher(ctx: PipelineContext): BusTransportDeps {
  return {
    // The token in the URL is the only credential; roles and ids are always derived from the store, not from the request.
    resolveCaller(token: string): BusCaller | null {
      const lookup = ctx.store.findCallerByToken(token);
      if (!lookup) return null;
      return {
        runId: lookup.run.id,
        agentId: lookup.agentRecord.agentId,
        role: lookup.agentRecord.role,
        ...(lookup.agentRecord.projectRole ? { projectRole: lookup.agentRecord.projectRole } : {}),
        taskId: lookup.agentRecord.taskId,
      };
    },

    async dispatch(caller: BusCaller, toolName: string, rawArguments: unknown): Promise<BusToolOutcome> {
      const startedAt = Date.now();
      // One helper so every exit path (blocked, error, delivered) writes the same audit shape and duration.
      const logCall = (outcome: "delivered" | "blocked" | "error", reason?: string) =>
        ctx.logEvent(caller.runId, {
          taskId: caller.taskId,
          from: `${caller.role}:${caller.agentId.slice(0, 8)}`,
          to: "pipeline",
          kind: toolName,
          summary: describeCall(toolName, rawArguments),
          outcome,
          reason: reason ?? null,
          durationMs: Date.now() - startedAt,
        });
      // Unknown names are reported as tool errors, not protocol errors, so the agent can read the message and recover.
      if (!isBusToolName(toolName)) {
        logCall("blocked", "unknown tool");
        return { isError: true, text: `Unknown tool '${toolName}'.` };
      }
      const toolDefinition = BUS_TOOL_DEFINITIONS[toolName];
      // role gate (spec rule: every agent only sees and may call its own tools)
      if (!(toolDefinition.roles as readonly SlpRole[]).includes(caller.role)) {
        logCall("blocked", `role ${caller.role} may not call ${toolName}`);
        return { isError: true, text: `Tool '${toolName}' is not available to your role.` };
      }
      // Defaults to {} because some models emit no arguments at all for parameterless tools.
      const parsedArguments = toolDefinition.input.safeParse(rawArguments ?? {});
      if (!parsedArguments.success) {
        logCall("blocked", "invalid arguments");
        return { isError: true, text: `Invalid arguments: ${parsedArguments.error.message}` };
      }
      // Handlers run to completion before the reply, but they only start follow-up work detached; that is why tool replies return immediately.
      try {
        const handler = TOOL_HANDLERS[toolName] as ToolHandler<BusToolName>;
        const handlerText = await handler(ctx, caller, parsedArguments.data as never);
        clearOwedTool(ctx, caller, toolName);
        logCall("delivered");
        return { isError: false, text: handlerText };
      } catch (handlerError) {
        const failureText = handlerError instanceof Error ? handlerError.message : String(handlerError);
        // ToolError is the agent's own mistake (blocked); anything else is a pipeline fault (error)
        logCall(handlerError instanceof ToolError ? "blocked" : "error", failureText);
        return { isError: true, text: failureText };
      }
    },
  };
}
