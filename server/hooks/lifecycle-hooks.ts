// Lifecycle hooks (events are best effort, so nothing here is load bearing for correctness):
// capture the SDK handle, answer permissions quickly, and nudge agents that forgot their tool.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { NUDGE_LIMIT } from "../../shared/roles";
import type { AgentRecord, Run } from "../../shared/state";
import { ensureAntigravityMcpBridge } from "../bus/antigravity-mcp-bridge";
import { isMasterLeadObligationActive } from "../pipeline/agent-revival";
import type { PipelineContext } from "../pipeline/context";
import { handleAgentArchived } from "../pipeline/run-lifecycle";
import { pausePipelineForAgent } from "../pipeline/stage-context";
import { nudgeReminder } from "../prompts/messages";
import type { AgentLiveStatus } from "../runtime/agent-gateway";
import { defaultFeatureValuesForProvider } from "../runtime/agent-gateway-helpers";
import { handlePermissionRequest } from "./permission-handler";
import { stageMail } from "../pipeline/stage-mail";

// last time a turn started per agent; used to tell "the agent answered" from a stale turn end
const lastTurnStartedAt = new Map<string, string>();
// A missed event is recovered once per obligation; mailbox delivery changes awaitingSince and arms the next reminder.
const lastSweeperNudgeByAgent = new Map<string, string>();
const NUDGE_GRACE_PERIOD_MS = 10_000;
// A direct question must not leave its sender waiting forever when the recipient is idle or gone.
export const DIRECT_REPLY_TIMEOUT_MS = 120_000;

function agentOwnsCurrentStage(run: Run, agentRecord: AgentRecord): boolean {
  if (run.engineVersion !== "dynamic-stages-v1" || run.status !== "running"
    || !agentRecord.pipelineId || !agentRecord.stageId || agentRecord.archivedAt) return false;
  const pipeline = run.pipelines[agentRecord.pipelineId];
  if (!pipeline) return false;
  // The pipeline's Lead continues to own the pipeline while merging its branch via slp_finalize_pipeline.
  if (pipeline.status === "completed" && agentRecord.role === "master_lead") {
    return pipeline.leadAgentId === agentRecord.agentId || pipeline.stages.at(-1)?.forkedLeadAgentId === agentRecord.agentId;
  }
  const currentStage = pipeline.stages[pipeline.currentStageIndex];
  return Boolean(pipeline.status === "running"
    && currentStage?.id === agentRecord.stageId
    && currentStage.status === "running");
}

// Each Lead also owes workflow tools during planning, pause recovery, finalization and final reporting.
function agentOwnsMasterLeadObligation(run: Run, agentRecord: AgentRecord): boolean {
  return Boolean(
    run.engineVersion === "dynamic-stages-v1"
    && ["planning", "running"].includes(run.status)
    && !agentRecord.archivedAt
    && agentRecord.role === "master_lead"
    && isMasterLeadObligationActive(run, agentRecord.awaitingTool),
  );
}

// During final reporting, the Supervisor owes either slp_present_to_manager or slp_request_rework.
function agentOwnsSupervisorObligation(run: Run, agentRecord: AgentRecord): boolean {
  return Boolean(
    run.engineVersion === "dynamic-stages-v1"
    && run.status === "reporting"
    && !agentRecord.archivedAt
    && agentRecord.role === "supervisor"
    && agentRecord.agentId === run.supervisorAgentId
    && agentRecord.awaitingTool === "slp_present_to_manager",
  );
}

function stageObligationFor(run: Run, agentRecord: AgentRecord): string | null {
  if (agentRecord.deferredTool) return agentRecord.deferredTool;
  if (agentRecord.role === "peer") return "slp_stage_report";
  if (agentRecord.role === "master_lead" && agentOwnsCurrentStage(run, agentRecord)) {
    const pipeline = agentRecord.pipelineId ? run.pipelines[agentRecord.pipelineId] : undefined;
    return pipeline?.status === "completed" ? "slp_finalize_pipeline" : "slp_approve_stage";
  }
  return null;
}

