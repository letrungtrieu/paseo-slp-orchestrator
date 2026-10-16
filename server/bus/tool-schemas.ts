// Catalogue of tools exposed by the plugin-hosted MCP bus (spec section 2.1). Each agent is
// only shown the tools of its own role; callers outside the list are rejected as "blocked".
import { z } from "zod";
import { SLP_ROLES, type SlpRole } from "../../shared/roles";
import { PlanSchema, TaskDefinitionSchema, TaskPhaseSchema } from "../../shared/state";
import { AcceptanceReportSchema, PeerReportSubmissionSchema } from "../../shared/reports";
import { ProjectRoleIdSchema } from "../../shared/project-prompts";

// Task ids come from the Master Lead's own split, so a typo is caught by the pipeline lookup rather than by the schema.
const taskIdField = z.string().min(1).describe("Id of the target task");

export const BUS_TOOL_DEFINITIONS = {
  slp_list_peer_roles: {
    roles: SLP_ROLES,
    // Metadata supports assignment decisions without pulling other peers' workflows into the caller's context.
    description: "List this project's peer role IDs and YAML front matter. Roles have no fixed kind; the Lead chooses their assignment. Continue after this read.",
    input: z.object({}),
  },
  slp_spawn_peer: {
    roles: ["master_lead"],
    description: "Spawn a project peer by role ID and brief. Omit taskId for a read-only project consultation, including during planning. A task assignment can grant writes explicitly during coding. The peer reports back to you.",
    input: z.object({ taskId: taskIdField.optional(), role: ProjectRoleIdSchema, brief: z.string().trim().min(1), allowWrites: z.boolean().default(false) }),
  },
  slp_prompt_peer: {
    roles: ["master_lead"],
    // Follow-up assignments reuse the peer's context and reports instead of creating duplicate sessions.
    description: "Send a follow-up brief to an additional peer in this run; its next report arrives as a message.",
    input: z.object({ agentId: z.string().min(1), brief: z.string().trim().min(1) }),
  },
  slp_peer_report: {
    roles: ["peer"],
    description: "Persist findings or a blocker for your additional assignment and report back to the Lead.",
    input: PeerReportSubmissionSchema,
  },
  // Read tools use authenticated run ownership so agents never need a database path or access token.
  slp_get_run: {
    roles: SLP_ROLES,
    description: "Read this run's criteria, Master Spec, status and project reports from SQLite. Continue working after this read.",
    input: z.object({}),
  },
  slp_list_tasks: {
    roles: SLP_ROLES,
    description: "List task summaries for this run, optionally filtered by phase. Continue working after this read.",
    input: z.object({ phase: TaskPhaseSchema.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
  },
  // Omitting taskId selects the caller's own task; run-level agents must supply it explicitly.
  slp_get_task: {
    roles: SLP_ROLES,
    description: "Read a task's purpose, assumptions, writable scope, plan and review state from SQLite. Continue working after this read.",
    input: z.object({ taskId: taskIdField.optional() }),
  },
  slp_get_report: {
    roles: SLP_ROLES,
    description: "Read a task's implementation and acceptance reports, or project reports for run-level callers. Continue after this read.",
    input: z.object({ taskId: taskIdField.optional() }),
  },
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
      "Store Master Spec content and create tasks in SQLite. Choose implementerRole, verifiers, reviewerPermissions and documentedBy from project role IDs. Writable scopes must not overlap; create no spec files.",
    input: z.object({
      masterSpec: z.string().trim().min(1).describe("The actual Master Spec text, including architecture and shared contracts; not a file path"),
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
    // Task reports are linked by task ID in SQLite, so the Lead never assembles file paths.
    input: z.object({ summary: z.string().trim().min(1) }),
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
    description: "Submit the complete structured acceptance report to SQLite. This replaces writing an acceptance document.",
    input: z.object({ report: AcceptanceReportSchema }),
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
    roles: ["implementer", "qa", "security", "peer"],
    description: "Read-only question to the Implementer of another task about its current code.",
    input: z.object({ taskId: taskIdField, question: z.string().min(1) }),
  },
  slp_answer: {
    roles: ["implementer", "qa", "security", "peer"],
    description: "Answer a question that was sent to you.",
    input: z.object({ questionId: z.string().min(1), answer: z.string().min(1) }),
  },
  slp_escalate: {
    roles: ["implementer", "qa", "security", "peer"],
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
