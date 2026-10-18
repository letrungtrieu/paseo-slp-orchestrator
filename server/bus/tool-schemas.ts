// Catalogue of tools exposed by the plugin-hosted MCP bus.
// Each runtime role sees only the coordination actions it is authorized to perform.
import { z } from "zod";
import { SLP_ROLES, type SlpRole } from "../../shared/roles";
import { PipelineEnvelopeSchema, StageReportSubmissionSchema } from "../../shared/pipeline";

const pipelineIdField = z.string().trim().min(1).describe("Id of the target pipeline");

export const BUS_TOOL_DEFINITIONS = {
  // The Master Lead can submit one pipeline or an array of parallel task pipelines (each spawning its own Forked Lead).
  slp_define_pipeline: {
    roles: ["master_lead"],
    description: "Define one or more parallel task pipelines (via 'pipeline' or 'pipelines'). Each pipeline spawns a dedicated Forked Lead and auto-creates a worktree if 'worktree' is omitted.",
    input: PipelineEnvelopeSchema,
  },
  slp_list_pipelines: {
    roles: SLP_ROLES,
    description: "List pipeline summaries for this run.",
    input: z.object({}),
  },
  slp_get_pipeline: {
    roles: SLP_ROLES,
    description: "Read a pipeline's stages, peer reports and direct stage messages.",
    input: z.object({ pipelineId: pipelineIdField.optional() }),
  },
  slp_create_worktree: {
    roles: ["master_lead"],
    description: "Create a worktree for the current run or pipeline and return its path and branch.",
    input: z.object({ name: z.string().trim().min(1) }),
  },
  // Either the pipeline's Forked Lead or the Master Lead can finalize and merge the completed pipeline branch.
  slp_finalize_pipeline: {
    roles: ["forked_lead", "master_lead"],
    description: "Finalize a completed pipeline after verifying and merging its worktree branch into the integration branch.",
    input: z.object({ pipelineId: pipelineIdField.optional(), summary: z.string().trim().min(1) }),
  },
  slp_resume_pipeline: {
    roles: ["master_lead"],
    description: "Resume a paused pipeline with a decision or new guidance.",
    input: z.object({ pipelineId: pipelineIdField, feedback: z.string().trim().min(1) }),
  },
  slp_send_peer_message: {
    roles: ["forked_lead", "peer"],
    description: "Send a direct message to a peer in the pipeline or another Forked Lead to clarify implementation or merge conflicts.",
    input: z.object({
      toAgentId: z.string().trim().min(1),
      message: z.string().trim().min(1),
      waitForReply: z.boolean().default(false),
    }),
  },
  slp_stage_report: {
    roles: ["peer"],
    description: "Submit this peer's findings or blocker for the current stage.",
    input: StageReportSubmissionSchema,
  },
  slp_approve_stage: {
    roles: ["forked_lead"],
    description: "Approve the current stage when its goal is met and move the pipeline to the next stage.",
    input: z.object({ summary: z.string().trim().min(1) }),
  },
  slp_stage_rework: {
    roles: ["forked_lead"],
    description: "Request another pass from selected stage peers with concrete feedback.",
    input: z.object({
      agentIds: z.array(z.string().trim().min(1)).default([]),
      feedback: z.string().trim().min(1),
    }),
  },
  slp_escalate: {
    roles: ["forked_lead", "peer"],
    description: "Escalate a blocked stage or implementation decision to the Master Lead.",
    input: z.object({ reason: z.string().trim().min(1) }),
  },
  // Supervisor lifecycle tools stay separate from stage coordination so only the Supervisor can
  // communicate acceptance decisions to the human manager.
  slp_delegate: {
    roles: ["supervisor"],
    description: "Hand the project to the Master Lead with the overall acceptance criteria.",
    input: z.object({ acceptanceCriteria: z.string().trim().min(20) }),
  },
  slp_request_rework: {
    roles: ["supervisor"],
    description: "Send the Master Lead's result back because acceptance criteria are not met.",
    input: z.object({ feedback: z.string().trim().min(1) }),
  },
  slp_present_to_manager: {
    roles: ["supervisor"],
    description: "Declare the result verified and present it to the Supreme Manager for final approval.",
    input: z.object({ report: z.string().trim().min(1) }),
  },
  slp_report: {
    roles: ["master_lead"],
    description: "Report the integrated pipeline result to the Supervisor.",
    input: z.object({ summary: z.string().trim().min(1) }),
  },
  // Enables the Supervisor or Master Lead to manually respawn dead, archived or stalled sessions on demand.
  slp_revive_agent: {
    roles: ["supervisor", "master_lead"],
    description: "Revive dead, archived, errored or stalled Master Lead, Forked Lead or stage Peer agents and resume their pending obligation.",
    input: z.object({
      target: z.enum(["auto", "master_lead", "stage_cohort", "agent"]).default("auto"),
      agentId: z.string().trim().min(1).optional(),
      pipelineId: pipelineIdField.optional(),
      reason: z.string().trim().min(1).optional(),
    }),
  },
  // This read-only summary remains useful to all agents without exposing database paths or tokens.
  slp_get_run: {
    roles: SLP_ROLES,
    description: "Read the run's acceptance criteria, status and pipeline summaries.",
    input: z.object({}),
  },
} as const satisfies Record<string, { roles: readonly SlpRole[]; description: string; input: z.ZodType }>;

export type BusToolName = keyof typeof BUS_TOOL_DEFINITIONS;

// Filtering here controls discovery; dispatch repeats the same role check as the security boundary.
export function toolNamesForRole(role: SlpRole): BusToolName[] {
  return (Object.keys(BUS_TOOL_DEFINITIONS) as BusToolName[]).filter((toolName) =>
    (BUS_TOOL_DEFINITIONS[toolName].roles as readonly SlpRole[]).includes(role),
  );
}

export function isBusToolName(candidate: string): candidate is BusToolName {
  // Tool names come from external requests; inherited object methods are never bus operations.
  return Object.hasOwn(BUS_TOOL_DEFINITIONS, candidate);
}
