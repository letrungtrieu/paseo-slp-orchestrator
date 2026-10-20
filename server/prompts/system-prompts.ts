// Compose the agent system prompt directly from project-authored .slp Markdown files and dynamic stage context.
import type { SlpRole } from "../../shared/roles";
import type { ProjectPromptConfig } from "../../shared/project-prompts";
import { defaultProjectPrompts, peerRole } from "../project-prompts/defaults";
import { DEFAULT_WORKFLOWS } from "./default-workflows";

// The gateway can pass this shape before or after the shared pipeline schema is introduced.
// Keeping the prompt boundary structural makes old run snapshots readable during migration.
export interface StagePromptContext {
  pipelineId?: string;
  pipelineName?: string;
  stageId?: string;
  stageName: string;
  goal: string;
  task: string;
  worktree: string;
  peerRoster?: Array<{ role: string; task: string }>;
  priorResults?: string[];
  history?: string[];
}

function projectDefinition(
  role: SlpRole,
  projectPrompts: ProjectPromptConfig,
  projectRoleId: string | undefined,
) {
  if (role === "supervisor") return projectPrompts.supervisor;
  if (role === "master_lead") return projectPrompts.lead;
  // Forked Lead uses its dedicated .slp/FORKED_LEAD.md file, falling back to LEAD.md only for older SQLite snapshots.
  if (role === "forked_lead") return projectPrompts.forkedLead ?? projectPrompts.lead;
  // Base Peer uses its dedicated .slp/BASE_PEER.md file, falling back to the seeded Base Peer definition for older snapshots.
  if (role === "base_peer") return projectPrompts.basePeer ?? defaultProjectPrompts().basePeer!;
  return peerRole(projectPrompts, projectRoleId ?? "");
}

function stageAssignment(context: StagePromptContext): string {
  // Keep only compact stage identity in systemPrompt because full task briefs, rosters and prior results are delivered in stage mail.
  return [
    `PIPELINE: ${context.pipelineName ?? context.pipelineId ?? "unnamed"}`,
    context.pipelineId ? `PIPELINE ID: ${context.pipelineId}` : "",
    `STAGE: ${context.stageName}${context.stageId ? ` (${context.stageId})` : ""}`,
    `WORKTREE: ${context.worktree}`,
    `STAGE GOAL: ${context.goal}`,
  ].filter(Boolean).join("\n");
}

export function systemPromptFor(
  role: SlpRole,
  configuration?: ProjectPromptConfig | null,
  projectRoleId?: string,
  stage?: StagePromptContext,
): string {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const selectedRoleDefinition = projectDefinition(role, projectPrompts, projectRoleId);
  const configuredWorkflow = selectedRoleDefinition.workflow || DEFAULT_WORKFLOWS[role];
  // Do not wrap or override .slp workflows with hardcoded rules so user edits in .slp/*.md have full control.
  const promptSections = [
    `PROJECT ROLE: ${selectedRoleDefinition.name} (${selectedRoleDefinition.role})\n${selectedRoleDefinition.description}\nSOURCE: ${selectedRoleDefinition.sourcePath}`,
    `PROJECT WORKFLOW:\n${configuredWorkflow}`,
  ];
  if (role === "master_lead") {
    // Only the summary metadata of .slp/peers agent prompts is injected into Lead so it coordinates stages on its own.
    promptSections.push("AVAILABLE PROJECT PEERS (.slp/peers summary metadata only; select by role ID):");
    for (const peerDefinition of projectPrompts.peers) {
      promptSections.push(
        `Role ID: ${peerDefinition.role} (${peerDefinition.name}) — ${peerDefinition.description}\nSOURCE: ${peerDefinition.sourcePath}\n---\n${peerDefinition.frontMatter}\n---`,
      );
    }
  }
  if (stage) {
    promptSections.push(`CURRENT PIPELINE STAGE ASSIGNMENT:\n${stageAssignment(stage)}`);
  }
  return promptSections.filter(Boolean).join("\n\n").trim();
}

