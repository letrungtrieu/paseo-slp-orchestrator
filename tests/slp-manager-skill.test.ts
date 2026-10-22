// Verifies that the bundled `slp-manager` skill is provisioned inside a selected project's
// skill directories (<repoPath>/.agents/skills and <repoPath>/.claude/skills), deduplicates
// symlinked skill roots, and documents grouped .slp/peers/<group>/* templates that pass parseRoleMarkdown.
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BUS_TOOL_DEFINITIONS } from "../server/bus/tool-schemas";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { slpManagerSkillFiles } from "../server/skills/slp-manager/skill-files";
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
    expect(installedSkillText).toContain("## 4. Rules for Editing `.slp/SUPERVISOR.md`, `.slp/LEAD.md` and `.slp/QA_LEAD.md` Safely");
    // Agents editing .slp must learn that only the QA Lead reports and that it never edits code itself.
    expect(installedSkillText).toContain("### Mandatory Checklist When Editing `.slp/QA_LEAD.md`");
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
    // The template peer must model the tier contract that keeps heavy tools out of feature pipelines.
    expect(parsedExampleRole.frontMatter).toContain("tier: feature");
  });

  it("installs every reference file that SKILL.md points agents to", async () => {
    const fakeProjectDirectory = await createDirectory("slp-skill-references");
    ensureSlpManagerSkill(fakeProjectDirectory);
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    const referenceFiles = slpManagerSkillFiles().filter((skillFile) => skillFile.relativePath.startsWith("references/"));
    expect(referenceFiles.map((skillFile) => skillFile.relativePath)).toEqual([
      "references/PROJECT_INVESTIGATION.md",
      "references/TEST_POLICY_TEMPLATE.md",
      "references/STACK_PLAYBOOKS.md",
    ]);
    for (const referenceFile of referenceFiles) {
      // A reference that SKILL.md never names would be dead weight; one it names but never installs would break the procedure.
      expect(skillMarkdown).toContain(referenceFile.relativePath);
      const installedReferenceText = await readFile(
        join(fakeProjectDirectory, ".claude", "skills", SLP_MANAGER_SKILL_NAME, referenceFile.relativePath),
        "utf8",
      );
      expect(installedReferenceText).toBe(referenceFile.content);
    }
  });

  it("ships a TEST_POLICY template whose machine-readable block parses and lists heavy resource signatures", () => {
    const templateReference = slpManagerSkillFiles().find((skillFile) => skillFile.relativePath === "references/TEST_POLICY_TEMPLATE.md");
    const yamlBlockMatch = /```yaml\n([\s\S]*?)\n```/.exec(templateReference!.content);
    expect(yamlBlockMatch).not.toBeNull();
    // Future runtime guards read these keys from generated policies, so the template must stay valid YAML with this shape.
    const templatePolicy = parseYaml(yamlBlockMatch![1]) as {
      tiers: Record<string, { where: string }>;
      heavy_resources: Array<{ id: string; process_signatures: string[]; max_concurrent: number }>;
    };
    expect(Object.keys(templatePolicy.tiers)).toEqual(["fast", "engine", "integration"]);
    expect(templatePolicy.tiers.fast.where).toBe("feature-pipelines");
    expect(templatePolicy.heavy_resources[0].process_signatures.length).toBeGreaterThan(0);
    expect(templatePolicy.heavy_resources[0].max_concurrent).toBe(1);
  });

  it("seeds a tier on every default peer and keeps heavy verification in the QA pipeline", () => {
    const seededPeerTiers = Object.fromEntries(
      defaultProjectPrompts().peers.map((seededPeer) => [seededPeer.role, parseYaml(seededPeer.frontMatter).tier]),
    );
    expect(seededPeerTiers).toEqual({
      "developer": "feature",
      "qa-engineer": "integration",
      "reviewer": "feature",
      "security-reviewer": "feature",
    });
  });

  it("only names bus tools that exist, so agents never call a tool the engine rejects", () => {
    const namedToolNames = new Set(renderSlpManagerSkillMarkdown().match(/\bslp_[a-z]+(?:_[a-z]+)*\b/g) ?? []);
    const definedToolNames = new Set<string>(Object.keys(BUS_TOOL_DEFINITIONS));
    expect([...namedToolNames].filter((toolName) => !definedToolNames.has(toolName))).toEqual([]);
  });

  it("requires a productSpec wherever the skill shows a delegation payload", () => {
    // Stale examples without productSpec make every generated Supervisor prompt fail at slp_delegate.
    const delegationLines = renderSlpManagerSkillMarkdown()
      .split("\n")
      .filter((line) => line.includes("acceptanceCriteria") && line.includes("slp_delegate"));
    expect(delegationLines.length).toBeGreaterThan(0);
    for (const delegationLine of delegationLines) {
      expect(delegationLine).toContain("productSpec");
    }
  });

  it("lists the QA Lead root file among the files the engine injects", () => {
    const criticalRule = renderSlpManagerSkillMarkdown().split("\n").find((line) => line.includes("CRITICAL RULE")) ?? "";
    expect(criticalRule).toContain("`.slp/QA_LEAD.md`");
  });

  it("gives older .slp folders a migration checklist that confirms before deleting UAT content", () => {
    const skillMarkdown = renderSlpManagerSkillMarkdown();
    expect(skillMarkdown).toContain("## 6. Upgrading an Existing `.slp` to the Current Structure");
    expect(skillMarkdown).toContain("Delete the file only after the human confirms");
  });

  it("keeps the QA engineer as the only seeded integration-tier peer so QA pipelines can run heavy verification", () => {
    const integrationPeerRoles = defaultProjectPrompts().peers
      .filter((seededPeer) => parseYaml(seededPeer.frontMatter).tier === "integration")
      .map((seededPeer) => seededPeer.role);
    expect(integrationPeerRoles).toEqual(["qa-engineer"]);
  });
});
