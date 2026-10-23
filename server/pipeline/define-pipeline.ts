// Pipeline creation is the boundary where Lead-authored JSON becomes durable orchestration state.
import { randomUUID } from "node:crypto";
import {
  PipelineInputDefinitionSchema,
  PipelineStateSchema,
  type PipelineDefinition,
  type PipelineEnvelope,
  type PipelineInputDefinition,
  type PipelineStageDefinition,
  type PipelineState,
  type StageState,
} from "../../shared/pipeline";
import { ROLE_LABELS } from "../../shared/roles";
import type { Run } from "../../shared/state";
import type { BusCaller } from "../bus/http-mcp";
import { peerRole } from "../project-prompts/defaults";
import { createPipelineWorktree, openPipelineWorktree } from "./pipeline-workspaces";
import { recoverPipelines } from "./stage-engine";
import type { PipelineContext } from "./context";
import { assertQaPipelineDefinitionAllowed, qaPipelineWorkspace } from "./qa/qa-pipeline";
import { ToolError } from "./tool-error";

// Serialize concurrent pipeline definition calls per run so parallel tool invocations from Leads never collide.
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
      coordinatorSeenReports: 0,
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

// Check whether a Lead agent already owns an active (non-integrated, non-failed) pipeline.
function leadHasActivePipeline(
  run: Run,
  leadAgentId: string,
  pendingBatchPipelines: readonly PipelineState[],
): boolean {
  const allPipelines = [...Object.values(run.pipelines), ...pendingBatchPipelines];
  return allPipelines.some(
    (pipeline) =>
      pipeline.leadAgentId === leadAgentId &&
      !["integrated", "failed"].includes(pipeline.status),
  );
}

// Resolve or spawn the dedicated Lead agent that lives inside this pipeline's worktree and supervises all of its stages.
async function resolveOrSpawnPipelineLead(
  ctx: PipelineContext,
  runId: string,
  callerLeadId: string,
  pipelineName: string,
  workspace: Awaited<ReturnType<typeof openPipelineWorktree>>,
  pendingBatchPipelines: readonly PipelineState[],
): Promise<string> {
  const currentRun = ctx.store.require(runId);
  const callerRecord = currentRun.agents[callerLeadId];
  // Reuse the calling Lead when it does not already own another active concurrent pipeline.
  if (
    callerRecord &&
    !callerRecord.archivedAt &&
    !leadHasActivePipeline(currentRun, callerLeadId, pendingBatchPipelines)
  ) {
    return callerLeadId;
  }
  // When a Lead defines an additional concurrent pipeline, spawn a dedicated sibling Lead in that pipeline's worktree.
  const spawnedSiblingLead = await ctx.gateway.createAgent({
    runId,
    role: "master_lead",
    taskId: null,
    provider: currentRun.providers.lead,
    thinkingOptionId: currentRun.providers.leadThinkingOptionId ?? undefined,
    permissionModeId: currentRun.providers.leadPermissionModeId ?? undefined,
    parentAgentId: callerLeadId || currentRun.supervisorAgentId || undefined,
    workspaceId: workspace.workspaceId,
    peerWorktreePath: workspace.cwd,
    title: `[${ROLE_LABELS.master_lead}] [${pipelineName}]`,
    awaitTool: null,
  });
  return spawnedSiblingLead.agentId;
}

