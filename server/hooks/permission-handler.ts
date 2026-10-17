// Answers permission prompts of SLP agents so no human has to (single point of contact).
// Called both from the lifecycle event (low latency) and from the sweeper (catches missed events).
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { AgentRecord, Run } from "../../shared/state";
import { decidePermission, type PermissionDecision } from "./permissions";
import type { PipelineContext } from "../pipeline/context";

// requestIds already answered; a second answer to a resolved request would fail in the SDK
const answeredRequestIds = new Set<string>();

function stageIsCurrent(run: Run, agentRecord: AgentRecord): boolean {
  // Archived agents and legacy or finished runs must never receive new write or shell permissions.
  if (agentRecord.archivedAt || run.engineVersion !== "dynamic-stages-v1") return false;
  if (run.status === "completed" || run.status === "aborted") return false;
  if (agentRecord.role === "peer" || agentRecord.role === "forked_lead") {
    if (!agentRecord.pipelineId || !agentRecord.stageId) return false;
    const pipeline = run.pipelines[agentRecord.pipelineId];
    const stage = pipeline?.stages[pipeline.currentStageIndex];
    // Only the running stage may receive write permissions; completed prior-stage peers become read-only.
    return Boolean(run.status === "running"
      && pipeline?.status === "running"
      && stage?.id === agentRecord.stageId
      && stage.status === "running");
  }
  return true;
}

// Completed-stage peers remain alive until their pipeline finishes so they can answer cross-stage questions read-only.
function pipelineIsRunningForAgent(run: Run, agentRecord: AgentRecord): boolean {
  if (agentRecord.archivedAt || run.engineVersion !== "dynamic-stages-v1") return false;
  if (run.status === "completed" || run.status === "aborted") return false;
  if (agentRecord.role === "peer" || agentRecord.role === "forked_lead") {
    if (!agentRecord.pipelineId || !agentRecord.stageId) return false;
    const pipeline = run.pipelines[agentRecord.pipelineId];
    return Boolean(run.status === "running" && pipeline?.status === "running");
  }
  return true;
}

function workingDirectoryOf(run: Run, agentRecord: AgentRecord): string {
  // Forked Leads stay in the integration checkout so native session forks resolve correctly.
  if (agentRecord.role === "master_lead" || agentRecord.role === "forked_lead") return run.devCwd;
  if (agentRecord.role === "supervisor") return run.repoPath;
  // All peers in a stage share the exact worktree handed to the pipeline.
  return agentRecord.pipelineId ? run.pipelines[agentRecord.pipelineId]?.worktree ?? run.devCwd : run.devCwd;
}

function buildResponse(
  request: AgentPermissionRequest,
  decision: ReturnType<typeof decidePermission>,
): AgentPermissionResponse {
  if (decision.behavior === "deny") return { behavior: "deny", message: decision.message };
  // plan approvals carry an explicit "implement" action id on providers that offer one
  const implementAction = request.actions?.find((action) => action.intent === "implement");
  return implementAction ? { behavior: "allow", selectedActionId: implementAction.id } : { behavior: "allow" };
}

export async function handlePermissionRequest(
  ctx: PipelineContext,
  agentId: string,
  request: AgentPermissionRequest,
): Promise<void> {
  const lookup = ctx.store.findAgent(agentId);
  // The event hook and the sweeper can race on one request; remembering the id makes the second caller a no-op.
  if (!lookup || answeredRequestIds.has(request.id)) return;
  const { run, agentRecord } = lookup;
  // An archived SDK session has no work left to authorize; leaving it unanswered avoids reviving it.
  if (agentRecord.archivedAt) return;
  try {
    // Directory state is advisory; a transient list failure must not prevent the pure policy from answering.
    const liveStatuses = await ctx.gateway.liveStatuses(run.id);
    if (liveStatuses.get(agentId)?.archived) return;
  } catch (statusError) {
    console.warn("[slp] live agent status unavailable while answering permission", statusError);
  }
  const stageActive = stageIsCurrent(run, agentRecord);
  const pipelineRunning = pipelineIsRunningForAgent(run, agentRecord);
  answeredRequestIds.add(request.id);
  const decision: PermissionDecision = pipelineRunning
    ? decidePermission(request, {
      role: agentRecord.role,
      agentCwd: workingDirectoryOf(run, agentRecord),
      // Only a peer in the currently active stage receives writable scope; prior-stage peers are read-only.
      writableScope: agentRecord.role === "peer" && stageActive ? agentRecord.writeScope : [],
      pipelineId: agentRecord.pipelineId,
      stageId: agentRecord.stageId,
      stageActive,
      archived: false,
    })
    : { behavior: "deny", message: "This agent belongs to an archived or inactive pipeline stage." };
  try {
    await ctx.gateway.respondToPermission(agentId, request.id, buildResponse(request, decision));
  } catch (respondError) {
    // let the sweeper retry: forget this id so a still-pending request is answered next pass
    answeredRequestIds.delete(request.id);
    console.error("[slp] permission response failed", respondError);
    return;
  }
  // Only denials are audited; allowed requests would flood the log with every read and bus call.
  if (decision.behavior === "deny") {
    ctx.logEvent(run.id, {
      taskId: agentRecord.taskId,
      from: `${agentRecord.role}:${agentId.slice(0, 8)}`,
      to: "permission-hook",
      kind: `permission.${request.name}`,
      summary: decision.message,
      outcome: "blocked",
    });
  }
}
