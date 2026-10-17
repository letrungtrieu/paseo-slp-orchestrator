// Defaults seed editable project files; keeping them in code also supports runs created before project prompts existed.
import type { ProjectPromptConfig, ProjectRole } from "../../shared/project-prompts";
import { DEFAULT_WORKFLOWS } from "../prompts/default-workflows";
import { normalizeRoleId, parseRoleMarkdown } from "./markdown";

// Seed roles are examples only; users can replace every peer file without changing engine code.
const DEFAULT_ROLES = [
  {
    role: "supervisor",
    name: "Supervisor",
    description: "Clarify the project requirements with the human and independently accept the delivered result.",
    file: "SUPERVISOR.md",
    workflow: DEFAULT_WORKFLOWS.supervisor.trim(),
  },
  {
    role: "master_lead",
    name: "Lead",
    description: "Plan the solution, assign project peer roles and integrate accepted work.",
    file: "LEAD.md",
    workflow: DEFAULT_WORKFLOWS.master_lead.trim(),
  },
  {
    role: "developer",
    name: "Developer",
    description: "Implement scoped features and fixes with evidence in the shared pipeline worktree.",
    file: "peers/DEVELOPER.md",
    workflow: `Focus on clean implementation, automated tests and verifiable changes in the shared pipeline worktree.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
  {
    role: "reviewer",
    name: "Reviewer",
    description: "Review the current stage's design and implementation and challenge weak assumptions.",
    file: "peers/REVIEWER.md",
    workflow: `Focus on architecture, correctness, maintainability and challenging weak assumptions with concrete file/line evidence.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
  {
    role: "qa-engineer",
    name: "QA Engineer",
    description: "Exercise the delivered behavior, inspect edge cases and report quality findings.",
    file: "peers/QA_ENGINEER.md",
    workflow: `Focus on exercising the delivered behavior, regression coverage, boundary conditions and reproducible verification evidence.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
  {
    role: "security-reviewer",
    name: "Security Reviewer",
    description: "Review vulnerabilities, data handling, trust boundaries and architecture risks.",
    file: "peers/SECURITY_REVIEWER.md",
    workflow: `Focus on trust boundaries, authentication/authorization, input validation, secret handling and security risks.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
] as const;

export function defaultPromptFiles(): Array<{ relativePath: string; markdown: string }> {
  return DEFAULT_ROLES.map((definition) => ({
    relativePath: definition.file,
    // Each .slp/peers file is the agent prompt for that role; its YAML front matter is the summary injected into the Lead.
    markdown: `---\nrole: ${definition.role}\nname: ${definition.name}\ndescription: ${definition.description}\nmodel:\nthinking:\n---\n\n# Workflow\n\n${definition.workflow}\n`,
  }));
}

export function defaultProjectPrompts(): ProjectPromptConfig {
  const roles = defaultPromptFiles().map((definition) => parseRoleMarkdown(definition.markdown, `.slp/${definition.relativePath}`));
  // Root files have a fixed purpose; peer names are discovered solely from their front matter.
  const [supervisor, lead, ...peers] = roles;
  return { supervisor, lead, peers };
}

export function peerRole(config: ProjectPromptConfig | null | undefined, roleId: string): ProjectRole {
  const peers = (config ?? defaultProjectPrompts()).peers;
  const normalizedRoleId = normalizeRoleId(roleId);
  const selectedRole = peers.find((peer) => peer.role === normalizedRoleId);
  if (!selectedRole) throw new Error(`Unknown project peer role '${roleId}'. Available roles: ${peers.map((peer) => peer.role).join(", ") || "(none)"}`);
  return selectedRole;
}
