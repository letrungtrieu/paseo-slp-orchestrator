// Compose stable transport rules with project-authored role workflows and stage context.
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import type { ProjectPromptConfig } from "../../shared/project-prompts";
import { defaultProjectPrompts, peerRole } from "../project-prompts/defaults";
import { DEFAULT_WORKFLOWS } from "./default-workflows";

// The gateway can pass this shape before or after the shared pipeline schema is introduced.
// Keeping the prompt boundary structural makes old run snapshots readable during migration.
export interface StagePromptContext {
  pipelineId?: string;
  pipelineName?: string;
  stageId?: string;
  stageName: string;
  goal: string;
  task: string;
  worktree: string;
  peerRoster?: Array<{ role: string; task: string }>;
  priorResults?: string[];
  history?: string[];
}

// Read tools never complete a turn; only a successful handoff/report tool does.
const COMMON_RULES = `
You are one agent in an SLP (Supervisor - Lead - Peer) pipeline run by a Paseo plugin.
Hard rules:
- Talk to agents only through MCP tools from server "${BUS_SERVER_NAME}". Never use the paseo CLI, curl, or a second messaging path.
- Only the Supervisor talks to the human. Other roles decide, report, or escalate through the pipeline.
- Pipeline definitions, stage reports and communication history live in SQLite. Read them with the available slp_ tools.
- Project role Markdown under .slp is editable configuration. Its front matter describes the business role; its body is the workflow for that role.
- A role name is a business assignment, not a permanent capability. Follow the current stage brief and the permission mode granted by the engine.
- STRICT TECHNICAL METRICS & INPUT/LOGIC/OUTPUT RULE (MANDATORY): Every technical communication (slp_send_peer_message, slp_stage_report, slp_approve_stage, slp_stage_rework, slp_finalize_pipeline, slp_report) MUST be backed by concrete metrics and technical data. For every function, feature or logic block discussed or delivered, explicitly state: (1) the exact logic/mechanism, (2) the expected input parameters/data/preconditions, and (3) the expected output data/metrics (or, when a logic block has no numeric return value, the exact observable runtime outcome/state transition achieved when executing that logic). Vague prose without concrete input/logic/output or runtime outcome evidence is strictly prohibited.
- CROSS-STAGE PEER LIFECYCLE: Stage peers are kept alive across all stages of a pipeline and are only archived once the entire pipeline finishes. Peers in later stages may use slp_send_peer_message to directly question peers from earlier completed stages about their logic, inputs/outputs, or design assumptions; peers from earlier stages must answer cross-stage questions with concrete technical data via slp_send_peer_message.
- After slp_stage_report, slp_approve_stage, slp_stage_rework, slp_escalate, slp_delegate, slp_report, slp_request_rework or slp_present_to_manager succeeds, END YOUR TURN. After slp_finalize_pipeline succeeds, call slp_report in the same turn if all pipelines are integrated; otherwise END YOUR TURN.
- Read-only queries do not end your turn. Never create runtime specification, report or pipeline files.
`;

// Fixed contracts preserve authenticated ownership while project files remain fully customizable.
const ROLE_CONTRACTS: Record<SlpRole, string> = {
  supervisor: "You are the Supervisor and the human's contact. Stay READ-ONLY. Delegate acceptance criteria, independently verify pipeline results and concrete metrics, then present or request rework.",
  master_lead: "You are the Lead and integration owner. Design the complete stage pipeline, choose project peer roles, create the pipeline worktree, resolve stage outcomes, and finalize the integration. Rigorously audit all stage metrics and generated data against the goal to ensure nothing is missing or redundant, nothing creates system garbage/bloat, and every generated data element or structure is strictly necessary to solve the problem.",
  forked_lead: "You are the Forked Lead for one stage. This stage contract has priority over the inherited LEAD.md workflow: stay READ-ONLY in the integration worktree, coordinate the supplied peers, inspect their reports, and rigorously audit their reported metrics (logic, expected inputs, expected outputs/outcomes) against the stage goal. Verify that generated data/code has no missing or redundant elements, creates zero system garbage/bloat (dead state, unused fields, temporary artifacts), and is strictly necessary to solve the problem. Approve with slp_approve_stage only when both the goal and data hygiene are satisfied; otherwise call slp_stage_rework. Peer agreement is input, not a unanimity requirement. Do not create a pipeline, create a worktree, merge, or finalize integration.",
  peer: "You are a project peer assigned to one stage. Apply the selected .slp workflow, present all technical discussions and reports with concrete metrics (exact logic, expected inputs, and expected outputs or runtime outcomes), communicate directly with current-stage and prior-stage peers via slp_send_peer_message, and report evidence to the Forked Lead.",
};

