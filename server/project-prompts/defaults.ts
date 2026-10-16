// Defaults seed editable project files; keeping them in code also supports runs created before project prompts existed.
import type { ProjectPromptConfig, ProjectRole } from "../../shared/project-prompts";
import type { SlpRole } from "../../shared/roles";
import { DEFAULT_WORKFLOWS } from "../prompts/default-workflows";
import { parseRoleMarkdown } from "./markdown";

const DEFAULT_ROLES = [
  { role: "supervisor", name: "Supervisor", description: "Clarify the project requirements with the human and independently accept the delivered result.", file: "SUPERVISOR.md" },
  { role: "master_lead", name: "Lead", description: "Plan the solution, assign project peer roles and integrate accepted work.", file: "LEAD.md" },
  { role: "implementer", name: "Implementer", description: "Implement scoped features and fixes, with unit tests and commits.", file: "peers/IMPLEMENTER.md" },
  { role: "qa", name: "QA", description: "Design and run tests, inspect edge cases and report quality findings.", file: "peers/QA.md" },
  { role: "security", name: "Security", description: "Review vulnerabilities, data handling, trust boundaries and architecture risks.", file: "peers/SECURITY.md" },
  { role: "doc", name: "Doc", description: "Collect implementation and review evidence into a structured acceptance report.", file: "peers/DOC.md" },
] as const;

export function defaultPromptFiles(): Array<{ relativePath: string; markdown: string }> {
  return DEFAULT_ROLES.map((definition) => ({
    relativePath: definition.file,
    // No kind is prescribed: the Lead assigns a business role to the task's actual responsibility.
    markdown: `---\nrole: ${definition.name}\ndescription: ${definition.description}\nmodel:\nthinking:\n---\n\n# Workflow\n\n${DEFAULT_WORKFLOWS[definition.role as SlpRole].trim()}\n`,
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
  const selectedRole = peers.find((peer) => peer.role === roleId);
  if (!selectedRole) throw new Error(`Unknown project peer role '${roleId}'. Available roles: ${peers.map((peer) => peer.role).join(", ") || "(none)"}`);
  return selectedRole;
}
