// Defaults seed editable project files; keeping them in code also supports runs created before project prompts existed.
import type { ProjectPromptConfig, ProjectRole } from "../../shared/project-prompts";
import { DEFAULT_WORKFLOWS } from "../prompts/default-workflows";
import { normalizeRoleId, parseRoleMarkdown } from "./markdown";

// Seed roles provide the initial .slp/*.md files; users can edit or replace every file without changing engine code.
const DEFAULT_ROLES = [
  // Supervisor is the single human-facing role; it stays read-only and delegates 1 or N parallel features.
  {
    role: "supervisor",
    name: "Supervisor",
    description: "Clarify the project requirements with the human and independently accept the delivered result.",
    file: "SUPERVISOR.md",
    workflow: DEFAULT_WORKFLOWS.supervisor.trim(),
  },
  // Each Lead owns its feature worktree, coordinates with sibling Leads, and directly supervises and forks stage Peers.
  {
    role: "master-lead",
    name: "Lead",
    description: "Investigate the assigned feature worktree, align cross-feature contracts with sibling Leads, define stages, and fork/supervise stage Peers.",
    file: "LEAD.md",
    workflow: DEFAULT_WORKFLOWS.master_lead.trim(),
  },
  // The QA Lead owns the QA branch every Lead merges into and verifies it only through peers it spawns.
  {
    role: "qa-lead",
    name: "QA Lead",
    description: "Prepare verification while features are built, then verify the merged QA branch through spawned peers and report the result to the Supervisor.",
    file: "QA_LEAD.md",
    workflow: DEFAULT_WORKFLOWS.qa_lead.trim(),
  },
  // The single developer of a pipeline builds the locked brief; nobody else writes code.
  {
    role: "developer",
    name: "Developer",
    description: "The single writer of a pipeline — implements exactly the locked brief with tests in the shared worktree.",
    file: "peers/DEVELOPER.md",
    kind: "developer",
    tier: "feature",
    workflow: [
      "Build what the locked brief describes: everything in scope, nothing out of scope.",
      "",
      "1. Read the brief, the stage goal and the files the change touches.",
      "2. Make the smallest change that satisfies every criterion; follow the project's existing patterns and libraries.",
      "3. Add or update tests for the changed behavior and run the fast-tier commands.",
      "4. Commit your work in the pipeline worktree.",
      "5. Report with slp_stage_report: files changed, commands run with their results, and any criterion you could not meet and why.",
      "If the brief is wrong or cannot be built as written, call slp_escalate instead of redesigning it yourself.",
      "",
      DEFAULT_WORKFLOWS.peer.trim(),
    ].join("\n"),
  },
  // QA graders score the brief criteria; they do not fix code, so the Lead decides every rework.
  {
    role: "qa-engineer",
    name: "QA Engineer",
    description: "Grades the merged build against the locked brief criteria and product spec scenarios — pass/fail/blocked with reason and evidence.",
    file: "peers/QA_ENGINEER.md",
    kind: "qa",
    // Verification of the merged QA branch happens in the QA pipeline, so this is the seeded integration-tier peer.
    tier: "integration",
    workflow: [
      "Grade the delivered behavior against the criteria you were given. You do not fix code.",
      "",
      "1. For each criterion, run its verification (automated test, command or manual step from `.slp/standards/TEST_POLICY.md`).",
      "2. Record one scorecard entry per criterion: pass, fail or blocked, a one-line reason, and the evidence (test output, command result, screenshot path).",
      "3. Capture a screenshot only when the criterion is visual and the project already has a way to take one; save it outside the worktree (for example under /tmp).",
      "4. Anything you notice outside the criteria goes into observations; do not grade it.",
      "5. Submit slp_stage_report with summary, scorecard and observations.",
      "Heavy resources listed in TEST_POLICY.md are allowed in the QA pipeline, one at a time, never while another peer of the same stage uses the same resource.",
      "",
      DEFAULT_WORKFLOWS.peer.trim(),
    ].join("\n"),
  },
  // Advisors only take part in planning: they help the Lead choose the approach and never write code.
  {
    role: "architect",
    name: "Architect",
    description: "Planning advisor — proposes the simplest design that fits the existing codebase and names what to leave out.",
    file: "peers/ARCHITECT.md",
    kind: "advisor",
    tier: "feature",
    workflow: `Advise the Lead on structure: which modules change, which existing patterns to reuse, and the simplest design that meets the acceptance criteria. Name tempting extras that should stay out of scope. Report one recommendation, its reason and its main risk.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
  {
    role: "reviewer",
    name: "Technical Reviewer",
    description: "Planning advisor — compares candidate techniques for the problem and flags correctness or maintenance risks before code is written.",
    file: "peers/REVIEWER.md",
    kind: "advisor",
    tier: "feature",
    workflow: `Advise the Lead on technique: list at most two or three candidate approaches, compare them on correctness, complexity and fit with the codebase, and recommend one. Point to concrete files or APIs. Do not propose work beyond the acceptance criteria.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
  {
    role: "security-reviewer",
    name: "Security Advisor",
    description: "Planning advisor — identifies trust-boundary, authorization, input-validation and secret-handling risks the brief must cover.",
    file: "peers/SECURITY_REVIEWER.md",
    kind: "advisor",
    tier: "feature",
    workflow: `Advise the Lead on security risks that apply to this change only, and suggest the brief criteria that would cover them. Skip generic checklists.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
] as const;

export function defaultPromptFiles(): Array<{ relativePath: string; markdown: string }> {
  return DEFAULT_ROLES.map((definition) => ({
    relativePath: definition.file,
    // Each .slp file is the editable system prompt for that role; peer YAML front matter is the summary injected into the Lead.
    // Root roles have no tier; peers declare one so the Lead's catalog shows where each may be scheduled.
    // Peers also declare a kind, which decides the stages they may join and whether they can write.
    markdown: `---\nrole: ${definition.role}\nname: ${definition.name}\ndescription: ${definition.description}\nmodel:\nthinking:\n${"kind" in definition ? `kind: ${definition.kind}\n` : ""}${"tier" in definition ? `tier: ${definition.tier}\n` : ""}---\n\n# Workflow\n\n${definition.workflow}\n`,
  }));
}

export function defaultProjectPrompts(): ProjectPromptConfig {
  const roles = defaultPromptFiles().map((definition) =>
    parseRoleMarkdown(definition.markdown, `.slp/${definition.relativePath}`),
  );
  // Root files have a fixed purpose; peer names are discovered solely from their front matter.
  const [supervisor, lead, qaLead, ...peers] = roles;
  return { supervisor, lead, qaLead, peers };
}

// Snapshots from before QA_LEAD.md existed have no qaLead, so the built-in workflow keeps those runs usable.
export function qaLeadDefinition(config: ProjectPromptConfig | null | undefined): ProjectRole {
  return config?.qaLead ?? defaultProjectPrompts().qaLead!;
}

export function peerRole(config: ProjectPromptConfig | null | undefined, roleId: string): ProjectRole {
  const peers = (config ?? defaultProjectPrompts()).peers;
  const normalizedRoleId = normalizeRoleId(roleId);
  const selectedRole = peers.find((peer) => peer.role === normalizedRoleId);
  if (selectedRole) return selectedRole;
  throw new Error(`Unknown project peer role '${roleId}'. Available roles: ${peers.map((peer) => peer.role).join(", ") || "(none)"}`);
}
