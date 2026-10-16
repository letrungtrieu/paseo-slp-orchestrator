// Answers permission prompts of SLP agents so no human has to (single point of contact).
// Called both from the lifecycle event (low latency) and from the sweeper (catches missed events).
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { AgentRecord, Run } from "../../shared/state";
import { decidePermission } from "./permissions";
import type { PipelineContext } from "../pipeline/context";

// requestIds already answered; a second answer to a resolved request would fail in the SDK
const answeredRequestIds = new Set<string>();

function workingDirectoryOf(run: Run, agentRecord: AgentRecord): string {
  // Cwd differs per role because the write policy is relative to the agent's own checkout: leads work in the dev worktree, the Supervisor in the user's repo.
  const task = agentRecord.taskId ? run.tasks[agentRecord.taskId] : null;
  if (agentRecord.role === "master_lead" || agentRecord.role === "forked_lead") return run.devCwd;
  if (agentRecord.role === "supervisor") return run.repoPath;
  return task?.workspace?.cwd ?? run.devCwd;
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
  answeredRequestIds.add(request.id);
  const { run, agentRecord } = lookup;
  const task = agentRecord.taskId ? run.tasks[agentRecord.taskId] : null;
  // The policy is pure and fed live task state, so a write lock lifts the moment the handshake approves.
  const decision = decidePermission(request, {
    role: agentRecord.role,
    taskPhase: task?.phase ?? null,
    agentCwd: workingDirectoryOf(run, agentRecord),
    writableScope: task?.writableScope ?? [],
  });
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