function restoreExpiredDirectReply(ctx: PipelineContext, run: Run, agentId: string): boolean {
  const currentAgent = run.agents[agentId];
  const isWaitingLeadInPlanning =
    currentAgent?.role === "master_lead" &&
    run.status === "planning" &&
    Boolean(currentAgent.waitingForAgentId && currentAgent.awaitingSince);
  if (
    !currentAgent?.waitingForAgentId ||
    !currentAgent.awaitingSince ||
    (!agentOwnsCurrentStage(run, currentAgent) && !isWaitingLeadInPlanning)
  ) {
    return false;
  }
  const startedAtMs = Date.parse(currentAgent.awaitingSince);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < DIRECT_REPLY_TIMEOUT_MS) return false;
  const recipientAgentId = currentAgent.waitingForAgentId;
  let queued = false;
  let restoredTool: string | null = null;
  ctx.store.mutate(run.id, (mutableRun) => {
    const mutableAgent = mutableRun.agents[agentId];
    const mutableIsPlanningLead =
      mutableAgent?.role === "master_lead" &&
      mutableRun.status === "planning" &&
      Boolean(mutableAgent.waitingForAgentId && mutableAgent.awaitingSince);
    if (
      !mutableAgent?.waitingForAgentId ||
      !mutableAgent.awaitingSince ||
      (!agentOwnsCurrentStage(mutableRun, mutableAgent) && !mutableIsPlanningLead)
    ) {
      return;
    }
    const refreshedStartedAtMs = Date.parse(mutableAgent.awaitingSince);
    if (!Number.isFinite(refreshedStartedAtMs) || Date.now() - refreshedStartedAtMs < DIRECT_REPLY_TIMEOUT_MS) return;
    const owningPipeline = mutableAgent.pipelineId ? mutableRun.pipelines[mutableAgent.pipelineId] : undefined;
    const stageName = owningPipeline?.stages.find((candidate) => candidate.id === mutableAgent.stageId)?.name ?? (mutableIsPlanningLead ? "planning" : undefined);
    if (!stageName) return;
    restoredTool = stageObligationFor(mutableRun, mutableAgent) ?? (mutableIsPlanningLead ? "slp_define_pipeline" : null);
    if (!restoredTool) return;
    mutableAgent.waitingForAgentId = null;
    mutableAgent.deferredTool = null;
    mutableAgent.awaitingTool = null;
    mutableAgent.awaitingSince = null;
    mutableAgent.nudges = 0;
    mutableRun.mailbox.push(stageMail(agentId,
      `No reply was received from peer ${recipientAgentId} within ${DIRECT_REPLY_TIMEOUT_MS / 1000} seconds. Continue stage '${stageName}' and call ${restoredTool}; use slp_escalate if the missing response blocks the goal.`,
      restoredTool));
    queued = true;
  });
  if (queued) {
    ctx.logEvent(run.id, {
      taskId: null,
      from: "pipeline",
      to: agentId,
      kind: "stage.direct_reply_timeout",
      summary: `No reply from ${recipientAgentId}; restored ${restoredTool}`,
      outcome: "queued",
    });
  }
  return queued;
}

