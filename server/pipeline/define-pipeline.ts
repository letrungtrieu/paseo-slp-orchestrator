// Pipeline creation is the boundary where Lead-authored JSON becomes durable orchestration state.
import { randomUUID } from "node:crypto";
import {
  PipelineDefinitionSchema,
  PipelineStateSchema,
  type PipelineDefinition,
} from "../../shared/pipeline";
import { peerRole } from "../project-prompts/defaults";
import { openPipelineWorktree } from "./pipeline-workspaces";
import { recoverPipelines } from "./stage-engine";
import type { PipelineContext } from "./context";
import { ToolError } from "./tool-error";

// A run-level lock prevents two Lead turns from handing the same branch to overlapping cohorts.
const definingRuns = new Set<string>();

function pipelineKey(name: string, version: string): string {
  return `${name.trim().toLocaleLowerCase()}\u0000${version.trim()}`;
}

function validateUniqueNames(ctx: PipelineContext, runId: string, definition: PipelineDefinition): void {
  const stageNames = new Set<string>();
  for (const stage of definition.stages) {
    const normalizedName = stage.name.trim().toLocaleLowerCase();
    if (stageNames.has(normalizedName)) throw new ToolError(`Stage name '${stage.name}' is duplicated.`);
    stageNames.add(normalizedName);
  }
  const requestedKey = pipelineKey(definition.name, definition.version);
  const duplicate = Object.values(ctx.store.require(runId).pipelines).find(
    (pipeline) => pipelineKey(pipeline.name, pipeline.version) === requestedKey,
  );
  if (duplicate) throw new ToolError(`Pipeline '${definition.name}' version '${definition.version}' already exists.`);
}

function validatePeerRoles(ctx: PipelineContext, runId: string, definition: PipelineDefinition): void {
  const run = ctx.store.require(runId);
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

function sanitizeDefinition(definition: PipelineDefinition, canonicalWorktree: string): PipelineDefinition {
  return {
    ...definition,
    worktree: canonicalWorktree,
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
): void {
  const run = ctx.store.require(runId);
  // Opening a workspace awaits the daemon; an abort during that call must not resurrect the run.
  if (!["planning", "running"].includes(run.status)) throw new ToolError(`Cannot define a pipeline while run is '${run.status}'.`);
  const requestedKey = pipelineKey(definition.name, definition.version);
  const duplicate = Object.values(run.pipelines).find(
    (pipeline) => pipelineKey(pipeline.name, pipeline.version) === requestedKey,
  );
  if (duplicate) throw new ToolError(`Pipeline '${definition.name}' version '${definition.version}' already exists.`);
  const worktreeCollision = Object.values(run.pipelines).find(
    (pipeline) => !["integrated", "failed"].includes(pipeline.status)
      && (pipeline.worktree === workspace.cwd || pipeline.branch === workspace.branch),
  );
  if (worktreeCollision) throw new ToolError(`Worktree or branch is already assigned to pipeline '${worktreeCollision.name}'.`);
}

export async function definePipeline(
  ctx: PipelineContext,
  runId: string,
  rawDefinition: PipelineDefinition,
): Promise<string> {
  if (definingRuns.has(runId)) throw new ToolError("Another pipeline definition is already being prepared for this run.");
  definingRuns.add(runId);
  try {
    const run = ctx.store.require(runId);
    if (!["planning", "running"].includes(run.status)) {
      throw new ToolError(`Cannot define a pipeline while run is '${run.status}'.`);
    }
    const definition = PipelineDefinitionSchema.parse(rawDefinition);
    validateUniqueNames(ctx, runId, definition);
    validatePeerRoles(ctx, runId, definition);

    // Worktree validation resolves relative paths, repository ownership and the current branch
    // before any pipeline record can claim the checkout.
    const workspace = await openPipelineWorktree(ctx, run, definition.worktree);
    const sanitizedDefinition = sanitizeDefinition(definition, workspace.cwd);
    recheckWorkspaceAndIdentity(ctx, runId, sanitizedDefinition, workspace);
    const pipelineId = randomUUID();
    const createdAt = new Date().toISOString();
    const pipeline = PipelineStateSchema.parse({
      ...sanitizedDefinition,
      id: pipelineId,
      status: "queued",
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
    ctx.store.mutate(runId, (mutableRun) => {
      // External worktrees are never treated as plugin-owned cleanup targets; a previously
      // created slp worktree retains its ownership record from slp_create_worktree.
      if (!Object.hasOwn(mutableRun.pipelineWorkspaces, workspace.workspaceId)) {
        mutableRun.pipelineWorkspaces[workspace.workspaceId] = { ...workspace, owned: false };
      }
      mutableRun.pipelines[pipelineId] = pipeline;
      mutableRun.status = "running";
    });
    ctx.logEvent(runId, {
      taskId: null,
      from: "master_lead",
      to: "pipeline",
      kind: "pipeline.defined",
      summary: `${pipeline.name} v${pipeline.version} (${pipeline.stages.length} stages)`,
      outcome: "delivered",
    });
    // The definition tool returns before native forks and peer sessions are allocated.
    void recoverPipelines(ctx, runId).catch((recoveryError) => {
      console.error(`[slp] pipeline ${pipelineId} startup failed`, recoveryError);
    });
    return JSON.stringify({
      pipelineId,
      name: pipeline.name,
      version: pipeline.version,
      worktree: pipeline.worktree,
      branch: pipeline.branch,
      workspaceId: pipeline.workspaceId,
      status: pipeline.status,
      message: "Pipeline saved. Define any further independent pipelines, then end your turn so stage coordinators can start.",
    });
  } finally {
    definingRuns.delete(runId);
  }
}