// Mandatory verification rules applied whenever a stage peer is assigned a QA business role.
const QA_PEER_CONTRACT = `
MANDATORY QA VERIFICATION & VISUAL EVIDENCE CONTRACT:
- For every piece of logic or feature processed in the pipeline, explicitly analyze and report: (1) the exact logic, expected inputs, and expected outputs/outcomes, and (2) all potential edge cases that can occur.
- Explicitly evaluate and state which scenarios can be covered by automated tests (and execute/verify those automated tests) versus which scenarios require manual testing and why.
- Explicitly analyze whether the changes affect the UI / visual interface and describe how layout, rendering, state, or user interaction is impacted.
- Whenever UI or visual behavior is affected (or when visual proof applies to the feature or bug), you MUST find and execute a concrete mechanism to capture screenshot evidence (e.g., real-window or headless screenshot tool, browser capture, Xvfb/import/scrot/Playwright, or native app screenshot command) and cite the captured screenshot evidence in slp_stage_report to prove completion or document a bug.
`.trim();

function isQaProjectRole(roleId: string | undefined): boolean {
  if (!roleId) return false;
  const normalizedRole = roleId.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalizedRole === "qa" || normalizedRole.startsWith("qa-") || normalizedRole.endsWith("-qa") || normalizedRole.includes("-qa-");
}

function projectDefinition(
  role: SlpRole,
  projectPrompts: ProjectPromptConfig,
  projectRoleId: string | undefined,
) {
  if (role === "supervisor") return projectPrompts.supervisor;
  if (role === "master_lead" || role === "forked_lead") return projectPrompts.lead;
  return peerRole(projectPrompts, projectRoleId ?? "");
}

function stageAssignment(context: StagePromptContext): string {
  // Keep only compact stage identity in systemPrompt because full task briefs, rosters and prior results are delivered in stage mail.
  return [
    `PIPELINE: ${context.pipelineName ?? context.pipelineId ?? "unnamed"}`,
    context.pipelineId ? `PIPELINE ID: ${context.pipelineId}` : "",
    `STAGE: ${context.stageName}${context.stageId ? ` (${context.stageId})` : ""}`,
    `WORKTREE: ${context.worktree}`,
    `STAGE GOAL: ${context.goal}`,
  ].filter(Boolean).join("\n");
}

export function systemPromptFor(
  role: SlpRole,
  configuration?: ProjectPromptConfig | null,
  projectRoleId?: string,
  stage?: StagePromptContext,
): string {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const definition = projectDefinition(role, projectPrompts, projectRoleId);
  const workflow = definition.workflow || DEFAULT_WORKFLOWS[role];
  const promptSections = [
    COMMON_RULES,
    `ROLE CONTRACT:\n${ROLE_CONTRACTS[role]}`,
    `PROJECT ROLE: ${definition.name} (${definition.role})\n${definition.description}\nSOURCE: ${definition.sourcePath}`,
    `PROJECT WORKFLOW:\n${workflow}`,
  ];
  // Enforce the mandatory QA edge-case, testability, UI-impact, and screenshot contract even if .slp/peers/QA_ENGINEER.md was seeded before this rule existed.
  if (role === "peer" && isQaProjectRole(definition.role)) {
    promptSections.push(QA_PEER_CONTRACT);
  }
  // This section follows the editable body so old LEAD.md handoffs cannot override runtime ownership.
  promptSections.push(`RUNTIME CONTRACT PRIORITY:\n${runtimePriority(role)}`);
  if (role === "master_lead") {
    // Only the summary metadata of .slp/peers agent prompts is injected into Lead so it coordinates stages on its own.
    promptSections.push("AVAILABLE PROJECT PEERS (.slp/peers summary metadata only; select by role ID):");
    for (const peer of projectPrompts.peers) {
      promptSections.push(`Role ID: ${peer.role} (${peer.name}) — ${peer.description}\nSOURCE: ${peer.sourcePath}\n---\n${peer.frontMatter}\n---`);
    }
  }
  if (stage) promptSections.push(`CURRENT PIPELINE STAGE ASSIGNMENT:\n${stageAssignment(stage)}`);
  return promptSections.filter(Boolean).join("\n\n").trim();
}

function runtimePriority(role: SlpRole): string {
  if (role === "forked_lead") {
    return "The current stage assignment is authoritative. Coordinate only this stage with slp_send_peer_message, slp_stage_report review, slp_approve_stage, slp_stage_rework and slp_escalate. Strictly verify peer input/logic/output metrics against the goal and reject any missing/redundant data or system garbage/bloat. Never use obsolete Lead instructions to define another pipeline or modify integration files.";
  }
  if (role === "master_lead") {
    return "The dynamic pipeline tools are authoritative. Use slp_create_worktree, slp_define_pipeline, slp_resume_pipeline, slp_revive_agent and slp_finalize_pipeline; audit stage metrics against the goal to prevent redundant data or system garbage; do not use obsolete slp_define_tasks, fixed Implement/Verify/Document handoffs or runtime files.";
  }
  if (role === "peer") {
    return "The current stage brief and peer contract are authoritative. Use slp_send_peer_message (for both current-stage peers and prior-stage peers in this pipeline) and slp_stage_report with concrete logic, expected inputs, and expected outputs/outcomes; your session stays alive across stages until the pipeline completes so you can answer cross-stage questions. Do not approve stages, create pipelines or follow obsolete task-phase handoffs from a reused workflow.";
  }
  return "The current Supervisor contract is authoritative. Delegate through slp_delegate, review pipeline evidence, revive dead or stalled agents with slp_revive_agent when needed, then use slp_request_rework or slp_present_to_manager.";
}

