// Top-level messages deliver runtime events; role behavior and workflow rules come from .slp/*.md.
import type { BoardTicket, TicketMockup } from "../../shared/board";
// A Run started from a prepared ticket hands the Supervisor that feature directly instead of waiting for a new requirement.
function startingTicketSection(ticket: BoardTicket): string {
  const mockupLine = ticket.mockup
    ? `- **Approved Mockup**: \`${ticket.mockup.file}\`${ticket.mockup.approvedCommit ? ` at commit \`${ticket.mockup.approvedCommit}\`` : ""}`
    : "- **Approved Mockup**: none (this feature has no UI mockup)";
  return [
    `### Your Starting Ticket: \`${ticket.ticketKey}\` — ${ticket.title}`,
    "The human prepared this feature with the Product Agent and started this Run from it.",
    mockupLine,
    `Read it with \`slp_board_get_ticket({ ticketId: "${ticket.ticketKey}" })\`, confirm with the human only if something is genuinely unclear, then call \`slp_delegate\`. The Spec and mockup are already decided, so do not redraft them.`,
  ].join("\n");
}

export function supervisorBriefing(startingTicket?: BoardTicket | null): string {
  return [
    startingTicket
      ? "You are the Supervisor of an SLP run, working according to your configured .slp/SUPERVISOR.md workflow."
      : "You are the Supervisor of an SLP run. Greet the human briefly and wait for their requirement according to your configured .slp/SUPERVISOR.md workflow. Do not delegate until requirements are clear.",
    "KANBAN SPEC BOARD RULE: Whenever you draft or revise a Product Spec, you MUST call `slp_board_save_spec({ title, acceptanceCriteria, spec, summary })` so the Spec is saved on the project's Kanban board (e.g. `SLP-1`) with Git-style diff history instead of only pasting the Spec in chat. Tell the human the ticket key (`SLP-X`) so they can review it before you call `slp_delegate`. Mockups are prepared with the Product Agent before a Run starts, so you do not create or review them. If a Spec is edited after delegation, the engine notifies you; call `slp_board_notify_lead` so the Lead can pause its peers and update its Brief from the Spec diff.",
    startingTicket ? startingTicketSection(startingTicket) : "",
  ].filter(Boolean).join("\n\n");
}

export interface SiblingLeadSummary {
  agentId: string;
  featureName: string;
  worktreePath: string | null;
  branch: string | null;
  acceptanceCriteria: string;
  // Only the QA Lead's roster carries specs; sibling Leads get criteria alone to keep their briefings short.
  productSpec?: string | null;
}

export interface DelegatedLeadContext {
  leadAgentId?: string;
  featureName?: string;
  featureCriteria?: string;
  productSpec?: string;
  approvedMockup?: Pick<TicketMockup, "file" | "approvedCommit"> | null;
  worktreePath?: string;
  branch?: string;
  sharedContext?: string | null;
  siblingLeads?: ReadonlyArray<SiblingLeadSummary>;
  // Absent only for runs created before QA Leads existed.
  qaLead?: { agentId: string; worktreePath: string; branch: string };
}

