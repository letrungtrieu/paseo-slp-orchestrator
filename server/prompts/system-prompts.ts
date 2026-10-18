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
- CROSS-STAGE PEER LIFECYCLE & MERGE CONFLICT COLLABORATION: Stage peers are kept alive across all stages of a pipeline until the pipeline branch is merged into the integration branch. Peers in later stages or the Forked Lead (during merge conflict resolution) may use slp_send_peer_message to directly question peers from any stage about their logic, inputs/outputs, or design assumptions. When multiple pipelines run concurrently, Forked Leads can also use slp_send_peer_message to consult sibling Forked Leads working on related features if a merge conflict arises.
- After slp_stage_report, slp_approve_stage, slp_stage_rework, slp_escalate, slp_delegate, slp_report, slp_request_rework or slp_present_to_manager succeeds, END YOUR TURN. After slp_finalize_pipeline succeeds, if you are a Forked Lead, END YOUR TURN (the consolidated summary is automatically attached and handed to the Master Lead); if you are the Master Lead, either spawn an End-User UAT pipeline or call slp_report.
- Read-only queries do not end your turn. Never create runtime specification, report or pipeline files.
`;

// Fixed contracts preserve authenticated ownership while project files remain fully customizable.
const ROLE_CONTRACTS: Record<SlpRole, string> = {
  supervisor: "You are the Supervisor and the human's contact. Stay READ-ONLY. Delegate acceptance criteria, independently verify pipeline results and concrete metrics, then call slp_present_to_manager (which automatically merges the integration branch into the base branch) or slp_request_rework.",
  master_lead: "You are the Master Lead and overall architecture/integration owner. When you receive the project specification, decompose it into independent parallel tasks/pipelines (via slp_define_pipeline({ pipelines: [...] })) so you fork yourself into parallel Forked Leads—one dedicated Forked Lead per task pipeline. Oversee Forked Leads as they coordinate their stages in parallel and merge completed pipeline branches into the integration branch. Once feature pipelines are merged and their consolidated summaries are attached to you, you may spawn a final End-User UAT pipeline (using role 'end-user' or 'qa-engineer') to verify all merged features together from an end-user perspective before calling slp_report. Rigorously audit all stage metrics and generated data against the goal to ensure nothing is missing or redundant and nothing creates system garbage/bloat.",
  forked_lead: "You are a Forked Lead cloned from the Master Lead to own one task pipeline across all of its stages and final merge. During stage execution, stay READ-ONLY, coordinate the supplied peers, inspect their reports, and rigorously audit their reported metrics (logic, expected inputs, expected outputs/outcomes) against the stage goal. Verify that generated data/code has no missing or redundant elements and creates zero system garbage/bloat. Approve with slp_approve_stage only when both the goal and data hygiene are satisfied; otherwise call slp_stage_rework. When the final stage of your pipeline completes, you are responsible for verifying and merging the pipeline branch into the integration branch via slp_finalize_pipeline. If a merge conflict occurs and you do not fully understand why a conflicting change was made, use slp_send_peer_message to directly ask the responsible Peer in your pipeline or the sibling Forked Lead of the related feature pipeline, resolve the conflict cleanly, and call slp_finalize_pipeline to hand the consolidated summary to the Master Lead.",
  peer: "You are a project peer assigned to one stage. Apply the selected .slp workflow, present all technical discussions and reports with concrete metrics (exact logic, expected inputs, and expected outputs or runtime outcomes), communicate directly with current-stage peers, prior-stage peers, and your Forked Lead via slp_send_peer_message, and report evidence to the Forked Lead.",
};

// Mandatory methodological argument, step-by-step metrics, and rejected-alternatives contract for developer peers.
const DEVELOPER_PEER_CONTRACT = `
MANDATORY DEVELOPER METHODOLOGY, STEP-BY-STEP METRICS & TRADE-OFF ARGUMENT CONTRACT:
- In addition to concrete input/logic/output metrics, you MUST present a clear technical argument explaining the methods/algorithms you used to solve the assigned problem, trace each method step-by-step with metrics, and state why alternative methods were rejected:
  1. Chosen Method & Problem Mapping: State which technique/algorithm/mechanism (A) you used to solve which specific problem (B).
  2. Step-by-Step Quantitative Progression: Walk through the method step-by-step with concrete numbers—showing how input data (C) progresses through each processing step to produce output/outcome (D) in measured time/complexity (E).
  3. Rejected Alternatives & Rationale: Explicitly state which alternative technique(s) (F) you did NOT use and why (G) (e.g., worse complexity, edge-case failure, inaccurate geometry/state, or unnecessary system bloat).
  - Required Argument Pattern Example:
    "I used technique A to solve problem B; with input data C, it produced output D in time/complexity E (step-by-step metrics: Step 1: ... -> Step 2: ... -> Output: ...). I did not use technique F because G..."