function nudgeIfToolMissing(
  ctx: PipelineContext,
  agentId: string,
  outcomeKind: string,
  recoveredFromPoll = false,
  liveStatusKind?: AgentLiveStatus["status"],
): boolean {
  // Unknown, archived and legacy task agents are ignored; dynamic stages, Master Lead and Supervisor own their obligations.
  const lookup = ctx.store.findAgent(agentId);
  if (!lookup || outcomeKind !== "completed") return false;
  const { run, agentRecord } = lookup;
  const ownsStageObligation = agentOwnsCurrentStage(run, agentRecord);
  const ownsMasterLeadObligation = agentOwnsMasterLeadObligation(run, agentRecord);
  const ownsSupervisorObligation = agentOwnsSupervisorObligation(run, agentRecord);
  if (!ownsStageObligation && !ownsMasterLeadObligation && !ownsSupervisorObligation) return false;
  // A queued assignment is still waiting for its first delivery; nudging the recipient now
  // would create an owed-tool clock before the model has seen the stage roster.
  if (run.mailbox.some((message) => message.toAgentId === agentId)) return false;
  const turnStartedAt = lastTurnStartedAt.get(agentId);
  const owesTool = agentRecord.awaitingTool && agentRecord.awaitingSince;
  const expectedStageTool = stageObligationFor(run, agentRecord);
  // A stale legacy obligation must never nudge a dynamic cohort for the wrong protocol step.
  if (expectedStageTool && agentRecord.awaitingTool !== expectedStageTool) return false;
  // slp_report is stamped inside slp_finalize_pipeline during an already-running Lead turn, so turn_ended must still nudge if omitted.
  const stampedWithinActiveTurn = ownsMasterLeadObligation && agentRecord.awaitingTool === "slp_report";
  // a turn that began before the request was sent is not the agent's reply to it
  if (
    !owesTool ||
    (!recoveredFromPoll && !turnStartedAt) ||
    (!recoveredFromPoll && !stampedWithinActiveTurn && turnStartedAt! < (agentRecord.awaitingSince ?? ""))
  ) {
    return false;
  }
  // After NUDGE_LIMIT reminders, a stage participant pauses for Lead review while a crashed or Master Lead session is retired for revival.
  if (agentRecord.nudges >= NUDGE_LIMIT) {
    const reason = `${agentRecord.projectRole ?? agentRecord.role} did not call ${agentRecord.awaitingTool}`;
    ctx.logEvent(run.id, { taskId: null, from: agentId, to: "pipeline", kind: "nudge.exhausted", summary: reason, outcome: "error" });
    const shouldRespawnBrokenSession = ownsMasterLeadObligation || (!ownsSupervisorObligation && liveStatusKind === "error");
    if (ownsStageObligation && !shouldRespawnBrokenSession) {
      // The helper routes the pause to the owning Master Lead and records the durable pipeline state.
      pausePipelineForAgent(ctx, agentId, reason);
    }
    ctx.store.mutate(run.id, (mutableRun) => {
      const mutableRecord = mutableRun.agents[agentId];
      if (mutableRecord) {
        if (shouldRespawnBrokenSession) {
          mutableRecord.archivedAt ??= new Date().toISOString();
        } else {
          mutableRecord.awaitingTool = null;
          mutableRecord.awaitingSince = null;
        }
      }
    });
    return true;
  }
  const owedTool = agentRecord.awaitingTool as string;
  ctx.store.mutate(run.id, (mutableRun) => {
    const mutableRecord = mutableRun.agents[agentId];
    if (mutableRecord) mutableRecord.nudges += 1;
  });
  // The reminder goes through the mailbox like any other mail, so it is only delivered once the agent is idle again.
  if (agentRecord.awaitingSince) lastSweeperNudgeByAgent.set(agentId, agentRecord.awaitingSince);
  ctx.mailbox.enqueue(run.id, agentId, nudgeReminder(owedTool), {
    taskId: null,
    awaitTool: owedTool,
    isReminder: true,
    from: "pipeline",
    summary: `nudge: ${owedTool}`,
  });
  return true;
}

export function sweepStageNudges(ctx: PipelineContext, runId: string, liveStatuses: Map<string, AgentLiveStatus>): void {
  const run = ctx.store.require(runId);
  // The directory poll is the recovery path for a dropped turn-ended event or a turn that crashed into 'error' state.
  for (const [agentId, liveStatus] of liveStatuses) {
    if (liveStatus.archived || (liveStatus.status !== "idle" && liveStatus.status !== "closed" && liveStatus.status !== "error")) continue;
    const lookup = ctx.store.findAgent(agentId);
    if (!lookup || lookup.run.id !== runId) continue;
    const ownsStageObligation = agentOwnsCurrentStage(run, lookup.agentRecord);
    const ownsMasterLeadObligation = agentOwnsMasterLeadObligation(run, lookup.agentRecord);
    const ownsSupervisorObligation = agentOwnsSupervisorObligation(run, lookup.agentRecord);
    if (lookup.agentRecord.waitingForAgentId && lookup.agentRecord.awaitingSince) {
      // A direct reply timeout restores the deferred obligation instead of pausing the whole pipeline.
      if (restoreExpiredDirectReply(ctx, run, agentId)) continue;
    }
    if (!ownsStageObligation && !ownsMasterLeadObligation && !ownsSupervisorObligation) continue;
    if (!lookup.agentRecord.awaitingTool || !lookup.agentRecord.awaitingSince) continue;
    // Initial/rework mail must be delivered before the sweeper starts counting a reply timeout.
    if (run.mailbox.some((message) => message.toAgentId === agentId)) continue;
    const obligationStartedAt = lookup.agentRecord.awaitingSince;
    // The SDK can report idle after accepting a prompt but before its turn-start event arrives;
    // leave a short recovery window so that transient startup latency is not treated as silence.
    const obligationAgeMs = Date.now() - Date.parse(obligationStartedAt);
    if (Number.isFinite(obligationAgeMs) && obligationAgeMs < NUDGE_GRACE_PERIOD_MS) continue;
    if (lastSweeperNudgeByAgent.get(agentId) === obligationStartedAt) continue;
    if (nudgeIfToolMissing(ctx, agentId, "completed", true, liveStatus.status)) {
      lastSweeperNudgeByAgent.set(agentId, obligationStartedAt);
      const updatedRecord = ctx.store.require(runId).agents[agentId];
      if (updatedRecord?.archivedAt) {
        liveStatuses.set(agentId, { ...liveStatus, archived: true });
      }
    }
  }
}

