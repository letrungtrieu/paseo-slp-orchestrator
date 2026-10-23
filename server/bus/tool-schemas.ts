// Catalogue of tools exposed by the plugin-hosted MCP bus.
// Each runtime role sees only the coordination actions it is authorized to perform.
import { z } from "zod";
import { SLP_ROLES, type SlpRole } from "../../shared/roles";
import {
  DelegationSubmissionSchema,
  PipelineEnvelopeSchema,
  StageReportSubmissionSchema,
} from "../../shared/pipeline";

const pipelineIdField = z.string().trim().min(1).describe("Id of the target pipeline");

export const BUS_TOOL_DEFINITIONS = {
  // Each Lead defines the stage pipeline for its dedicated feature worktree; the QA Lead defines QA pipelines on the QA branch.
  slp_define_pipeline: {
    roles: ["master_lead", "qa_lead"],
    description: "Define the stage pipeline(s) for this Lead's feature worktree, or the QA Lead's verification pipeline on the QA branch.",
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
  // A feature Lead merges its completed branch into the QA branch; the QA Lead closes its QA pipeline in place.
  slp_finalize_pipeline: {
    roles: ["master_lead", "qa_lead"],
    description: "Finalize a completed pipeline: merge a feature branch into the QA branch, or close the QA Lead's verification pipeline.",
    input: z.object({ pipelineId: pipelineIdField.optional(), summary: z.string().trim().min(1) }),
  },
  slp_resume_pipeline: {
    roles: ["master_lead", "qa_lead"],
    description: "Resume a paused pipeline with a decision or new guidance.",
    input: z.object({ pipelineId: pipelineIdField, feedback: z.string().trim().min(1) }),
  },
  // One-way: queued for the recipient, nothing waits on it. Use slp_ask when the answer is needed to proceed.
  slp_notify: {
    // Leads can notify sibling Leads (cross-feature API/flow alignment) or stage Peers; Peers can notify their Lead or sibling stage Peers.
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Send a one-way notification (no reply expected, does not block) to a sibling Lead or a stage participant. Use slp_ask if you need an answer.",
    input: z.object({
      toAgentId: z.string().trim().min(1),
      message: z.string().trim().min(1),
    }),
  },
  // Blocking question: returns the answer itself, or a pending notice to resume with slp_await_answer.
  slp_ask: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Ask a sibling Lead or stage participant a question you need answered before you can proceed. Blocks up to ~40 seconds and returns the answer; if it returns 'no answer yet', call slp_await_answer to keep waiting.",
    input: z.object({
      toAgentId: z.string().trim().min(1),
      question: z.string().trim().min(1),
    }),
  },
  slp_await_answer: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Keep waiting (up to ~40 seconds per call) for the answer to a question you asked with slp_ask. Also returns questions addressed to you that arrived meanwhile.",
    input: z.object({ questionId: z.string().trim().min(1) }),
  },
  slp_answer: {
    roles: ["master_lead", "qa_lead", "peer"],
    description: "Answer a question another agent asked you with slp_ask; the asker is blocked until you do.",
    input: z.object({
      questionId: z.string().trim().min(1),
      answer: z.string().trim().min(1),
    }),
  },
  slp_stage_report: {
    // Stage peers submit structured findings or blockers via slp_stage_report.
    roles: ["peer"],
    description: "Submit this peer's findings or blocker for the current stage.",
    input: StageReportSubmissionSchema,
  },
  slp_approve_stage: {
    roles: ["master_lead", "qa_lead"],
    description: "Approve the current stage after reviewing peer reports and the worktree diff to advance the pipeline.",
    input: z.object({
      summary: z.string().trim().min(1),
    }),
  },
  slp_stage_rework: {
    roles: ["master_lead", "qa_lead"],
    description: "Request another pass from selected stage peers with concrete feedback.",
    input: z.object({
      agentIds: z.array(z.string().trim().min(1)).default([]),
      feedback: z.string().trim().min(1),
    }),
  },
  slp_escalate: {
    roles: ["master_lead", "peer"],
    description: "Escalate a blocked stage or implementation decision to the Lead.",
    input: z.object({ reason: z.string().trim().min(1) }),
  },
  // Supervisor lifecycle tools stay separate from stage coordination so only the Supervisor can
  // decompose features into Lead worktrees and communicate acceptance decisions to the human manager.
  slp_delegate: {
    roles: ["supervisor"],
    description: "Delegate 1 or N parallel features/tasks to dedicated Lead agents in isolated worktrees with full cross-Lead awareness. Every feature needs the human-approved productSpec (screens, states, Given/When/Then interactions).",
    input: DelegationSubmissionSchema,
  },
  slp_request_rework: {
    roles: ["supervisor"],
    description: "Send the Lead's result back because acceptance criteria are not met.",
    input: z.object({ feedback: z.string().trim().min(1) }),
  },
  slp_present_to_manager: {
    roles: ["supervisor"],
    description: "Declare the result verified and present it to the Supreme Manager for final approval.",
    input: z.object({ report: z.string().trim().min(1) }),
  },
  // Only the QA Lead reports, so the Supervisor never receives a merged result that nobody verified.
  slp_report: {
    roles: ["qa_lead"],
    description: "Report the verified QA branch result to the Supervisor.",
    input: z.object({ summary: z.string().trim().min(1) }),
  },
  // Enables the Supervisor or Lead to manually respawn dead, archived or stalled sessions on demand.
  slp_revive_agent: {
    roles: ["supervisor", "master_lead", "qa_lead"],
    description: "Revive dead, archived, errored or stalled Lead or stage Peer agents and resume their pending obligation.",
    input: z.object({
      target: z.enum(["auto", "master_lead", "stage_cohort", "agent"]).default("auto"),
      agentId: z.string().trim().min(1).optional(),
      pipelineId: pipelineIdField.optional(),
      reason: z.string().trim().min(1).optional(),
    }),
  },
  // Allows a Lead to either cancel a hung peer shell command with guidance or extend its watchdog timer.
  slp_handle_peer_shell: {
    roles: ["master_lead", "qa_lead"],
    description: "Cancel a hung peer shell command and deliver corrective guidance, or extend its idle-output watchdog timer.",
    input: z.object({
      peerAgentId: z.string().trim().min(1),
      action: z.enum(["cancel", "wait"]),
      guidance: z.string().trim().min(1).optional(),
      waitSeconds: z.number().int().min(15).max(1800).optional(),
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