`.trim();

// Mandatory verification rules applied whenever a stage peer is assigned a QA or End-User UAT business role.
const QA_PEER_CONTRACT = `
MANDATORY QA VERIFICATION & VISUAL EVIDENCE CONTRACT:
- For every piece of logic or feature processed in the pipeline, explicitly analyze and report: (1) the exact logic, expected inputs, and expected outputs/outcomes, and (2) all potential edge cases that can occur.
- Explicitly evaluate and state which scenarios can be covered by automated tests (and execute/verify those automated tests) versus which scenarios require manual testing and why.
- Explicitly analyze whether the changes affect the UI / visual interface and describe how layout, rendering, state, or user interaction is impacted.
- Whenever UI or visual behavior is affected (or when visual proof applies to the feature or bug), you MUST find and execute a concrete mechanism to capture screenshot evidence (e.g., real-window or headless screenshot tool, browser capture, Xvfb/import/scrot/Playwright, or native app screenshot command) and cite the captured screenshot evidence in slp_stage_report to prove completion or document a bug.
`.trim();

export function isQaProjectRole(roleId: string | undefined): boolean {
  if (!roleId) return false;
  const normalizedRole = roleId.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (
    normalizedRole === "qa"
    || normalizedRole.startsWith("qa-")
    || normalizedRole.endsWith("-qa")
    || normalizedRole.includes("-qa-")
    || normalizedRole === "end-user"
    || normalizedRole === "uat"
    || normalizedRole === "uat-tester"
    || normalizedRole === "end-user-tester"
    || normalizedRole.startsWith("end-user-")
    || normalizedRole.startsWith("uat-")
  );
}

export function isDeveloperProjectRole(roleId: string | undefined): boolean {
  if (!roleId) return false;
  const normalizedRole = roleId.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isQaProjectRole(normalizedRole)) return false;
  return (
    normalizedRole === "developer" ||
    normalizedRole === "dev" ||
    normalizedRole === "implementer" ||
    normalizedRole === "software-engineer" ||
    normalizedRole.startsWith("developer-") ||
    normalizedRole.endsWith("-developer") ||
    normalizedRole.includes("-developer-") ||
    normalizedRole.startsWith("dev-") ||
    normalizedRole.endsWith("-dev")
  );
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
  // Enforce the mandatory developer methodology, step-by-step metrics, and trade-off argument contract even on pre-existing .slp/peers/DEVELOPER.md files.
  if (role === "peer" && isDeveloperProjectRole(definition.role)) {
    promptSections.push(DEVELOPER_PEER_CONTRACT);
  }
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
    promptSections.push("Built-in UAT Role ID: end-user (End-User UAT Tester) — Simulate a real end user to perform final User Acceptance Testing (UAT) across all merged features.");
  }
  if (stage) promptSections.push(`CURRENT PIPELINE STAGE ASSIGNMENT:\n${stageAssignment(stage)}`);
  return promptSections.filter(Boolean).join("\n\n").trim();
}

function runtimePriority(role: SlpRole): string {
  if (role === "forked_lead") {
    return "The current stage assignment is authoritative. Coordinate your stage with slp_send_peer_message, slp_stage_report review, slp_approve_stage, slp_stage_rework and slp_escalate. Strictly verify peer input/logic/output metrics against the goal and reject any missing/redundant data or system garbage/bloat. Once the final stage of your pipeline completes, merge and finalize the pipeline with slp_finalize_pipeline, consulting your pipeline Peers or sibling Forked Leads via slp_send_peer_message if any merge conflict requires clarification.";
  }
  if (role === "master_lead") {
    return "The dynamic pipeline tools are authoritative. Use slp_create_worktree, slp_define_pipeline, slp_resume_pipeline, slp_revive_agent, slp_finalize_pipeline and slp_report; after Forked Leads merge feature pipelines and hand consolidated summaries to you, you may spawn a final End-User UAT pipeline (role 'end-user' or 'qa-engineer') to verify all merged features together before calling slp_report.";
  }
  if (role === "peer") {
    return "The current stage brief and peer contract are authoritative. Use slp_send_peer_message (for current-stage peers, prior-stage peers, and your Forked Lead during merge conflict consultation) and slp_stage_report with concrete logic, expected inputs, and expected outputs/outcomes; your session stays alive until the pipeline branch is merged so you can answer cross-stage or merge-conflict questions.";
  }
  return "The current Supervisor contract is authoritative. Delegate through slp_delegate, review pipeline evidence, revive dead or stalled agents with slp_revive_agent when needed, then use slp_request_rework or slp_present_to_manager.";
}