export function registerLifecycleHooks(server: PluginServerContext, ctx: PipelineContext): () => void {
  const removers = [
    server.on("agent.turn_started", (event, hookContext) => {
      // Every hook captures the SDK handle: it is only handed to hooks and RPC handlers, never to the plugin entry.
      ctx.holder.capture(hookContext.paseo);
      lastTurnStartedAt.set(event.agent.id, new Date().toISOString());
    }),
    server.on("agent.turn_ended", (event, hookContext) => {
      ctx.holder.capture(hookContext.paseo);
      nudgeIfToolMissing(ctx, event.agent.id, event.outcome.kind);
    }),
    // Answered inside the event for low latency; the sweeper repeats this for events that were never delivered.
    server.on("agent.permission_requested", async (event, hookContext) => {
      ctx.holder.capture(hookContext.paseo);
      await handlePermissionRequest(ctx, event.agent.id, event.request, event.agent.provider);
    }),
    // Archiving any parent agent (Supervisor, Master Lead or Forked Lead) recursively archives its child sessions.
    server.on("agent.archived", async (event, hookContext) => {
      ctx.holder.capture(hookContext.paseo);
      const lookup = ctx.store.findAgent(event.agent.id);
      if (!lookup) return;
      await handleAgentArchived(ctx, lookup.run.id, event.agent.id, event.archivedAt);
    }),
  ];
  if (typeof server.before === "function") {
    // Always enable Paseo's ACP `auto_accept` feature toggle ("Auto accept permission prompts") when creating kiro-cli or ACP agents.
    removers.push(
      server.before("agent.create", async ({ request: agentCreateRequest }, hookContext) => {
        ctx.holder.capture(hookContext.paseo);
        const nextFeatureValues = defaultFeatureValuesForProvider(
          agentCreateRequest.config.provider,
          agentCreateRequest.config.featureValues,
        );
        if (nextFeatureValues === agentCreateRequest.config.featureValues) {
          return undefined;
        }
        return {
          ...agentCreateRequest,
          config: {
            ...agentCreateRequest.config,
            featureValues: nextFeatureValues,
          },
        };
      }),
    );
    // Plugin/CLI providers such as Antigravity ignore per-session HTTP mcpServers and spawn a stdio bridge
    // from ~/.gemini/config/mcp_config.json instead; inject the agent's private bus token into its process env.
    removers.push(
      server.before("agent.session_open", async ({ request: sessionOpenRequest }, hookContext) => {
        ctx.holder.capture(hookContext.paseo);
        const callerLookup = ctx.store.findAgent(sessionOpenRequest.agentId);
        if (!callerLookup) return undefined;
        if (ctx.stateDirectory && sessionOpenRequest.provider.startsWith("antigravity")) {
          try {
            ensureAntigravityMcpBridge(ctx.stateDirectory);
          } catch (bridgeSetupError) {
            console.error("[slp] failed to sync Antigravity MCP bridge", bridgeSetupError);
          }
        }
        const agentBusUrl = typeof ctx.gateway.busEndpointForToken === "function"
          ? await ctx.gateway.busEndpointForToken(callerLookup.agentRecord.token)
          : null;
        return {
          ...sessionOpenRequest,
          env: {
            ...sessionOpenRequest.env,
            // Ensure Antigravity child MCP processes inherit ELECTRON_RUN_AS_NODE=1 when invoking Paseo.bin.
            ELECTRON_RUN_AS_NODE: "1",
            SLP_AGENT_ID: sessionOpenRequest.agentId,
            SLP_AGENT_TOKEN: callerLookup.agentRecord.token,
            ...(agentBusUrl ? { SLP_BUS_URL: agentBusUrl } : {}),
            ...(ctx.stateDirectory ? { SLP_HOME: ctx.stateDirectory } : {}),
          },
        };
      }),
    );
  }
  return () => removers.forEach((remove) => remove());
}
