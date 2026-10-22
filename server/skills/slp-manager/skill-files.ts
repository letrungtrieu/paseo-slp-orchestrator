// Every file the `slp-manager` skill ships, keyed by its path inside the skill directory.
import { PROJECT_INVESTIGATION_REFERENCE } from "./project-investigation-reference";
import { renderSlpManagerSkillMarkdown } from "./skill-markdown";
import { STACK_PLAYBOOKS_REFERENCE } from "./stack-playbooks-reference";
import { TEST_POLICY_TEMPLATE_REFERENCE } from "./test-policy-template-reference";

export const SKILL_MARKDOWN_FILENAME = "SKILL.md";

export interface SlpManagerSkillFile {
  // Relative to <skillRoot>/slp-manager; SKILL.md links to the reference paths verbatim.
  relativePath: string;
  content: string;
}

// SKILL.md comes first because the installer reports it as the skill's entry point.
export function slpManagerSkillFiles(): SlpManagerSkillFile[] {
  return [
    { relativePath: SKILL_MARKDOWN_FILENAME, content: renderSlpManagerSkillMarkdown() },
    // Reference files load only when SKILL.md points the agent at them, keeping the always-loaded skill body small.
    { relativePath: "references/PROJECT_INVESTIGATION.md", content: PROJECT_INVESTIGATION_REFERENCE },
    { relativePath: "references/TEST_POLICY_TEMPLATE.md", content: TEST_POLICY_TEMPLATE_REFERENCE },
    { relativePath: "references/STACK_PLAYBOOKS.md", content: STACK_PLAYBOOKS_REFERENCE },
  ];
}
