// Verifies that the bundled `slp-manager` skill is provisioned inside a selected project's
// skill directories (<repoPath>/.agents/skills and <repoPath>/.claude/skills), deduplicates
// symlinked skill roots, and documents grouped .slp/peers/<group>/* templates that pass parseRoleMarkdown.
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import {
  defaultProjectSkillRoots,
  ensureSlpManagerSkill,
  renderSlpManagerSkillMarkdown,
  SLP_MANAGER_SKILL_NAME,
} from "../server/skills/slp-manager-skill";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

describe("slp-manager project skill provisioning", () => {
  it("lists project-scoped provider skill directories under the selected repository", () => {
    const projectSkillRoots = defaultProjectSkillRoots("/tmp/fake-project");
    // Paseo providers scan .agents/skills (Antigravity, Codex, OMP) and .claude/skills (Claude Code) inside the repo root.
    expect(projectSkillRoots).toEqual([
      "/tmp/fake-project/.agents/skills",
      "/tmp/fake-project/.claude/skills",
    ]);
  });

  it("writes SKILL.md into the selected project's skill roots and deduplicates symlinked folders", async () => {
    const fakeProjectDirectory = await createDirectory("slp-skill-project");
    const agentsSkillsDirectory = join(fakeProjectDirectory, ".agents", "skills");
    const claudeSkillsSymlink = join(fakeProjectDirectory, ".claude-skills-link");

    // First create .agents/skills, then symlink a second root to it to verify canonical path deduplication.
    ensureSlpManagerSkill(fakeProjectDirectory, { targetSkillRoots: [agentsSkillsDirectory] });
    await symlink(agentsSkillsDirectory, claudeSkillsSymlink);

    const provisioningOutcome = ensureSlpManagerSkill(fakeProjectDirectory, {
      targetSkillRoots: [agentsSkillsDirectory, claudeSkillsSymlink],
    });

    expect(provisioningOutcome.skillName).toBe(SLP_MANAGER_SKILL_NAME);
    expect(provisioningOutcome.installedPaths).toEqual([
      join(agentsSkillsDirectory, SLP_MANAGER_SKILL_NAME, "SKILL.md"),
    ]);

    // Default invocation without custom roots writes both .agents/skills and .claude/skills inside the project.
    const defaultProjectOutcome = ensureSlpManagerSkill(fakeProjectDirectory);
    expect(defaultProjectOutcome.installedPaths).toEqual([
      join(fakeProjectDirectory, ".agents", "skills", SLP_MANAGER_SKILL_NAME, "SKILL.md"),
      join(fakeProjectDirectory, ".claude", "skills", SLP_MANAGER_SKILL_NAME, "SKILL.md"),
    ]);

    const installedSkillText = await readFile(
      join(fakeProjectDirectory, ".agents", "skills", SLP_MANAGER_SKILL_NAME, "SKILL.md"),
      "utf8",
    );
    expect(installedSkillText).toContain(`name: ${SLP_MANAGER_SKILL_NAME}`);
    expect(installedSkillText).toContain("## 1. How the 3-Tier SLP Architecture Works");
    expect(installedSkillText).toContain("## 2. Organizing `.slp/` by Functional Groups & Shared Standards");
    expect(installedSkillText).toContain("├── engineering/");
    expect(installedSkillText).toContain("├── quality/");
    expect(installedSkillText).toContain("├── standards/");
    expect(installedSkillText).toContain("## 3. How to Create a New Grouped Peer Role in `.slp/peers/<group>/<ROLE>.md`");
    expect(installedSkillText).toContain("## 4. Rules for Editing `.slp/SUPERVISOR.md` and `.slp/LEAD.md` Safely");
  });

  it("embeds a grouped peer role template in SKILL.md that parses cleanly with parseRoleMarkdown", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    const exampleFenceMatch = /```markdown\n([\s\S]*?)\n```/.exec(skillMarkdown);
    expect(exampleFenceMatch).not.toBeNull();

    // The example template inside the skill must obey the exact parser rules enforced at runtime.
    const parsedExampleRole = parseRoleMarkdown(
      exampleFenceMatch![1],
      ".slp/peers/engineering/BACKEND_ENGINEER.md",
    );
    expect(parsedExampleRole.role).toBe("backend-engineer");
    expect(parsedExampleRole.name).toBe("Backend & API Engineer");
    expect(parsedExampleRole.frontMatter).toContain("domains:");
    expect(parsedExampleRole.frontMatter).toContain("skills:");
    expect(parsedExampleRole.workflow).toContain("slp_stage_report");
    expect(parsedExampleRole.workflow).toContain("END YOUR TURN");
  });
});
