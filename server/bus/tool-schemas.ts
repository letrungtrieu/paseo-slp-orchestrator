// Catalogue of tools exposed by the plugin-hosted MCP bus (spec section 2.1). Each agent is
// only shown the tools of its own role; callers outside the list are rejected as "blocked".
import { z } from "zod";
import type { SlpRole } from "../../shared/roles";
import { PlanSchema, TaskDefinitionSchema } from "../../shared/state";

// Task ids come from the Master Lead's own split, so a typo is caught by the pipeline lookup rather than by the schema.
const taskIdField = z.string().min(1).describe("Id of the target task");

export const BUS_TOOL_DEFINITIONS = {
  slp_delegate: {
    roles: ["supervisor"],
    description: "Hand the project to the Master Lead with the overall acceptance criteria.",
    // A minimum length keeps the Supervisor from delegating with a one-line brief the Master Lead cannot plan from.
    input: z.object({ acceptanceCriteria: z.string().min(20) }),
  },
  slp_request_rework: {
    roles: ["supervisor"],
    description: "Send the Master Lead's result back because acceptance criteria are not met.",
    input: z.object({ feedback: z.string().min(1) }),
  },
  slp_present_to_manager: {
    roles: ["supervisor"],
    description: "Declare the result verified and present it to the Supreme Manager for final approval.",
    input: z.object({ report: z.string().min(1) }),
  },
  slp_define_tasks: {
    roles: ["master_lead"],
    description:
      // Overlap is enforced by the pipeline (findScopeOverlaps), the description only tells the Lead why a call may be rejected.
      "Define all work packages once the Master Spec is written. Writable scopes must not overlap.",
    input: z.object({
      masterSpecPath: z.string().min(1),
      tasks: z.array(TaskDefinitionSchema).min(1),
    }),
  },
  slp_consult_peer: {
    roles: ["master_lead"],
    // The Implementer is still idle with its full context, which is why the Lead may consult it instead of re-reading the code.
    description: "Ask the Implementer of a task (still idle, with full memory) a question.",
    input: z.object({ taskId: taskIdField, question: z.string().min(1) }),
  },
  slp_spec_decision: {
    roles: ["master_lead"],
    description: "Resolve an escalation or tripped circuit breaker; resumes the paused task.",
    input: z.object({ taskId: taskIdField, decision: z.string().min(1) }),
  },
  slp_archive_task: {
    roles: ["master_lead"],
    description: "Mark a task merged into your branch and archive its worktree and peers.",
    input: z.object({ taskId: taskIdField }),
  },
  slp_report: {
    roles: ["master_lead"],
    description: "Report the finished, integration-tested project to the Supervisor.",
    // Defaults let the model omit empty lists, which it does often; a missing array would otherwise fail validation.
    input: z.object({ summary: z.string().min(1), acceptanceDocPaths: z.array(z.string()).default([]) }),
  },
  slp_submit_plan: {
    roles: ["implementer"],
    description: "Submit your restated goal, discrepancies with the Lead's assumptions and planned files.",
    input: PlanSchema,
  },
  slp_stage_done: {
    roles: ["implementer"],
    description: "Report that implementation (or a fix) is committed and ready for the scope gate.",
    input: z.object({ summary: z.string().min(1) }),
  },
  slp_doc_done: {
    // Doc writing may be done by the Implementer or by a dedicated doc peer, hence two roles for one tool.
    roles: ["implementer", "doc"],
    description: "Report that .slp/ACCEPTANCE_DOC.md is written.",
    input: z.object({}),
  },
  slp_verdict: {
    roles: ["qa", "security"],
    description: "Report APPROVED or REJECTED with a concrete issue list.",
    input: z.object({
      verdict: z.enum(["APPROVED", "REJECTED"]),
      // Verdicts without issues are valid for APPROVED, so an empty list is the default rather than an error.
      issues: z.array(z.string()).default([]),
    }),
  },
  slp_ask_sibling: {
    // Sibling queries are open to every task peer but stay read-only; the wrapper text in the prompt removes any authority to change code.
    roles: ["implementer", "qa", "security"],
    description: "Read-only question to the Implementer of another task about its current code.",
    input: z.object({ taskId: taskIdField, question: z.string().min(1) }),
  },
  slp_answer: {
    roles: ["implementer", "qa", "security"],
    description: "Answer a question that was sent to you.",
    input: z.object({ questionId: z.string().min(1), answer: z.string().min(1) }),
  },
  slp_escalate: {
    roles: ["implementer", "qa", "security"],
    description:
      "Escalate to the Master Lead when the spec or a contract cannot be implemented as written.",
    input: z.object({ reason: z.string().min(1) }),
  },
// 'satisfies' checks the shape without widening, so roles and input types stay literal for the typed handler map.
} as const satisfies Record<string, { roles: readonly SlpRole[]; description: string; input: z.ZodType }>;

export type BusToolName = keyof typeof BUS_TOOL_DEFINITIONS;

// Used to show each agent only its own tools; role filtering is enforced again at dispatch because the list alone is not a security boundary.
export function toolNamesForRole(role: SlpRole): BusToolName[] {
  return (Object.keys(BUS_TOOL_DEFINITIONS) as BusToolName[]).filter((toolName) =>
    (BUS_TOOL_DEFINITIONS[toolName].roles as readonly SlpRole[]).includes(role),
  );
}

export function isBusToolName(candidate: string): candidate is BusToolName {
  return candidate in BUS_TOOL_DEFINITIONS;
}
