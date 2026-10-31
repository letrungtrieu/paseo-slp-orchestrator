// Compose the agent system prompt directly from project-authored .slp Markdown files and dynamic stage context.
import { isPipelineLeadRole, type SlpRole } from "../../shared/roles";
import { peerKindOf, type ProjectPromptConfig } from "../../shared/project-prompts";
import { defaultProjectPrompts, peerRole, qaLeadDefinition } from "../project-prompts/defaults";
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

// Run-level checkout facts from the run's orchestration snapshot; only a worktree-free run needs an explicit statement.
export interface CheckoutPolicy {
  spawnWorktrees: boolean;
  repoPath: string;
  baseBranch: string;
}

function checkoutPolicySection(checkoutPolicy: CheckoutPolicy): string {
  // .slp workflows are user-owned and can predate worktree-free runs, so the engine restates where agents work and says it wins.
  return [
    `CHECKOUT POLICY FOR THIS RUN: git worktrees are off. Every agent works directly in the main checkout at ${checkoutPolicy.repoPath} on branch ${checkoutPolicy.baseBranch}.`,
    "Do not create, add, enter or switch to a git worktree or a new branch (no `git worktree add`, no EnterWorktree, no slp/* branch). Do not call slp_create_worktree to obtain a separate checkout: it returns this main checkout and creates nothing.",
    "This policy overrides any workflow text below that asks for a worktree; read \"worktree\" there as this checkout.",
  ].join("\n");
}

// Worktree-free runs put every feature on one checkout and branch, so the Supervisor's split is the only thing keeping features apart.
function sharedCheckoutDelegationSection(): string {
  return [
    "SHARED CHECKOUT DELEGATION RULE (this run has worktrees off, so every delegated feature builds in the same checkout and branch):",
    "- Before you call slp_delegate with more than one task, read the code (read-only) and work out which files, modules, screens and APIs each task would change.",
    "- Give every task a write scope in its acceptanceCriteria: the paths or globs it may change (for example src/billing/**), and the shared files it must not change unless it is the single task that owns them (package manifests, lockfiles, migrations, global config and routing, shared types, generated files, global styles).",
    "- Keep parallel tasks disjoint. If two tasks would change the same file or module, or one changes a contract the other uses, merge them into one task, or deliver them in sequence: delegate the second only after the first cycle has completed.",
    "- Name one owner for each shared contract (API, schema, type) in sharedContext, and say which tasks only consume it.",
    "- Leave tasks[].worktree empty: this run has no separate checkouts.",
    "- Include the task split and each task's scope when you present the Spec to the human.",
    "Nothing isolates these features: overlapping edits land in the same working tree with no merge step to flag them, and the engine does not stop a peer from editing files outside its feature. The scope you write is the only guard.",
  ].join("\n");
}

function projectDefinition(
  role: SlpRole,
  projectPrompts: ProjectPromptConfig,
  projectRoleId: string | undefined,
) {
  if (role === "supervisor") return projectPrompts.supervisor;
  if (role === "master_lead") return projectPrompts.lead;
  if (role === "qa_lead") return qaLeadDefinition(projectPrompts);
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
  checkoutPolicy?: CheckoutPolicy,
): string {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const selectedRoleDefinition = projectDefinition(role, projectPrompts, projectRoleId);
  const configuredWorkflow = selectedRoleDefinition.workflow || DEFAULT_WORKFLOWS[role];
  // Workflows are injected untouched so user edits in .slp/*.md keep full control; the engine adds only run-level checkout rules, since it alone decides where agents run.
  // Only a worktree-free run puts every feature on one checkout, so only that run gets the shared-checkout rules.
  const sharedCheckoutPolicy = checkoutPolicy && !checkoutPolicy.spawnWorktrees ? checkoutPolicy : null;
  const promptSections = [
    `PROJECT ROLE: ${selectedRoleDefinition.name} (${selectedRoleDefinition.role})\n${selectedRoleDefinition.description}\nSOURCE: ${selectedRoleDefinition.sourcePath}`,
    // Placed before the workflow so the rules are read first; runs that keep worktrees get no extra text.
    sharedCheckoutPolicy ? checkoutPolicySection(sharedCheckoutPolicy) : "",
    // Only the Supervisor splits work into features, so only it needs the scope rule.
    role === "supervisor" && sharedCheckoutPolicy ? sharedCheckoutDelegationSection() : "",
    `PROJECT WORKFLOW:\n${configuredWorkflow}`,
  ];
  if (isPipelineLeadRole(role)) {
    // Only the summary metadata of .slp/peers agent prompts is injected into both Lead kinds so they coordinate stages on their own.
    promptSections.push("AVAILABLE PROJECT PEERS (.slp/peers summary metadata only; select by role ID):");
    for (const peerDefinition of projectPrompts.peers) {
      promptSections.push(
        // The kind is printed even when inferred, because it decides which stage the Lead may put the peer in.
        `Role ID: ${peerDefinition.role} (${peerDefinition.name}, kind: ${peerKindOf(peerDefinition)}) — ${peerDefinition.description}\nSOURCE: ${peerDefinition.sourcePath}\n---\n${peerDefinition.frontMatter}\n---`,
      );
    }
  }
  if (stage) {
    promptSections.push(`CURRENT PIPELINE STAGE ASSIGNMENT:\n${stageAssignment(stage)}`);
  }
  return promptSections.filter(Boolean).join("\n\n").trim();
}

