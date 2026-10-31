// A project role describes business expertise; its assignment is chosen by the Lead, not hardcoded in YAML.
import { z } from "zod";

// Version of the SLP role contract (engine rules plus the slp-manager skill). Every seeded or updated .slp file
// carries it in front matter, so an update can tell which files predate the current contract.
export const SLP_CONTRACT_VERSION = "2026-10-31";

export const ProjectRoleIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

// What a peer is allowed to do decides where the Lead may schedule it: advisors only discuss the plan,
// the single developer writes code, QA peers grade the result against the locked brief.
export const PEER_KINDS = ["advisor", "developer", "qa"] as const;
export const PeerKindSchema = z.enum(PEER_KINDS);
export type PeerKind = z.infer<typeof PeerKindSchema>;

export const ProjectRoleSchema = z.object({
  role: ProjectRoleIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  // Null means inherit the corresponding model/thinking choice from the run's SLP form.
  model: z.string().nullable().default(null),
  thinking: z.string().nullable().default(null),
  // Null when the front matter has no `kind:`; peerKindOf then infers it from the role id for older projects.
  kind: PeerKindSchema.nullable().default(null),
  // Preserve all front matter for the Lead, while keeping the actual peer workflow separate.
  frontMatter: z.string(),
  workflow: z.string().min(1),
  sourcePath: z.string(),
});
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const ProjectPromptConfigSchema = z.object({
  supervisor: ProjectRoleSchema,
  lead: ProjectRoleSchema,
  // Optional only so run snapshots taken before QA_LEAD.md existed still load; readers fall back to the built-in default.
  qaLead: ProjectRoleSchema.optional(),
  // Store a run snapshot so worktrees and plugin restarts agree even if project files change later.
  peers: z.array(ProjectRoleSchema),
});
export type ProjectPromptConfig = z.infer<typeof ProjectPromptConfigSchema>;

// Projects created before `kind:` existed still need a sensible kind, so the role id decides:
// review/design/research style names advise, test/QA names grade, everything else writes code.
const ADVISOR_ROLE_PATTERN = /(review|audit|architect|design|advis|research|consult|analyst)/;
const QA_ROLE_PATTERN = /(^|-)(qa|test|tester|testing|verif|playtest)/;

export function peerKindOf(role: Pick<ProjectRole, "role" | "kind">): PeerKind {
  if (role.kind) return role.kind;
  if (QA_ROLE_PATTERN.test(role.role)) return "qa";
  if (ADVISOR_ROLE_PATTERN.test(role.role)) return "advisor";
  return "developer";
}
