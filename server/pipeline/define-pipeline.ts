// Pipeline creation is the boundary where Lead-authored JSON becomes durable orchestration state.
import { randomUUID } from "node:crypto";
import {
  PEER_UNDERSTAND_STAGE_ID,
  PipelineInputDefinitionSchema,
  PipelineStateSchema,
  type PipelineDefinition,
  type PipelineEnvelope,
  type PipelineInputDefinition,
  type PipelineStageDefinition,
  type PipelineState,
  type StageState,
} from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import type { BusCaller } from "../bus/http-mcp";
import { peerRole } from "../project-prompts/defaults";
import { createPipelineWorktree, openPipelineWorktree } from "./pipeline-workspaces";
import { requirePipeline } from "./stage-context";
import { recoverPipelines } from "./stage-engine";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

// Serialize concurrent pipeline definition calls per run so parallel tool invocations from Master Lead never collide.
const definingRunLocks = new Map<string, Promise<unknown>>();

async function withRunDefineLock<ResultType>(runId: string, operation: () => Promise<ResultType>): Promise<ResultType> {
  const previousLock = definingRunLocks.get(runId) ?? Promise.resolve();
  const currentExecution = previousLock.catch(() => undefined).then(operation);
  definingRunLocks.set(runId, currentExecution);
  try {
    return await currentExecution;
  } finally {
    if (definingRunLocks.get(runId) === currentExecution) {
      definingRunLocks.delete(runId);
    }
  }
}

function pipelineKey(name: string, version: string): string {
  return `${name.trim().toLocaleLowerCase()}\u0000${version.trim()}`;
}

// Validates stage names and .slp/peers role references, then builds fresh pending StageState records.
export function materializePipelineStages(
  run: Run,
  stageDefinitions: readonly PipelineStageDefinition[],
): StageState[] {
  if (stageDefinitions.length === 0) {
    throw new ToolError("Provide at least one stage when creating the pipeline.");
  }
  const seenStageNames = new Set<string>();
  return stageDefinitions.map((stageDefinition) => {
    const normalizedStageName = stageDefinition.name.trim().toLocaleLowerCase();
    if (seenStageNames.has(normalizedStageName)) {
      throw new ToolError(`Stage name '${stageDefinition.name}' is duplicated.`);
    }
    seenStageNames.add(normalizedStageName);
    for (const peerAssignment of stageDefinition.peers) {
      try {
        // The snapshot is authoritative: arbitrary JSON cannot smuggle an unconfigured workflow.
        peerRole(run.promptConfig, peerAssignment.role);
      } catch (roleError) {
        throw new ToolError(roleError instanceof Error ? roleError.message : String(roleError));
      }
    }
    return {
      name: stageDefinition.name,
      goal: stageDefinition.goal,
      peers: stageDefinition.peers.map(({ role, task }) => ({ role, task })),
      id: randomUUID(),
      status: "pending",
      forkedLeadAgentId: null,
      peerAgentIds: [],
      reports: [],
      messages: [],
      result: null,
      startedAt: null,
      completedAt: null,
    };
  });
}

function normalizeInputDefinitions(rawInput: PipelineEnvelope | PipelineInputDefinition): PipelineInputDefinition[] {
  if ("pipelines" in rawInput || "pipeline" in rawInput) {
    const collectedDefinitions: PipelineInputDefinition[] = [];
    if (rawInput.pipeline) collectedDefinitions.push(PipelineInputDefinitionSchema.parse(rawInput.pipeline));
    if (rawInput.pipelines) {
      for (const candidateDefinition of rawInput.pipelines) {
        collectedDefinitions.push(PipelineInputDefinitionSchema.parse(candidateDefinition));
      }
    }
    if (collectedDefinitions.length === 0) {
      throw new ToolError("Provide 'pipeline' or 'pipelines' to define one or more task pipelines.");
    }
    return collectedDefinitions;
  }
  return [PipelineInputDefinitionSchema.parse(rawInput)];
}

