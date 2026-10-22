// Installs the bundled `slp-manager` skill into a selected project's skill directories
// (<repoPath>/.agents/skills and <repoPath>/.claude/skills) so coding agents working in that
// project understand the 3-tier SLP architecture, investigate the project's test practice, and author .slp/*.md role files safely.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SKILL_MARKDOWN_FILENAME, slpManagerSkillFiles } from "./slp-manager/skill-files";
import { SLP_MANAGER_SKILL_NAME } from "./slp-manager/skill-name";

// Re-exported so callers keep one import path while the skill content lives in ./slp-manager/.
export { SLP_MANAGER_SKILL_NAME } from "./slp-manager/skill-name";
export { renderSlpManagerSkillMarkdown } from "./slp-manager/skill-markdown";

export interface SlpManagerSkillOptions {
  targetSkillRoots?: readonly string[];
}

// Resolve the project-level skill directories scanned by Paseo providers (Antigravity, Codex, Claude Code, OMP).
export function defaultProjectSkillRoots(repoPath: string): string[] {
  const resolvedRepoRoot = resolve(repoPath);
  return [
    join(resolvedRepoRoot, ".agents", "skills"),
    join(resolvedRepoRoot, ".claude", "skills"),
  ];
}

// Canonicalize skill root directories so symlinked provider folders (e.g. .claude/skills -> .agents/skills)
// are written once without redundant or conflicting file operations.
function deduplicateSkillRoots(candidateRoots: readonly string[]): string[] {
  const seenCanonicalRoots = new Set<string>();
  const uniqueSkillRoots: string[] = [];
  for (const candidateRoot of candidateRoots) {
    mkdirSync(candidateRoot, { recursive: true });
    let canonicalRootPath: string;
    try {
      canonicalRootPath = realpathSync(candidateRoot);
    } catch {
      canonicalRootPath = resolve(candidateRoot);
    }
    if (seenCanonicalRoots.has(canonicalRootPath)) continue;
    seenCanonicalRoots.add(canonicalRootPath);
    uniqueSkillRoots.push(candidateRoot);
  }
  return uniqueSkillRoots;
}

// Write each skill file only when missing or outdated so repeated clicks do not churn disk timestamps unnecessarily.
function writeSkillFileIfChanged(skillFilePath: string, expectedContent: string): void {
  mkdirSync(dirname(skillFilePath), { recursive: true });
  if (existsSync(skillFilePath)) {
    try {
      const existingContent = readFileSync(skillFilePath, "utf8");
      if (existingContent === expectedContent) return;
    } catch {
      // Fall through and rewrite when the existing file cannot be read.
    }
  }
  writeFileSync(skillFilePath, expectedContent, "utf8");
}

// Provision the `slp-manager` skill inside the selected project repository.
export function ensureSlpManagerSkill(
  repoPath: string,
  options: SlpManagerSkillOptions = {},
): {
  skillName: string;
  installedPaths: string[];
} {
  const candidateRoots = options.targetSkillRoots ?? defaultProjectSkillRoots(repoPath);
  const uniqueRoots = deduplicateSkillRoots(candidateRoots);
  const skillFiles = slpManagerSkillFiles();
  const installedPaths: string[] = [];

  for (const skillRoot of uniqueRoots) {
    // SKILL.md references its sibling files by relative path, so every root receives the complete file set.
    for (const skillFile of skillFiles) {
      writeSkillFileIfChanged(join(skillRoot, SLP_MANAGER_SKILL_NAME, skillFile.relativePath), skillFile.content);
    }
    // Only the entry point is reported; the UI shows these paths and the references are implementation detail.
    installedPaths.push(join(skillRoot, SLP_MANAGER_SKILL_NAME, SKILL_MARKDOWN_FILENAME));
  }

  return {
    skillName: SLP_MANAGER_SKILL_NAME,
    installedPaths,
  };
}
