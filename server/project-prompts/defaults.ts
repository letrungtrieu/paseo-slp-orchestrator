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
  // Developer peers implement scoped code and tests while documenting concrete input/logic/output metrics.
  {
    role: "developer",
    name: "Developer",
    description: "Implement scoped features and fixes with concrete input/logic/output metrics, step-by-step methodological arguments, and verifiable evidence in the shared pipeline worktree.",
    file: "peers/DEVELOPER.md",
    tier: "feature",
    workflow: [
      "Focus on clean implementation, automated tests, zero redundant system bloat, and verifiable changes in the shared pipeline worktree. Document the exact logic, expected inputs, and expected outputs/metrics (or concrete runtime outcomes) for every function or feature touched.",
      "",
      "MANDATORY DEVELOPER METHODOLOGY, STEP-BY-STEP METRICS & TRADE-OFF ARGUMENT CONTRACT:",
      "1. Chosen Method & Problem Mapping: Explicitly state the engineering technique/algorithm/pattern (A) you used to solve the assigned problem (B).",
      "2. Step-by-Step Quantitative Progression: Present the chosen method step-by-step with concrete data and metrics—showing how input data (C) is transformed through each processing step to yield output/outcome (D) in measured time or complexity (E).",
      "3. Rejected Alternatives & Rationale: Explicitly explain which alternative technique(s) (F) you chose NOT to use and why (G) (e.g., worse time/memory complexity, boundary distortion, edge-case failure, or redundant system bloat).",
      "4. Required Reporting Pattern Example:",
      "   \"I used technique A to solve problem B; with input data C, it produced output D in time/complexity E (step-by-step metrics: Step 1: ... -> Step 2: ... -> Output: ...). I did not use technique F because G...\"",
      "",
      DEFAULT_WORKFLOWS.peer.trim(),
    ].join("\n"),
  },
  {
    role: "qa-engineer",
    name: "QA Engineer",
    description: "Analyze edge cases, automated vs manual testing needs, UI impact, and capture screenshot/runtime evidence to verify delivered behavior or report bugs.",
    file: "peers/QA_ENGINEER.md",
    tier: "feature",
    workflow: [
      "Focus on exercising the delivered behavior, regression coverage, boundary conditions and reproducible verification evidence.",
      "",
      "MANDATORY QA VERIFICATION & VISUAL EVIDENCE CONTRACT:",
      "1. Logic, Inputs/Outputs & Edge-Case Analysis: For every piece of logic or feature processed in the pipeline, explicitly analyze and state its exact logic, expected inputs, expected outputs/outcomes, and enumerate all potential edge cases that can occur.",
      "2. Automated vs. Manual Test Assessment: Explicitly determine and report which edge cases and flows can be verified via automated tests (and run/write those automated tests) versus which scenarios require manual testing and why.",
      "3. UI / Visual Impact Assessment: Explicitly analyze whether the changes affect the user interface (UI) or visual rendering, and explain how the layout, state, interaction, or rendering is affected.",
      "4. Mandatory Screenshot / Visual Evidence Capture: Whenever the UI or visual output is affected (or when visual proof applies to the feature/bug), you MUST find and execute a concrete mechanism to capture screenshot evidence (e.g., native window/headless screenshot command, browser capture, Xvfb/import/scrot/Playwright or project screenshot tool) and include the captured screenshot path and findings in `slp_stage_report` to prove completion or document a bug. If every available mechanism needs a heavy resource listed in `.slp/standards/TEST_POLICY.md` (engine editor, emulator, simulator, container stack), do not start it in a feature pipeline; list the exact visual checks as integration QA hand-off items instead.",
      "5. Cross-Stage Clarification: If any upstream logic, input/output contract, or edge-case behavior from an earlier stage is unclear, use `slp_send_peer_message` to question the responsible peer from that earlier stage directly.",
      "",
      DEFAULT_WORKFLOWS.peer.trim(),
    ].join("\n"),
  },
  {
    role: "reviewer",
    name: "Reviewer",
    description: "Review the current stage's design, metrics, data hygiene and implementation, challenging weak assumptions or system bloat.",
    file: "peers/REVIEWER.md",
    tier: "feature",
    workflow: `Focus on architecture, correctness, maintainability, input/logic/output metrics, and challenging weak assumptions or redundant system garbage with concrete file/line evidence.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
  {
    role: "security-reviewer",
    name: "Security Reviewer",
    description: "Review vulnerabilities, data handling, trust boundaries and architecture risks.",
    file: "peers/SECURITY_REVIEWER.md",
    tier: "feature",
    workflow: `Focus on trust boundaries, authentication/authorization, input validation, secret handling and security risks with concrete input/logic/output evidence.\n\n${DEFAULT_WORKFLOWS.peer.trim()}`,
  },
] as const;

export function defaultPromptFiles(): Array<{ relativePath: string; markdown: string }> {
  return DEFAULT_ROLES.map((definition) => ({
    relativePath: definition.file,
    // Each .slp file is the editable system prompt for that role; peer YAML front matter is the summary injected into the Lead.
    // Root roles have no tier; peers declare one so the Lead's catalog shows where each may be scheduled.
    markdown: `---\nrole: ${definition.role}\nname: ${definition.name}\ndescription: ${definition.description}\nmodel:\nthinking:\n${"tier" in definition ? `tier: ${definition.tier}\n` : ""}---\n\n# Workflow\n\n${definition.workflow}\n`,
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
