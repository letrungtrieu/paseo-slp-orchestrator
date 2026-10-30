// Answers permission prompts of SLP agents so no human has to (single point of contact).
// Called both from the lifecycle event (low latency) and from the sweeper (catches missed events).
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { AgentRecord, Run } from "../../shared/state";
import type { PeerKind } from "../../shared/project-prompts";
import { isPipelineLeadRole } from "../../shared/roles";
import { agentPeerKind } from "../pipeline/stage-shape";
import { findStandaloneSpecAgentById } from "../pipeline/spec-agent";
import { decidePermission, type PermissionDecision } from "./permissions";
import type { PipelineContext } from "../pipeline/context";
import { isKiroProvider } from "../runtime/agent-gateway-helpers";

// requestIds already answered; a second answer to a resolved request would fail in the SDK
const answeredRequestIds = new Set<string>();

function isFinalizingLead(run: Run, agentRecord: AgentRecord): boolean {
  if (!isPipelineLeadRole(agentRecord.role) || !agentRecord.pipelineId || agentRecord.archivedAt) return false;
  const pipeline = run.pipelines[agentRecord.pipelineId];
  return Boolean(
    run.status === "running"
    && pipeline?.status === "completed"
    && (pipeline.leadAgentId === agentRecord.agentId || pipeline.stages.at(-1)?.forkedLeadAgentId === agentRecord.agentId),
  );
}

function stageIsCurrent(run: Run, agentRecord: AgentRecord): boolean {
  // Archived or Lead-paused agents and legacy or aborted runs must never receive new write or shell permissions.
  if (agentRecord.archivedAt || agentRecord.pausedAt || run.engineVersion !== "dynamic-stages-v1" || run.status === "aborted") return false;
  if (run.status === "completed") return agentRecord.role === "supervisor" || isPipelineLeadRole(agentRecord.role);
  if (agentRecord.role === "peer") {
    if (!agentRecord.pipelineId || !agentRecord.stageId) return false;
    const pipeline = run.pipelines[agentRecord.pipelineId];
    const stage = pipeline?.stages[pipeline.currentStageIndex];
    // Only the running stage may receive peer write permissions; completed prior-stage peers become read-only.
    return Boolean(run.status === "running"
      && pipeline?.status === "running"
      && stage?.id === agentRecord.stageId
      && stage.status === "running");
  }
  return true;
}

// Completed-stage peers and sibling Leads remain alive until integration finishes so they can answer conflict questions read-only.
function pipelineIsRunningForAgent(run: Run, agentRecord: AgentRecord): boolean {
  if (agentRecord.archivedAt || run.engineVersion !== "dynamic-stages-v1" || run.status === "aborted") return false;
  // Supervisor and Lead stay alive after a cycle completes so the user can issue follow-up requests in the same session.
  if (run.status === "completed") return agentRecord.role === "supervisor" || isPipelineLeadRole(agentRecord.role);
  if (agentRecord.role === "peer") {
    if (!agentRecord.pipelineId || !agentRecord.stageId) return false;
    const pipeline = run.pipelines[agentRecord.pipelineId];
    return Boolean(
      run.status === "running"
      && (pipeline?.status === "running" || pipeline?.status === "completed"),
    );
  }
  return true;
}

function workingDirectoryOf(run: Run, agentRecord: AgentRecord): string {
  // Each Lead operates inside its dedicated feature worktree; the QA Lead inside the QA worktree.
  if (isPipelineLeadRole(agentRecord.role)) {
    return (
      agentRecord.worktreePath
      ?? (agentRecord.pipelineId ? run.pipelines[agentRecord.pipelineId]?.worktree : undefined)
      ?? run.devCwd
    );
  }
  if (agentRecord.role === "supervisor") return run.repoPath;
  // All peers in a stage share the exact worktree handed to the pipeline.
  return agentRecord.pipelineId ? run.pipelines[agentRecord.pipelineId]?.worktree ?? run.devCwd : run.devCwd;
}

function buildResponse(
  request: AgentPermissionRequest,
  decision: ReturnType<typeof decidePermission>,
): AgentPermissionResponse {
  if (decision.behavior === "deny") return { behavior: "deny", message: decision.message };
  // Plan approvals carry an explicit "implement" action id; ACP providers such as kiro-cli also require
  // selectedActionId when chooser options or non-standard allow option kinds are returned.
  const preferredAllowAction =
    request.actions?.find((action) => action.intent === "implement") ??
    request.actions?.find((action) => action.behavior === "allow");
  return preferredAllowAction
    ? { behavior: "allow", selectedActionId: preferredAllowAction.id }
    : { behavior: "allow" };
}

export async function handlePermissionRequest(
  ctx: PipelineContext,
  agentId: string,
  request: AgentPermissionRequest,
  agentProvider?: string,
): Promise<void> {
  if (answeredRequestIds.has(request.id)) return;
  const lookup = ctx.store.findAgent(agentId);
  if (!lookup) {
    const standaloneSpecSession = findStandaloneSpecAgentById(agentId);
    if (standaloneSpecSession) {
      // Standalone Spec Agents operate read-only in their repository and are allowed to call slp-bus board tools.
      answeredRequestIds.add(request.id);
      const standaloneDecision = decidePermission(request, {
        role: "supervisor",
        agentCwd: standaloneSpecSession.repoPath,
        writableScope: [],
        pipelineId: null,
        stageId: null,
        stageActive: false,
        archived: false,
      });
      try {
        await ctx.gateway.respondToPermission(agentId, request.id, buildResponse(request, standaloneDecision));
      } catch (respondError) {
        answeredRequestIds.delete(request.id);
        console.error("[slp] standalone Spec Agent permission response failed", respondError);
      }
      return;
    }
    // Standalone kiro-cli sessions outside an SLP run also auto-accept permission prompts when ACP chooser prompts fire.
    if (!isKiroProvider(agentProvider ?? request.provider)) return;
    answeredRequestIds.add(request.id);
    try {
      await ctx.gateway.respondToPermission(agentId, request.id, buildResponse(request, { behavior: "allow" }));
    } catch (respondError) {
      answeredRequestIds.delete(request.id);
      console.error("[slp] kiro-cli auto-accept permission response failed", respondError);
    }
    return;
  }
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
  const finalizingPipeline = isFinalizingLead(run, agentRecord);
  const pipelineWorktree = agentRecord.pipelineId ? run.pipelines[agentRecord.pipelineId]?.worktree : undefined;
  const activeStageKind = agentRecord.pipelineId
    ? run.pipelines[agentRecord.pipelineId]?.stages[run.pipelines[agentRecord.pipelineId].currentStageIndex]?.kind ?? null
    : null;
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
      // Advisors and QA graders never write production code; mockup stage peers may write under .slp/mockups/**.
      peerKind: agentRecord.role === "peer" ? safePeerKind(run, agentRecord.projectRole) : null,
      stageKind: activeStageKind,
      finalizingPipeline,
      additionalWritableRoots:
        agentRecord.role === "master_lead"
          ? [run.devCwd, ...(pipelineWorktree ? [pipelineWorktree] : [])]
          : [],
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

// A role missing from the snapshot (renamed between runs) falls back to read-only rather than throwing inside the hook.
function safePeerKind(run: Run, projectRole: string | null): PeerKind {
  try {
    return agentPeerKind(run, projectRole);
  } catch {
    return "advisor";
  }
}
