// Compose protocol, project workflow and role discovery without mixing peer workflows into the Lead's context.
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import type { ProjectPromptConfig } from "../../shared/project-prompts";
import { defaultProjectPrompts, peerRole } from "../project-prompts/defaults";
import { DEFAULT_WORKFLOWS } from "./default-workflows";

// Loading context must not end a worker's turn before it submits the result the pipeline is awaiting.
const COMMON_RULES = `
You are one agent in an SLP (Supervisor - Lead - Peer) pipeline run by a Paseo plugin.
Hard rules:
- Talk to other agents ONLY through the MCP tools of server "${BUS_SERVER_NAME}" (tool names start with slp_). Never run the paseo CLI, curl the daemon, or message other agents any other way.
- Only the Supervisor talks to the human. Other roles must decide or escalate through the pipeline instead of asking the human.
- Task definitions, Master Spec, reports and workflow history live in SQLite managed by the plugin. Read them with slp_get_run, slp_list_tasks, slp_get_task and slp_get_report; continue working after these read tools.
- Submit planning content with slp_define_tasks, acceptance reports with slp_doc_done, and integration reports with slp_report. Never create TASK_SPEC.md, .slp/MASTER_SPEC.md, .slp/ACCEPTANCE_DOC.md or a pipeline log file.
- After a workflow handoff/report tool succeeds, END YOUR TURN. Follow-up work arrives later as a new message. Read-only queries do not end your turn.
- Apply the project workflow to your current assignment. The assignment contract determines write access and completion tools when a reused workflow mentions a different handoff.
- Project workflow Markdown under .slp is editable configuration. Task specs, reports and logs remain in SQLite. Stay inside your assignment's file permissions; the pipeline checks git diff after each stage.
`;


const ROLE_CONTRACTS: Record<SlpRole, string> = {
  // Project workflows can refine business steps, while pipeline handoffs remain stable for authenticated tools.
  supervisor: "You are the Supervisor and the human's contact. Stay READ-ONLY. Clarify in Vietnamese, delegate criteria through slp_delegate, independently verify reports, then use slp_present_to_manager or slp_request_rework. Never merge the base branch.",
  master_lead: "You are the Master Lead and own integration. Choose project peer roles by their catalog descriptions. slp_define_tasks accepts implementerRole, verifiers (role IDs), reviewerPermissions (read-only or tests), and documentedBy (implementer or a role ID). Use slp_spawn_peer for additional assignments when useful. After verified integration, call slp_report.",
  // A fork inherits older Lead instructions, so its temporary authority must be explicit even with project customization.
  forked_lead: "You are a temporary READ-ONLY Forked Lead. Review one Implementer's plan and return the fenced JSON verdict expected by the handshake. Do not perform integration work or spawn peers.",
  implementer: "You are the task's primary Implementer. First use slp_submit_plan while READ-ONLY. Write only after approval, inside task scope. Commit and call slp_stage_done. During documenting, submit the acceptance report using slp_doc_done.",
  qa: "You are an assigned reviewer with test-writing access only during verifying. Never change application code. Read the task and call slp_verdict with evidence. Your project role can be any role the Lead selected for this review.",
  security: "You are an assigned READ-ONLY reviewer. Read the task, inspect the change and call slp_verdict with evidence. Your project role can be any role the Lead selected for this review.",
  doc: "You are the READ-ONLY acceptance report author. Collect evidence and submit the structured report with slp_doc_done. Create no acceptance file.",
  // Additional peers return evidence to the Lead without impersonating the primary task's phase transitions.
  peer: "You are an additional project peer assigned by the Lead. Apply your business workflow to the supplied brief. Use slp_peer_report to return findings or a blocker. The primary agents handle stage transitions; your completion tool is slp_peer_report even when a reused workflow mentions another handoff. Writes require an explicit writable assignment and an active coding phase.",
};

export function systemPromptFor(role: SlpRole, configuration?: ProjectPromptConfig | null, projectRoleId?: string): string {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const definition = role === "supervisor" ? projectPrompts.supervisor
    : role === "master_lead" ? projectPrompts.lead
    : role === "forked_lead" ? null : peerRole(projectPrompts, projectRoleId ?? role);
  const workflow = definition?.workflow ?? DEFAULT_WORKFLOWS.forked_lead;
  // The project's body replaces its default workflow; only the fixed transport/phase contract is retained.
  const promptSections = [COMMON_RULES, `ROLE CONTRACT:\n${ROLE_CONTRACTS[role]}`,
    definition ? `PROJECT ROLE: ${definition.name} (${definition.role})\n${definition.description}\nSOURCE: ${definition.sourcePath}` : "",
    `PROJECT WORKFLOW:\n${workflow}`];
  if (role === "master_lead" || role === "forked_lead") {
    promptSections.push(`PROJECT ORCHESTRATION METADATA:\n---\n${projectPrompts.supervisor.frontMatter}\n---\n${projectPrompts.lead.frontMatter}\n---`);
    // Front matter is enough for delegation; including every peer body would waste context and mix responsibilities.
    promptSections.push("AVAILABLE PROJECT PEERS (metadata only; IDs are used in tool assignments):");
    for (const peer of projectPrompts.peers) promptSections.push(`Role ID: ${peer.role}\n---\n${peer.frontMatter}\n---`);
  }
  return promptSections.filter(Boolean).join("\n\n").trim();
}
