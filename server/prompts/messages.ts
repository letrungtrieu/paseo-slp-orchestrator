// Top-level messages describe responsibilities; stage order and peer assignments come from the Lead's JSON.
export function supervisorBriefing(): string {
  return "You are the Supervisor of an SLP run. Greet the human in Vietnamese in one sentence and wait for their requirement. Do not delegate until requirements are clear.";
}

export function delegationMessage(acceptanceCriteria: string): string {
  // The Lead creates worktrees explicitly and passes their actual returned paths into pipeline definitions.
  return `The Supervisor delegated this project.\nAcceptance criteria:\n${acceptanceCriteria}\nSurvey the project and available .slp peer roles. Design the stage sequence needed for each work package. Use slp_create_worktree, then call slp_define_pipeline with {pipeline:{name,version,worktree,description,stages:[{name,goal,peers:[{role,task}]}]}}. Use any stage names and project roles the work needs. Peers in a stage are equal participants; its Forked Lead decides completion. Define further independent pipelines if useful, then end your turn. Store all plans and reports through tools, without runtime files.`;
}

export function reportForSupervisor(summary: string, baseBranch: string, integrationBranch: string): string {
  // The Supervisor verifies evidence from every integrated pipeline before offering the final human approval.
  return `The Lead reports the defined pipelines integrated into ${integrationBranch}:\n${summary}\nRead slp_list_pipelines and slp_get_pipeline, inspect git diff ${baseBranch}...${integrationBranch}, and independently verify acceptance criteria. If satisfied call slp_present_to_manager; otherwise slp_request_rework. Only the human approves merging into ${baseBranch}.`;
}

export function reworkNotice(feedback: string): string {
  // Closed stage cohorts stay immutable; further work is represented by a fresh pipeline and worktree.
  return `The Supervisor requested rework:\n${feedback}\nInspect the current integration and stage evidence. Create a new pipeline containing the stages and peer roles required to address this feedback. Integrate its accepted result, verify the combined behavior, and call slp_report again.`;
}

export function nudgeReminder(toolName: string): string {
  return `You ended your turn without the expected workflow tool ${toolName}. Read your current assignment, complete the required evidence or decision, and call ${toolName}. If blocked, use slp_escalate; use waitForReply when intentionally waiting for a direct response.`;
}