function validateUniqueNames(
  ctx: PipelineContext,
  runId: string,
  definitions: readonly PipelineInputDefinition[],
): void {
  const existingPipelines = Object.values(ctx.store.require(runId).pipelines);
  const batchPipelineKeys = new Set<string>();
  for (const definition of definitions) {
    const stageNames = new Set<string>();
    for (const stage of definition.stages) {
      const normalizedName = stage.name.trim().toLocaleLowerCase();
      if (stageNames.has(normalizedName)) throw new ToolError(`Stage name '${stage.name}' is duplicated.`);
      stageNames.add(normalizedName);
    }
    const requestedKey = pipelineKey(definition.name, definition.version);
    const duplicate = existingPipelines.find(
      (pipeline) => pipelineKey(pipeline.name, pipeline.version) === requestedKey,
    );
    if (duplicate || batchPipelineKeys.has(requestedKey)) {
      throw new ToolError(`Pipeline '${definition.name}' version '${definition.version}' already exists.`);
    }
    batchPipelineKeys.add(requestedKey);
  }
}

function validatePeerRoles(
  ctx: PipelineContext,
  runId: string,
  definitions: readonly PipelineInputDefinition[],
): void {
  const run = ctx.store.require(runId);
  for (const definition of definitions) {
    for (const stage of definition.stages) {
      for (const assignment of stage.peers) {
        try {
          // The snapshot is authoritative: arbitrary JSON cannot smuggle an unconfigured workflow.
          peerRole(run.promptConfig, assignment.role);
        } catch (roleError) {
          throw new ToolError(roleError instanceof Error ? roleError.message : String(roleError));
        }
      }
    }
  }
}

function sanitizeDefinition(definition: PipelineInputDefinition, canonicalWorktree: string): PipelineDefinition {
  return {
    name: definition.name,
    version: definition.version,
    worktree: canonicalWorktree,
    description: definition.description,
    // systemPrompt is deliberately discarded; only the project role Markdown can define it.
    stages: definition.stages.map((stage) => ({
      ...stage,
      peers: stage.peers.map(({ role, task }) => ({ role, task })),
    })),
  };
}

function recheckWorkspaceAndIdentity(
  ctx: PipelineContext,
  runId: string,
  definition: PipelineDefinition,
  workspace: { cwd: string; branch: string },
  pendingBatchPipelines: readonly PipelineState[],
): void {
  const run = ctx.store.require(runId);
  // Opening a workspace awaits the daemon; an abort during that call must not resurrect the run.
  if (!["planning", "running"].includes(run.status)) throw new ToolError(`Cannot define a pipeline while run is '${run.status}'.`);
  const allKnownPipelines = [...Object.values(run.pipelines), ...pendingBatchPipelines];
  const requestedKey = pipelineKey(definition.name, definition.version);
  const duplicate = allKnownPipelines.find(
    (pipeline) => pipelineKey(pipeline.name, pipeline.version) === requestedKey,
  );
  if (duplicate) throw new ToolError(`Pipeline '${definition.name}' version '${definition.version}' already exists.`);
  const worktreeCollision = allKnownPipelines.find(
    (pipeline) => !["integrated", "failed"].includes(pipeline.status)
      && (pipeline.worktree === workspace.cwd || pipeline.branch === workspace.branch),
  );
  if (worktreeCollision) throw new ToolError(`Worktree or branch is already assigned to pipeline '${worktreeCollision.name}'.`);
}

