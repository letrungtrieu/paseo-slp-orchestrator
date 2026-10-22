// A project role describes business expertise; its assignment is chosen by the Lead, not hardcoded in YAML.
import { z } from "zod";

export const ProjectRoleIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const ProjectRoleSchema = z.object({
  role: ProjectRoleIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  // Null means inherit the corresponding model/thinking choice from the run's SLP form.
  model: z.string().nullable().default(null),
  thinking: z.string().nullable().default(null),
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