export async function definePipeline(
  ctx: PipelineContext,
  runId: string,
  rawInput: PipelineEnvelope | PipelineInputDefinition,
  caller?: BusCaller,
): Promise<string> {
  return withRunDefineLock(runId, async () => {
    const run = ctx.store.require(runId);
    if (!["planning", "running"].includes(run.status)) {
      throw new ToolError(`Cannot define a pipeline while run is '${run.status}'.`);
    }
    const definitions = normalizeInputDefinitions(rawInput);
    validateUniqueNames(ctx, runId, definitions);
    validatePeerRoles(ctx, runId, definitions);

    const callerLeadId = caller?.agentId || run.masterLeadAgentId;
    // QA pipelines verify the merged QA branch in place, so they skip worktree provisioning and Lead spawning below.
    const isQaDefinition = run.agents[callerLeadId]?.role === "qa_lead";
    if (isQaDefinition) assertQaPipelineDefinitionAllowed(run, callerLeadId, definitions);
    const preparedPipelines: Array<{
      pipeline: PipelineState;
      workspace: Awaited<ReturnType<typeof openPipelineWorktree>>;
      leadAgentId: string;
    }> = [];

    for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
      const definition = definitions[definitionIndex];
      const latestRunBeforeWorktree = ctx.store.require(runId);
      const callerRecord = latestRunBeforeWorktree.agents[callerLeadId];
      // Default to the calling Lead's pre-provisioned worktree when available and not yet claimed by an active pipeline.
      let requestedWorktreePath = definition.worktree?.trim() ?? "";
      if (!requestedWorktreePath && !isQaDefinition) {
        const callerWorktree = callerRecord?.worktreePath ?? "";
        const callerWorktreeAlreadyClaimed =
          !callerWorktree ||
          [...Object.values(latestRunBeforeWorktree.pipelines), ...preparedPipelines.map((entry) => entry.pipeline)].some(
            (existingPipeline) =>
              !["integrated", "failed"].includes(existingPipeline.status) &&
              existingPipeline.worktree === callerWorktree,
          );
        if (!callerWorktreeAlreadyClaimed && definitionIndex === 0) {
          requestedWorktreePath = callerWorktree;
        } else {
          const autoCreatedPayload = JSON.parse(
            await createPipelineWorktree(ctx, runId, definition.name),
          ) as { cwd: string };
          requestedWorktreePath = autoCreatedPayload.cwd;
        }
      }
      // Open and validate the worktree before mutating run state so invalid checkouts fail atomically.
      const latestRun = ctx.store.require(runId);
      const workspace = isQaDefinition
        ? await qaPipelineWorkspace(latestRun)
        : await openPipelineWorktree(ctx, latestRun, requestedWorktreePath);
      const sanitizedDefinition = sanitizeDefinition(definition, workspace.cwd);
      recheckWorkspaceAndIdentity(
        ctx,
        runId,
        sanitizedDefinition,
        workspace,
        preparedPipelines.map((entry) => entry.pipeline),
      );
      // Bind this pipeline to its dedicated Lead session so stage Peers can fork from that Lead in the same cwd.
      const owningLeadId = isQaDefinition
        ? callerLeadId
        : await resolveOrSpawnPipelineLead(
          ctx,
          runId,
          callerLeadId,
          definition.name,
          workspace,
          preparedPipelines.map((entry) => entry.pipeline),
        );
      const pipelineId = randomUUID();
      const createdAt = new Date().toISOString();
      // Persist all stage definitions in 'pending' state; recoverPipelines transitions Stage 1 to 'starting'.
      const pipeline = PipelineStateSchema.parse({
        ...sanitizedDefinition,
        id: pipelineId,
        kind: isQaDefinition ? "qa" : "feature",
        status: "queued",
        leadAgentId: owningLeadId,
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
      preparedPipelines.push({ pipeline, workspace, leadAgentId: owningLeadId });
    }

    ctx.store.mutate(runId, (mutableRun) => {
      for (const { pipeline, workspace, leadAgentId } of preparedPipelines) {
        // External worktrees are never treated as plugin-owned cleanup targets; a previously
        // created slp worktree retains its ownership record from slp_create_worktree.
        // The QA worktree is the run's dev workspace and is retired with the run, never as a pipeline workspace.
        if (pipeline.kind !== "qa" && !Object.hasOwn(mutableRun.pipelineWorkspaces, workspace.workspaceId)) {
          mutableRun.pipelineWorkspaces[workspace.workspaceId] = { ...workspace, owned: false };
        }
        mutableRun.pipelines[pipeline.id] = pipeline;
        const leadRecord = mutableRun.agents[leadAgentId];
        if (leadRecord) {
          leadRecord.pipelineId = pipeline.id;
          leadRecord.workspaceId = workspace.workspaceId;
          leadRecord.worktreePath = workspace.cwd;
          leadRecord.featureName = leadRecord.featureName ?? pipeline.name;
        }
      }
      mutableRun.status = "running";
      const callerLeadRecord = mutableRun.agents[callerLeadId];
      // Clear either initial planning (slp_define_pipeline) or post-integration (slp_report) obligation when spawning a new pipeline.
      if (callerLeadRecord?.awaitingTool === "slp_define_pipeline" || callerLeadRecord?.awaitingTool === "slp_report") {
        callerLeadRecord.awaitingTool = null;
        callerLeadRecord.awaitingSince = null;
        callerLeadRecord.nudges = 0;
      }
      // Drop any undelivered delegation, integration handover or reminder mail once new pipelines are running.
      mutableRun.mailbox = mutableRun.mailbox.filter(
        (queuedMessage) =>
          !(
            queuedMessage.toAgentId === callerLeadId
            && (queuedMessage.awaitTool === "slp_define_pipeline" || queuedMessage.awaitTool === "slp_report")
          ),
      );
    });

    for (const { pipeline, leadAgentId } of preparedPipelines) {
      ctx.logEvent(runId, {
        taskId: null,
        from: leadAgentId || "master_lead",
        to: "pipeline",
        kind: "pipeline.defined",
        summary: `${pipeline.name} v${pipeline.version} (${pipeline.stages.length} stages)`,
        outcome: "delivered",
      });
    }
    // Start Stage 1 for each defined pipeline and fork stage Peers directly from the owning Lead's session.
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
      leadAgentId: pipeline.leadAgentId,
      status: pipeline.status,
    }));
    const firstSummary = createdSummaries[0];
    return JSON.stringify({
      ...firstSummary,
      pipelineIds: createdSummaries.map((summary) => summary.pipelineId),
      pipelines: createdSummaries,
      message: createdSummaries.length === 1
        ? "Pipeline saved. End your turn while Stage 1 Peers fork from your session and start work."
        : `${createdSummaries.length} parallel task pipelines saved. End your turn while each Lead and its Stage 1 Peers start work concurrently.`,
    });
  });
}