// Handles Forked Lead creating the pipeline stages after confirming mutual understanding with Base Peer in peer_understand.
function definePipelineStagesFromForkedLead(
  ctx: PipelineContext,
  caller: BusCaller,
  rawInput: PipelineEnvelope | PipelineInputDefinition,
): string {
  const currentRun = ctx.store.require(caller.runId);
  const callerRecord = currentRun.agents[caller.agentId];
  if (!callerRecord || callerRecord.archivedAt || !callerRecord.pipelineId) {
    throw new ToolError("Forked Lead has no active pipeline assignment.");
  }
  const targetPipelineId =
    ("pipelineId" in rawInput && rawInput.pipelineId) ? rawInput.pipelineId : callerRecord.pipelineId;
  const targetPipeline = requirePipeline(currentRun, targetPipelineId);
  if (
    currentRun.status !== "running"
    || targetPipeline.status !== "peer_understand"
    || targetPipeline.peerUnderstand.status !== "running"
    || targetPipeline.peerUnderstand.forkedLeadAgentId !== caller.agentId
  ) {
    throw new ToolError("Forked Lead can only create pipeline stages while its peer_understand phase is running.");
  }
  // Enforce that Forked Lead and Base Peer have completed discovery and confirmed understanding before creating stages.
  if (targetPipeline.peerUnderstand.reports.length === 0) {
    throw new ToolError(
      "Confirm mutual understanding with Base Peer first: set the investigation goal via slp_send_peer_message and wait for Base Peer's slp_stage_report before creating the pipeline stages.",
    );
  }
  const requestedStages =
    ("stages" in rawInput && rawInput.stages)
    || ("pipeline" in rawInput && rawInput.pipeline?.stages)
    || ("pipelines" in rawInput && rawInput.pipelines?.[0]?.stages)
    || [];
  const materializedStages = materializePipelineStages(currentRun, requestedStages);
  const confirmationSummary =
    ("summary" in rawInput && rawInput.summary)
    || ("pipeline" in rawInput && rawInput.pipeline?.description)
    || `Confirmed mutual understanding with Base Peer and created ${materializedStages.length} pipeline stage(s).`;
  const confirmedAt = new Date().toISOString();

  ctx.store.mutate(caller.runId, (mutableRun) => {
    const mutablePipeline = requirePipeline(mutableRun, targetPipelineId);
    mutablePipeline.stages = materializedStages;
    mutablePipeline.peerUnderstand.result = {
      summary: confirmationSummary,
      approvedBy: caller.agentId,
      approvedAt: confirmedAt,
    };
    mutablePipeline.peerUnderstand.status = "completing";
    mutablePipeline.updatedAt = confirmedAt;
    const mutableCaller = mutableRun.agents[caller.agentId];
    if (mutableCaller) {
      mutableCaller.awaitingTool = null;
      mutableCaller.awaitingSince = null;
      mutableCaller.nudges = 0;
    }
    mutableRun.mailbox = mutableRun.mailbox.filter(
      (queuedMessage) =>
        !(
          queuedMessage.toAgentId === caller.agentId
          && (queuedMessage.awaitTool === "slp_define_pipeline" || queuedMessage.awaitTool === "slp_approve_stage")
        ),
    );
  });

  ctx.logEvent(caller.runId, {
    taskId: null,
    from: caller.agentId,
    to: "pipeline",
    kind: "stage.approved",
    summary: `${targetPipeline.name}/${PEER_UNDERSTAND_STAGE_ID}: ${confirmationSummary} (${materializedStages.length} stages defined)`,
    outcome: "delivered",
  });
  void recoverPipelines(ctx, caller.runId).catch((recoveryError) => {
    console.error(`[slp] stage startup failed after Forked Lead defined pipeline ${targetPipelineId}`, recoveryError);
  });
  return JSON.stringify({
    pipelineId: targetPipeline.id,
    name: targetPipeline.name,
    stagesDefined: materializedStages.length,
    message: "Mutual understanding confirmed and pipeline stages created. End your turn while Base Peer's session is checkpointed and Stage 1 starts.",
  });
}

