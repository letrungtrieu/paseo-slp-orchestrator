// Top-level messages deliver runtime events; role behavior and workflow rules come from .slp/*.md.
export function supervisorBriefing(): string {
  return "You are the Supervisor of an SLP run. Greet the human briefly and wait for their requirement according to your configured .slp/SUPERVISOR.md workflow. Do not delegate until requirements are clear.";
}

export interface SiblingLeadSummary {
  agentId: string;
  featureName: string;
  worktreePath: string | null;
  branch: string | null;
  acceptanceCriteria: string;
}

export interface DelegatedLeadContext {
  leadAgentId?: string;
  featureName?: string;
  featureCriteria?: string;
  worktreePath?: string;
  branch?: string;
  sharedContext?: string | null;
  siblingLeads?: ReadonlyArray<SiblingLeadSummary>;
}

export function delegationMessage(acceptanceCriteria: string, context?: DelegatedLeadContext): string {
  // Each Lead runs inside its dedicated feature worktree and receives the full roster of sibling Leads running in parallel.
  const effectiveCriteria = context?.featureCriteria ?? acceptanceCriteria;
  const messageSections = [
    "The Supervisor delegated this feature to you as Lead.",
    context?.featureName
      ? `### Your Assigned Feature: ${context.featureName}\n- **Lead Agent ID**: \`${context.leadAgentId ?? "self"}\`\n- **Dedicated Worktree**: \`${context.worktreePath ?? "assigned"}\`${context.branch ? ` (branch \`${context.branch}\`)` : ""}`
      : context?.worktreePath
        ? `### Your Dedicated Worktree\n- **Worktree**: \`${context.worktreePath}\`${context.branch ? ` (branch \`${context.branch}\`)` : ""}`
        : "",
    `### Acceptance Criteria\n${effectiveCriteria}`,
    context?.sharedContext ? `### Shared Cross-Feature Context\n${context.sharedContext}` : "",
  ].filter(Boolean);

  if (context?.siblingLeads && context.siblingLeads.length > 0) {
    const siblingLines = context.siblingLeads.map(
      (siblingLead) =>
        `- **Feature \`${siblingLead.featureName}\`** — Lead \`${siblingLead.agentId}\` (worktree \`${siblingLead.worktreePath ?? "n/a"}\`, branch \`${siblingLead.branch ?? "n/a"}\`):\n  Criteria: ${siblingLead.acceptanceCriteria}`,
    );
    messageSections.push(
      [
        "### Parallel Sibling Leads & Concurrent Features (Coordinate via `slp_send_peer_message`)",
        "The following features are being implemented in parallel with yours by sibling Leads:",
        ...siblingLines,
        "Whenever your implementation shares APIs, schemas, data contracts, routes, or end-to-end flows with a sibling feature, contact that sibling Lead directly using `slp_send_peer_message({ toAgentId: \"<siblingLeadId>\", message: \"...\", waitForReply: true })` so your implementations align before integration.",
      ].join("\n"),
    );
  }

  messageSections.push(
    "Follow your configured .slp/LEAD.md workflow and available .slp peer roles to define your pipeline stages with slp_define_pipeline. Every stage peer will run in your worktree and fork directly from your session. Once defined, end your turn.",
  );
  return messageSections.join("\n\n");
}

export function reportForSupervisor(summary: string, baseBranch: string, integrationBranch: string): string {
  // Calling slp_present_to_manager automatically merges integrationBranch into baseBranch when the base checkout is clean.
  return `The Lead reports the defined pipelines integrated into ${integrationBranch}:\n${summary}\nRead slp_list_pipelines and slp_get_pipeline, inspect git diff ${baseBranch}...${integrationBranch}, and independently verify acceptance criteria. If satisfied call slp_present_to_manager (which automatically merges ${integrationBranch} into ${baseBranch} and completes the run); otherwise call slp_request_rework.`;
}

export function reworkNotice(feedback: string): string {
  // Closed stage cohorts stay immutable; further work is represented by a fresh pipeline and worktree.
  return `The Supervisor requested rework:\n${feedback}\nInspect the current integration and stage evidence. Create a new pipeline containing the stages and peer roles required to address this feedback. Integrate its accepted result, verify the combined behavior, and call slp_report again.`;
}

const TOP_LEVEL_NUDGE_GUIDANCE: Readonly<Record<string, string>> = {
  slp_define_pipeline: "Inspect slp_get_run, create a pipeline worktree with slp_create_worktree if needed, and call slp_define_pipeline.",
  slp_resume_pipeline: "Inspect slp_get_pipeline for the paused pipeline and call slp_resume_pipeline with your recovery decision.",
  slp_finalize_pipeline: "Inspect slp_get_pipeline for the completed pipeline, verify its worktree (resolving any conflicts by consulting Peers or sibling Forked Leads via slp_send_peer_message), and call slp_finalize_pipeline.",
  slp_report: "Inspect slp_list_pipelines, verify the integrated branch (or spawn a final End-User UAT pipeline with slp_create_worktree + slp_define_pipeline if needed), and call slp_report to hand the result to the Supervisor.",
  slp_present_to_manager: "Inspect slp_list_pipelines, slp_get_pipeline and git diff, then call slp_present_to_manager if accepted or slp_request_rework if changes are needed.",
};

export function nudgeReminder(toolName: string): string {
  // Supervisor and Master Lead obligations do not use stage-level peer tools such as slp_escalate or waitForReply.
  const topLevelGuidance = TOP_LEVEL_NUDGE_GUIDANCE[toolName];
  if (topLevelGuidance) {
    return `[SLP Orchestrator] You ended your turn without the expected workflow tool ${toolName}. ${topLevelGuidance}`;
  }
  return `You ended your turn without the expected workflow tool ${toolName}. Read your current assignment, complete the required evidence or decision, and call ${toolName}. If blocked, use slp_escalate; use waitForReply when intentionally waiting for a direct response.`;
}
