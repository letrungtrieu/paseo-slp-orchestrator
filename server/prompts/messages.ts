// Top-level messages describe responsibilities; stage order and peer assignments come from the Lead's JSON.
export function supervisorBriefing(): string {
  return "You are the Supervisor of an SLP run. Greet the human in Vietnamese in one sentence and wait for their requirement. Do not delegate until requirements are clear.";
}

export function delegationMessage(acceptanceCriteria: string): string {
  // The Master Lead decomposes the spec into one or more parallel task pipelines; each pipeline forks a dedicated Forked Lead.
  return `The Supervisor delegated this project.\nAcceptance criteria:\n${acceptanceCriteria}\nSurvey the project and available .slp peer roles. Decompose the specification into independent parallel tasks/workstreams whenever possible. Call slp_define_pipeline with {pipelines:[{name,version,worktree?,description,stages:[{name,goal,peers:[{role,task}]}]}]} (or call slp_create_worktree + slp_define_pipeline for each task; if 'worktree' is omitted, an isolated worktree is created automatically). Each defined pipeline forks you into a dedicated Forked Lead that coordinates its assigned task's stages in parallel, resolves conflicts, and merges its branch into integration. Once defined, end your turn. Store all plans and reports through tools, without runtime files.`;
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
