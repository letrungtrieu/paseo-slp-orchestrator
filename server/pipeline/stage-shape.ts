// Enforces the single-writer pipeline shape at definition time, before any agent is spawned:
// planning stages hold only advisors, an implement stage holds exactly one developer,
// and verify stages (QA pipelines only) hold QA graders plus at most one developer who fixes.
import type { PipelineInputDefinition, PipelineStageDefinition, StageKind } from "../../shared/pipeline";
import { peerKindOf, type PeerKind } from "../../shared/project-prompts";
import type { Run } from "../../shared/state";
import { peerRole } from "../project-prompts/defaults";
import { ToolError } from "./tool-error";

export type PipelineKindForShape = "feature" | "qa";

function stagePeerKinds(run: Run, stage: PipelineStageDefinition): PeerKind[] {
  // peerRole throws for unknown roles; the caller already validated them, so this only reads the snapshot.
  return stage.peers.map((assignment) => peerKindOf(peerRole(run.promptConfig, assignment.role)));
}

// Inference lets a Lead omit `kind`, while an explicit kind that contradicts the peers is still rejected below.
export function inferStageKind(peerKinds: readonly PeerKind[]): StageKind {
  if (peerKinds.every((peerKind) => peerKind === "advisor")) return "planning";
  if (peerKinds.includes("qa")) return "verify";
  return "implement";
}

function countKind(peerKinds: readonly PeerKind[], wanted: PeerKind): number {
  return peerKinds.filter((peerKind) => peerKind === wanted).length;
}

function assertStageMembers(stage: PipelineStageDefinition, kind: StageKind, peerKinds: readonly PeerKind[]): void {
  const developerCount = countKind(peerKinds, "developer");
  if (kind === "planning" && peerKinds.some((peerKind) => peerKind !== "advisor")) {
    throw new ToolError(`Stage '${stage.name}' is a planning stage: assign only advisor peers (they discuss the approach with you and never write code).`);
  }
  if (kind === "mockup" && countKind(peerKinds, "qa") > 0) {
    throw new ToolError(`Stage '${stage.name}' is a mockup stage: assign advisor and/or developer engineer peers to analyze sub-parts and assemble '.slp/mockups/<feature>/index.html' (no QA graders).`);
  }
  if (kind === "implement" && (developerCount !== 1 || peerKinds.length !== 1)) {
    throw new ToolError(`Stage '${stage.name}' is an implement stage: assign exactly one developer peer and nobody else. One writer avoids conflicting edits; QA grading happens in the QA Lead's pipeline.`);
  }
  if (kind === "verify") {
    if (countKind(peerKinds, "qa") === 0) throw new ToolError(`Stage '${stage.name}' is a verify stage: assign at least one QA peer to grade the scorecard.`);
    if (countKind(peerKinds, "advisor") > 0) throw new ToolError(`Stage '${stage.name}' is a verify stage: advisors belong to the planning or mockup stage only.`);
    if (developerCount > 1) throw new ToolError(`Stage '${stage.name}' may hold at most one developer peer (the fixer).`);
  }
}

function assertFeatureShape(definition: PipelineInputDefinition, stageKinds: readonly StageKind[]): void {
  const planningIndexes = stageKinds.flatMap((kind, index) => (kind === "planning" ? [index] : []));
  const mockupIndexes = stageKinds.flatMap((kind, index) => (kind === "mockup" ? [index] : []));
  const implementCount = stageKinds.filter((kind) => kind === "implement").length;
  // The feature shape supports optional planning and/or interactive HTML mockup review, then one build by one developer.
  if (stageKinds.includes("verify")) {
    throw new ToolError("Feature pipelines do not grade themselves: QA verification runs once in the QA Lead's pipeline on the merged branch. Remove the verify stage.");
  }
  if (planningIndexes.length > 1 || (planningIndexes.length === 1 && planningIndexes[0] !== 0)) {
    throw new ToolError("A feature pipeline may have one planning stage and it must be the first stage.");
  }
  const expectedMockupIndex = planningIndexes.length === 1 ? 1 : 0;
  if (mockupIndexes.length > 1 || (mockupIndexes.length === 1 && mockupIndexes[0] !== expectedMockupIndex)) {
    throw new ToolError("A feature pipeline may have at most one mockup stage placed immediately before the implement stage ([planning?] -> [mockup?] -> implement).");
  }
  if (implementCount !== 1 || stageKinds.at(-1) !== "implement") {
    throw new ToolError("A feature pipeline must end with exactly one implement stage (one developer peer). Shape: [planning?] -> [mockup?] -> implement.");
  }
  const hasPreImplementStage = planningIndexes.length === 1 || mockupIndexes.length === 1;
  // Without a planning or mockup stage there is nothing that could produce the brief later, so it must come with the definition.
  if (!hasPreImplementStage && !definition.brief) {
    throw new ToolError("Provide pipeline.brief ({ approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }) or start with a planning/mockup stage that produces it.");
  }
  if (hasPreImplementStage && definition.brief) {
    throw new ToolError("This pipeline has a planning or mockup stage, so the brief is supplied when you approve that stage. Omit pipeline.brief.");
  }
}

function assertQaShape(stageKinds: readonly StageKind[]): void {
  // QA graders verify the merged build; design discussion and HTML mockups already happened in the feature pipelines.
  if (stageKinds.includes("planning") || stageKinds.includes("mockup")) {
    throw new ToolError("QA pipelines have no planning or mockup stage; use verify (and, if needed, implement) stages.");
  }
}

// Returns the kind of a stage participant from the run's role snapshot; legacy records without a project role write code.
export function agentPeerKind(run: Run, projectRole: string | null): PeerKind {
  if (!projectRole) return "developer";
  return peerKindOf(peerRole(run.promptConfig, projectRole));
}

// Returns the resolved kind of every stage so the caller can persist it.
export function resolvePipelineShape(
  run: Run,
  definition: PipelineInputDefinition,
  pipelineKind: PipelineKindForShape,
): StageKind[] {
  const stageKinds = definition.stages.map((stage) => {
    const peerKinds = stagePeerKinds(run, stage);
    const kind = stage.kind ?? inferStageKind(peerKinds);
    assertStageMembers(stage, kind, peerKinds);
    return kind;
  });
  if (pipelineKind === "feature") assertFeatureShape(definition, stageKinds);
  else assertQaShape(stageKinds);
  return stageKinds;
}