export function delegationMessage(acceptanceCriteria: string, context?: DelegatedLeadContext): string {
  // Each Lead runs inside its assigned checkout, which is a feature worktree only when the run keeps worktrees on.
  const effectiveCriteria = context?.featureCriteria ?? acceptanceCriteria;
  const messageSections = [
    "The Supervisor delegated this feature to you as Lead.",
    context?.featureName
      ? `### Your Assigned Feature: ${context.featureName}\n- **Lead Agent ID**: \`${context.leadAgentId ?? "self"}\`\n- **Assigned Checkout**: \`${context.worktreePath ?? "assigned"}\`${context.branch ? ` (branch \`${context.branch}\`)` : ""}`
      : context?.worktreePath
        ? `### Your Assigned Checkout\n- **Checkout**: \`${context.worktreePath}\`${context.branch ? ` (branch \`${context.branch}\`)` : ""}`
        : "",
    `### Acceptance Criteria\n${effectiveCriteria}`,
    // The human approved this spec, so screens and interactions are a contract rather than a suggestion.
    context?.productSpec
      ? `### Human-Approved Product Spec (screens, states, interactions)\n${context.productSpec}\n\nImplement exactly these screens, states and Given/When/Then behaviors; the QA Lead verifies each scenario. You own the technical spec (contracts, data, architecture). If a scenario cannot be built as written, record the deviation and its reason in your slp_finalize_pipeline summary instead of silently changing it.`
      : "",
    // The approved mockup is the UI contract, so the Spec deliberately does not repeat what it shows.
    context?.approvedMockup
      ? `### Human-Approved Mockup (UI source of truth)\n\`${context.approvedMockup.file}\`${context.approvedMockup.approvedCommit ? ` at commit \`${context.approvedMockup.approvedCommit}\`` : ""}, with shared style and logic in \`.slp/mockup/core/\`. Match its screens, states and interactions, and name this file in the developer's task. Do not edit it.`
      : "",
    context?.sharedContext ? `### Shared Cross-Feature Context\n${context.sharedContext}` : "",
  ].filter(Boolean);

  if (context?.siblingLeads && context.siblingLeads.length > 0) {
    const siblingLines = context.siblingLeads.map(
      (siblingLead) =>
        `- **Feature \`${siblingLead.featureName}\`** — Lead \`${siblingLead.agentId}\` (worktree \`${siblingLead.worktreePath ?? "n/a"}\`, branch \`${siblingLead.branch ?? "n/a"}\`):\n  Criteria: ${siblingLead.acceptanceCriteria}`,
    );
    messageSections.push(
      [
        "### Parallel Sibling Leads & Concurrent Features (Coordinate via `slp_ask`)",
        "The following features are being implemented in parallel with yours by sibling Leads:",
        ...siblingLines,
        "Whenever your implementation shares APIs, schemas, data contracts, routes, or end-to-end flows with a sibling feature, contact that sibling Lead directly using `slp_ask({ toAgentId: \"<siblingLeadId>\", question: \"...\" })` so your implementations align before integration.",
      ].join("\n"),
    );
  }

  if (context?.qaLead) {
    // Naming the merge target and its owner up front stops Leads from running heavy verification themselves.
    messageSections.push(
      [
        "### QA Lead & Merge Target",
        `- **QA Lead**: \`${context.qaLead.agentId}\` prepares verification of the merged build now and reports the verified result to the Supervisor.`,
        `- **Merge target**: slp_finalize_pipeline merges your branch into the QA branch \`${context.qaLead.branch}\` (\`${context.qaLead.worktreePath}\`). Resolve any conflict there before the QA Lead starts.`,
        "- Put every heavy verification you could not run into your slp_finalize_pipeline summary; the QA Lead schedules it.",
      ].join("\n"),
    );
  }

  messageSections.push(
    // Remind Leads in pre-existing projects of the Kanban brief and peer-pause tools without overriding their .slp/LEAD.md workflow.
    "Follow your configured .slp/LEAD.md workflow and available .slp peer roles to define your pipeline stages with slp_define_pipeline. Every stage peer will run in your assigned checkout and fork directly from your session. When implementation/merge conflicts or a Supervisor Spec diff notification (slp_board_notify_lead) requires revising your Brief, call slp_pause_peers to pause active stage peers, call slp_board_update_brief to update the Brief bullets with a clear reason, and call slp_resume_peers to resume your peers on the updated Brief. Once defined, end your turn.",
  );
  return messageSections.join("\n\n");
}

export function reportForSupervisor(summary: string, baseBranch: string, integrationBranch: string): string {
  // Calling slp_present_to_manager automatically merges integrationBranch into baseBranch when the base checkout is clean.
  return `The Lead reports the verified result on ${integrationBranch}:\n${summary}\nRead slp_list_pipelines and slp_get_pipeline, inspect git diff ${baseBranch}...${integrationBranch}, and independently verify the acceptance criteria and every scenario of the human-approved product spec (slp_get_run productSpec) against the QA Lead's per-scenario results. If satisfied call slp_present_to_manager (which automatically merges ${integrationBranch} into ${baseBranch} and completes the run); otherwise call slp_request_rework.`;
}

export function reworkNotice(feedback: string): string {
  // Closed stage cohorts stay immutable; further work is represented by a fresh pipeline and worktree.
  return `The Supervisor requested rework:\n${feedback}\nInspect the current integration and stage evidence. Create a new pipeline containing the stages and peer roles required to address this feedback. Integrate its accepted result, verify the combined behavior, and call slp_report again.`;
}

const TOP_LEVEL_NUDGE_GUIDANCE: Readonly<Record<string, string>> = {
  slp_define_pipeline: "Inspect slp_get_run, then call slp_define_pipeline; it attaches the pipeline to its checkout for you.",
  slp_resume_pipeline: "Inspect slp_get_pipeline for the paused pipeline and call slp_resume_pipeline with your recovery decision.",
  slp_finalize_pipeline: "Inspect slp_get_pipeline for the completed pipeline, verify its checkout (resolving any conflicts by consulting Peers or sibling Forked Leads via slp_ask), and call slp_finalize_pipeline.",
  slp_report: "Inspect slp_list_pipelines, verify the integrated branch, and call slp_report to hand the result to the Supervisor.",
  slp_present_to_manager: "Inspect slp_list_pipelines, slp_get_pipeline and git diff, then call slp_present_to_manager if accepted or slp_request_rework if changes are needed.",
};

export function nudgeReminder(toolName: string): string {
  // Supervisor and Master Lead obligations do not use stage-level peer tools such as slp_escalate or slp_ask.
  const topLevelGuidance = TOP_LEVEL_NUDGE_GUIDANCE[toolName];
  if (topLevelGuidance) {
    return `[SLP Orchestrator] You ended your turn without the expected workflow tool ${toolName}. ${topLevelGuidance}`;
  }
  return `You ended your turn without the expected workflow tool ${toolName}. Read your current assignment, complete the required evidence or decision, and call ${toolName}. If blocked, use slp_escalate; use slp_ask when you need a direct answer from another agent.`;
}