export async function definePipeline(
  ctx: PipelineContext,
  runId: string,
  rawInput: PipelineEnvelope | PipelineInputDefinition,
  caller?: BusCaller,
): Promise<string> {
  return withRunDefineLock(runId, async () => {
    if (caller?.role === "forked_lead") {
      return definePipelineStagesFromForkedLead(ctx, caller, rawInput);
    }
    const run = ctx.store.require(runId);
    if (!["planning", "running"].includes(run.status)) {
      throw new ToolError(`Cannot define a pipeline while run is '${run.status}'.`);
    }
    const definitions = normalizeInputDefinitions(rawInput);
    validateUniqueNames(ctx, runId, definitions);
    validatePeerRoles(ctx, runId, definitions);

    const preparedPipelines: Array<{
      pipeline: PipelineState;
      workspace: Awaited<ReturnType<typeof openPipelineWorktree>>;
    }> = [];

    for (const definition of definitions) {
      // Automatically provision a dedicated Git worktree when the Master Lead omits worktree during task decomposition.
      let requestedWorktreePath = definition.worktree?.trim() ?? "";
      if (!requestedWorktreePath) {
        const autoCreatedPayload = JSON.parse(
          await createPipelineWorktree(ctx, runId, definition.name),
        ) as { cwd: string };
        requestedWorktreePath = autoCreatedPayload.cwd;
      }
      const latestRun = ctx.store.require(runId);
      const workspace = await openPipelineWorktree(ctx, latestRun, requestedWorktreePath);
      const sanitizedDefinition = sanitizeDefinition(definition, workspace.cwd);
      recheckWorkspaceAndIdentity(
        ctx,
        runId,
        sanitizedDefinition,
        workspace,
        preparedPipelines.map((entry) => entry.pipeline),
      );
      const pipelineId = randomUUID();
      const createdAt = new Date().toISOString();
      const pipeline = PipelineStateSchema.parse({
        ...sanitizedDefinition,
        id: pipelineId,
        status: "queued",
        // Every newly defined pipeline runs peer_understand first so Forked Lead sets the investigation goal,
        // Base Peer investigates and aligns with Forked Lead, and the stages are confirmed before Stage 1 forks.
        peerUnderstand: {
          status: "pending",
          investigationGoal: definition.investigationGoal ?? null,
          forkedLeadAgentId: null,
          basePeerAgentId: null,
          basePeerSessionId: null,
          reports: [],
          messages: [],
          result: null,
          startedAt: null,
          completedAt: null,
        },
        currentStageIndex: 0,
        workspaceId: workspace.workspaceId,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
        stages: sanitizedDefinition.stages.map((stage) => ({
          ...stage,
          id: randomUUID(),
          status: "pending",
          forkedLeadAgentId: null,
          peerAgentIds: [],
          reports: [],
          messages: [],
          result: null,
          startedAt: null,
          completedAt: null,
        })),
        pausedReason: null,
        createdAt,
        updatedAt: createdAt,
        finalReport: null,
        gate: null,
        mergedCommit: null,
        integratedAt: null,
      });
      preparedPipelines.push({ pipeline, workspace });
    }

    ctx.store.mutate(runId, (mutableRun) => {
      for (const { pipeline, workspace } of preparedPipelines) {
        // External worktrees are never treated as plugin-owned cleanup targets; a previously
        // created slp worktree retains its ownership record from slp_create_worktree.
        if (!Object.hasOwn(mutableRun.pipelineWorkspaces, workspace.workspaceId)) {
          mutableRun.pipelineWorkspaces[workspace.workspaceId] = { ...workspace, owned: false };
        }
        mutableRun.pipelines[pipeline.id] = pipeline;
      }
      mutableRun.status = "running";
      const masterLeadRecord = mutableRun.agents[mutableRun.masterLeadAgentId];
      // Clear either initial planning (slp_define_pipeline) or post-integration (slp_report) obligation when spawning new or UAT pipelines.
      if (masterLeadRecord?.awaitingTool === "slp_define_pipeline" || masterLeadRecord?.awaitingTool === "slp_report") {
        masterLeadRecord.awaitingTool = null;
        masterLeadRecord.awaitingSince = null;
        masterLeadRecord.nudges = 0;
      }
      // Drop any undelivered delegation, integration handover or reminder mail once new pipelines are running.
      mutableRun.mailbox = mutableRun.mailbox.filter(
        (queuedMessage) =>
          !(
            queuedMessage.toAgentId === mutableRun.masterLeadAgentId
            && (queuedMessage.awaitTool === "slp_define_pipeline" || queuedMessage.awaitTool === "slp_report")
          ),
      );
    });

    for (const { pipeline } of preparedPipelines) {
      ctx.logEvent(runId, {
        taskId: null,
        from: "master_lead",
        to: "pipeline",
        kind: "pipeline.defined",
        summary: `${pipeline.name} v${pipeline.version} (${pipeline.stages.length} stages)`,
        outcome: "delivered",
      });
    }
    // Spawn a dedicated Forked Lead for each defined pipeline and run all pipelines concurrently.
    void recoverPipelines(ctx, runId).catch((recoveryError) => {
      console.error(`[slp] pipeline startup failed for run ${runId}`, recoveryError);
    });

    const createdSummaries = preparedPipelines.map(({ pipeline }) => ({
      pipelineId: pipeline.id,
      name: pipeline.name,
      version: pipeline.version,
      worktree: pipeline.worktree,
      branch: pipeline.branch,
      workspaceId: pipeline.workspaceId,
      status: pipeline.status,
    }));
    const firstSummary = createdSummaries[0];
    return JSON.stringify({
      ...firstSummary,
      pipelineIds: createdSummaries.map((summary) => summary.pipelineId),
      pipelines: createdSummaries,
      message: createdSummaries.length === 1
        ? "Pipeline saved. Define any further independent pipelines, then end your turn so stage coordinators can start."
        : `${createdSummaries.length} parallel task pipelines saved. End your turn so each Forked Lead can start its assigned task concurrently.`,
    });
  });
}
