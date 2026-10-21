// Installs the bundled `slp-manager` skill into a selected project's skill directories
// (<repoPath>/.agents/skills and <repoPath>/.claude/skills) so coding agents working in that
// project understand the 3-tier SLP architecture and can author or edit .slp/*.md role files safely.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUS_SERVER_NAME } from "../../shared/roles";

export const SLP_MANAGER_SKILL_NAME = "slp-manager";
const SKILL_MARKDOWN_FILENAME = "SKILL.md";

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

// Render the complete SKILL.md specification for the `slp-manager` skill so coding agents have
// exact parser rules, domain-grouped peer organization patterns, MCP tool obligations, and role-editing invariants.
export function renderSlpManagerSkillMarkdown(): string {
  return `---
name: ${SLP_MANAGER_SKILL_NAME}
description: Explain the 3-tier SLP (Supervisor-Lead-Peer) orchestration model and design, group, customize, or validate .slp/SUPERVISOR.md, .slp/LEAD.md, .slp/standards/*, and domain-grouped .slp/peers/<group>/*.md role definitions while preserving SLP runtime contracts and MCP tool obligations. Use when the user asks about SLP architecture, .slp configuration, organizing or creating peer role groups, or customizing Supervisor and Lead workflows.
---

# SLP Manager (\`.slp\` Role & Workflow Authoring Guide)

Use this skill whenever the user asks you to explain the SLP (Supervisor–Lead–Peer) orchestration model, design or add peer roles under \`.slp/peers/\`, organize peers into functional groups, or customize \`.slp/SUPERVISOR.md\` and \`.slp/LEAD.md\`.

> **CRITICAL RULE:** At runtime, the SLP engine injects the Markdown body of \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, and \`.slp/peers/**/*.md\` **directly** as the role's \`PROJECT WORKFLOW\` without adding hidden hardcoded contract wrappers. If you edit a \`.slp/*.md\` file and accidentally delete its MCP tool-calling obligations, turn-ending rules, or branch/read-only invariants, **the SLP state machine will stall or break**. Always preserve the mandatory SLP invariants documented below when editing any role.

---

## 1. How the 3-Tier SLP Architecture Works

SLP orchestrates multi-agent software delivery across three runtime tiers (\`supervisor\`, \`master_lead\`, \`peer\`) backed by an SQLite state store and a loopback MCP bus (\`${BUS_SERVER_NAME}\`):

1. **Tier 1 — Supervisor (\`.slp/SUPERVISOR.md\`, runtime role \`supervisor\`):**
   - The single human-facing agent. It stays strictly **READ-ONLY** on the repository.
   - Clarifies requirements with the human and analyzes whether the request is a single task or \`N\` independent features/waves that can run in parallel.
   - Calls \`slp_delegate\` with either \`{ acceptanceCriteria }\` (1 feature) or \`{ tasks: [{ name, acceptanceCriteria, worktree? }], sharedContext? }\` (\`N\` parallel features).
   - For each delegated feature, SLP immediately creates/opens a dedicated Git worktree (\`slp/*\` branch) and spawns a dedicated **Lead**.
   - When all Leads finish and report back, the Supervisor audits the integrated branch (\`slp_list_pipelines\`, \`slp_get_pipeline\`, \`git diff\`) and either calls \`slp_request_rework\` (if evidence is incomplete) or \`slp_present_to_manager\` (which merges into the base branch and presents to the human).

2. **Tier 2 — Lead (\`.slp/LEAD.md\`, runtime role \`master_lead\`):**
   - Runs inside its feature's dedicated Git worktree.
   - Receives the full roster of all sibling Leads and concurrent features being built in parallel (\`agentId\`, \`featureName\`, \`worktreePath\`, \`branch\`, \`acceptanceCriteria\`).
   - **Cross-Lead Alignment:** Uses \`slp_send_peer_message({ toAgentId, message, waitForReply: true })\` to align shared APIs, schemas, routes, and end-to-end flows with sibling Leads during planning, execution, or merge resolution.
   - **Stage Planning:** Receives the **YAML front matter** of every file in \`.slp/peers/**/*.md\` in its \`systemPrompt\` (as the available peer catalog) and calls \`slp_define_pipeline\` to define dynamic stages (\`stages: [{ name, goal, peers: [{ role, task }] }]\`).
   - **Direct Supervision & Forking:** Supervises each stage via \`slp_approve_stage\` or \`slp_stage_rework\`, handles hung peer commands via \`slp_handle_peer_shell\`, merges completed feature branches into the integration branch via \`slp_finalize_pipeline\`, and reports final completion to the Supervisor via \`slp_report\`.

3. **Tier 3 — Stage Peers (\`.slp/peers/**/*.md\`, runtime role \`peer\`):**
   - Every stage Peer runs in the **exact same worktree** as its owning Lead and **forks directly from that Lead's session**, inheriting the Lead's codebase discovery, sibling-Lead contract agreements, and prior stage outcomes without re-investigating from scratch.
   - Peers remain alive across stages of their pipeline so downstream peers (e.g., QA, reviewers, security/performance auditors) can question upstream peers (e.g., architects, engineers) directly via \`slp_send_peer_message\`.
   - Each Peer executes its assigned stage task and submits structured evidence via \`slp_stage_report\` (or escalates blockers via \`slp_escalate\`).

---

## 2. Organizing \`.slp/\` by Functional Groups & Shared Standards

While a brand-new repository is initially seeded with 5 flat default peers (\`DEVELOPER.md\`, \`END_USER_UAT.md\`, \`QA_ENGINEER.md\`, \`REVIEWER.md\`, \`SECURITY_REVIEWER.md\`), **when tailoring \`.slp/\` for any real project, you should analyze the project's domain and organize \`.slp/peers/\` into functional subdirectories** alongside a \`.slp/standards/\` folder for shared engineering and delivery rules.

### Generic Grouped Layout Pattern (Adapt Groups to the Project)

\`\`\`text
.slp/
├── LEAD.md
├── SUPERVISOR.md
├── standards/                              # Shared project rules & delivery maps (ignored by role parser)
│   ├── DELIVERY_ROADMAP.md
│   └── ENGINEERING_STANDARDS.md
└── peers/                                  # Recursively scanned; group specialists by discipline!
    ├── END_USER_UAT.md                     # Keep at peers/END_USER_UAT.md (checked by auto-seeder)
    ├── design/                             # Product, UX, API, or system design specialists
    │   └── PRODUCT_DESIGNER.md
    ├── engineering/                        # Core implementation & architecture specialists
    │   ├── SYSTEM_ARCHITECT.md
    │   ├── BACKEND_ENGINEER.md
    │   ├── FRONTEND_ENGINEER.md
    │   └── INFRA_RELEASE_ENGINEER.md
    ├── quality/                            # Verification, review, security, compliance & perf
    │   ├── CODE_REVIEWER.md
    │   ├── QA_AUTOMATION_ENGINEER.md
    │   ├── PERFORMANCE_ENGINEER.md
    │   └── SECURITY_COMPLIANCE_REVIEWER.md
    ├── research/                           # Algorithm, third-party integration, or spike researchers
    │   └── TECHNICAL_RESEARCHER.md
    └── <domain-group>/                     # Project-specific groups (e.g., data-ml/, billing/, art-audio/)
        └── <DOMAIN_SPECIALIST>.md
\`\`\`

### How to Analyze Any Project and Group Its Peers
When asked to design or upgrade \`.slp\` for a repository:
1. **Inspect the Project's Domain, Tech Stack & Specs First:** Read the project's specification docs (PRD, GDD, RFCs, README), package manifests, and directory structure to identify its real technical boundaries.
2. **Decompose \`.slp/peers/\` into Functional Subdirectories (\`.slp/peers/<group>/\`):**
   - \`engineering/\`: System/software architects and specialized builders matched to the stack (e.g., backend/API, frontend/UI, mobile, database, simulation/gameplay, devops/build).
   - \`quality/\`: Code reviewers, QA engineers, performance engineers, and security/compliance auditors tailored to the project's risks.
   - \`design/\`: Product, UX, domain-model, or system designers who verify specification fidelity.
   - \`research/\`: Technical researchers for complex algorithms, protocols, or external SDK spikes.
   - **Domain-specific groups:** Add groups that fit the specific project type (for example: \`data-ml/\` for AI pipelines, \`billing-ledger/\` for fintech, \`art-audio/\` for games, \`embedded/\` for IoT).
   - Replace the flat starter files (\`DEVELOPER.md\`, \`REVIEWER.md\`, \`QA_ENGINEER.md\`, \`SECURITY_REVIEWER.md\`) once specialized grouped peers cover their responsibilities—**except** always keep \`.slp/peers/END_USER_UAT.md\` at its root path inside \`peers/\` (customize its content in place, because \`loadProjectPrompts\` checks for \`peers/END_USER_UAT.md\` and will re-seed it if moved).
3. **Extract Shared Project Rules into \`.slp/standards/\`:**
   - Put shared coding conventions, architectural boundaries, feature delivery maps, test/performance budgets, and Definition of Done in \`.slp/standards/*.md\`.
   - Have \`SUPERVISOR.md\`, \`LEAD.md\`, and each peer in \`.slp/peers/<group>/*.md\` reference \`.slp/standards/*.md\` so project-wide standards live in one place instead of being duplicated across every peer file.

### Discovery & Validation Constraints (Enforced by \`loadProjectPrompts\`)
- **Ignored Paths:** Only \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, and \`.md\` files inside \`.slp/peers/\` (recursively across all group subdirectories) are parsed as roles. Folders like \`.slp/standards/\` or \`.slp/architecture/\` are ignored by the YAML role parser so reference docs never trigger parser errors.
- **Role ID Normalization:** Role IDs come solely from the YAML \`role\` field (never the folder or filename). \`normalizeRoleId\` trims, lowercases, and replaces spaces or underscores with hyphens:
  - \`"Backend Engineer"\` -> \`"backend-engineer"\`
  - \`"qa_automation_engineer"\` -> \`"qa-automation-engineer"\`
- **Valid Slug Pattern:** Every normalized \`role\` ID must match \`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/\`.
- **Reserved Root IDs:** Peer files under \`.slp/peers/\` **must never** use \`supervisor\`, \`lead\`, or \`master-lead\`. Conversely, \`.slp/SUPERVISOR.md\` must have \`role: supervisor\`, and \`.slp/LEAD.md\` must have \`role: master-lead\` (or \`role: lead\`).
- **No Duplicate Role IDs:** Two files in \`.slp/peers/**\` cannot normalize to the same \`role\` ID; the parser rejects duplicates immediately with both file paths.
- **UAT Role Aliases:** If a pipeline stage requests \`end-user\`, \`uat\`, \`uat-tester\`, or \`end-user-tester\`, SLP resolves it to the configured UAT peer in \`.slp/peers/END_USER_UAT.md\`.

---

## 3. How to Create a New Grouped Peer Role in \`.slp/peers/<group>/<ROLE>.md\`

Create a Markdown file inside the appropriate group folder, e.g., \`.slp/peers/engineering/BACKEND_ENGINEER.md\` or \`.slp/peers/quality/PERFORMANCE_ENGINEER.md\`.

### Required File Structure

\`\`\`markdown
---
role: backend-engineer
name: Backend & API Engineer
description: Implements domain services, data access layers, and API endpoints with automated unit/integration tests and measurable latency/query metrics.
model:
thinking:
domains:
  - domain services and state transitions
  - database schemas, migrations, and query optimization
  - REST/RPC API contracts and validation
skills: []
---

# Workflow

ROLE: Pipeline peer (Backend & API Engineer). Apply this domain workflow to your stage assignment.

## 1. Domain & Engineering Rules
- You are forked directly from your pipeline's Lead in the shared feature worktree and inherit the Lead's codebase investigation, sibling-Lead contract agreements, and prior stage outcomes; build directly on that context instead of re-investigating the repository from scratch.
- Read the stage goal, your brief, the current stage peer roster, prior stage results, and any shared standards under \`.slp/standards/\` (plus any provider skills listed in your front matter \`skills\`) before acting.
- Keep domain logic modular, strongly typed, and unit-testable in isolation from transport or UI layers.
- Work only in the pipeline worktree and only within the permission mode granted to this stage.
- Coordinate shared-file edits and commits directly with fellow peers via \`slp_send_peer_message\`; report any work that remains uncommitted.

## 2. Method Contract (Mandatory in \`slp_stage_report\`)
1. Chosen Method & Problem Mapping: State technique/algorithm/pattern A chosen to solve problem B.
2. Step-by-Step Quantitative Progression: Present input data C -> processing steps -> output D with measured cost/complexity E (latency, memory, query count, test pass counts).
3. Rejected Alternatives & Rationale: Explain which alternative technique F was rejected and why G.

## 3. Shared SLP Peer Protocol
- When your work and evidence are ready, call \`slp_stage_report\` with structured findings and status (\`completed\` or \`blocked\`).
- Do not approve the stage yourself. The Lead independently decides whether the evidence meets the goal and either approves or requests rework.
- Communicate with other agents only through MCP tools from server "${BUS_SERVER_NAME}". Never use the paseo CLI, curl, or an external messaging path.
- Pipeline definitions, stage reports and communication history live in SQLite. Read them with the available \`slp_\` tools; read-only queries do not end your turn.
- STRICT TECHNICAL METRICS & INPUT/LOGIC/OUTPUT RULE (MANDATORY): Every technical communication (\`slp_send_peer_message\`, \`slp_stage_report\`) MUST be backed by concrete metrics and technical data. For every function, feature or logic block discussed or delivered, explicitly state: (1) the exact logic/mechanism, (2) the expected input parameters/data/preconditions, and (3) the expected output data/metrics (or exact observable runtime outcome/state transition). Vague prose without concrete input/logic/output or runtime outcome evidence is strictly prohibited.
- CROSS-STAGE PEER LIFECYCLE: Stage peers remain alive across all stages of a pipeline until integration. Use \`slp_send_peer_message\` to question peers from current or earlier stages or your Lead when upstream contracts are unclear.
- LOCAL BRANCH HYGIENE & NO REMOTE PUSH: Pipeline branches (\`slp/*\`) are strictly temporary local branches. Never run \`git push\` or publish temporary branches to any remote.
- After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN.
\`\`\`

### Front-Matter Field Reference for \`.slp/peers/<group>/*.md\`
1. \`role\` *(required, non-empty string)*: Normalized to lowercase hyphenated slug (e.g., \`backend-engineer\`). This is the exact ID the Lead passes in \`slp_define_pipeline\` -> \`peers: [{ role: "backend-engineer", task: "..." }]\`.
2. \`description\` *(required, non-empty string)*: Concise summary of when the Lead should schedule this peer and what it owns.
3. \`name\` *(optional, non-empty string)*: Human-friendly display title. Defaults to \`role\` if omitted.
4. \`model\` *(optional, string or empty)*:
   - Leave empty (\`model:\`) to inherit the run's Peer model configuration.
   - **Important Fork Constraint:** Because stage peers fork directly from their owning Lead's session, any \`model\` specified in \`.slp/peers/**/*.md\` **must belong to the Lead's provider** (e.g., if Lead runs on \`claude/*\`, a peer can specify \`claude-sonnet-4-6\` or \`claude/claude-opus-4-6\`). If a peer specifies a model from a different provider or an unknown model, SLP automatically falls back to the global Peer model config.
5. \`thinking\` *(optional, string or empty)*: Reasoning effort option ID (e.g., \`low\`, \`medium\`, \`high\`). Leave empty to inherit.
6. **Custom Metadata Keys (\`domains\`, \`skills\`, \`features\`, etc.)** *(recommended)*: \`FrontMatterSchema\` preserves arbitrary extra YAML keys. Because the **entire raw YAML front matter block** of every peer is injected into the Lead's \`systemPrompt\` under \`AVAILABLE PROJECT PEERS\`, listing \`domains:\` (spec sections/modules owned) and \`skills:\` (provider skills the peer uses) helps the Lead assemble the exact right specialist team for each stage!

---

## 4. Rules for Editing \`.slp/SUPERVISOR.md\` and \`.slp/LEAD.md\` Safely

When customizing \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, or peer files (for example: tying them to a project's delivery roadmap in \`.slp/standards/\`, setting parallel wave rules, or defining recommended stage templates using your grouped peers), **you must preserve the core SLP protocol mechanics**.

### Mandatory Checklist When Editing \`.slp/SUPERVISOR.md\`
1. **Front Matter:** Keep \`role: supervisor\` and a non-empty \`description\`. (\`model\` in \`SUPERVISOR.md\` can be a short model ID or a full \`provider/model\` ID).
2. **Read-Only Invariant:** Supervisor must remain **READ-ONLY** on the repository (it never edits source files or commits code directly).
3. **Delegation Tool (\`slp_delegate\`):** Preserve instructions to decompose requests into 1 cohesive task (\`{ acceptanceCriteria }\`) or \`N\` parallel features (\`{ tasks: [{ name, acceptanceCriteria }], sharedContext? }\`) via \`slp_delegate\`, passing shared standards/contracts in \`sharedContext\`.
4. **Verification & Completion Tools:** Preserve instructions to inspect pipelines with \`slp_list_pipelines\`, \`slp_get_pipeline\`, \`slp_get_run\`, and \`git diff\`, revive stalled agents with \`slp_revive_agent\`, reject incomplete work with \`slp_request_rework\`, and accept verified work with \`slp_present_to_manager\`.
5. **Turn Termination Rule:** Keep the instruction: *"After \`slp_delegate\`, \`slp_request_rework\` or \`slp_present_to_manager\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing \`.slp/LEAD.md\`
1. **Front Matter:** Keep \`role: master-lead\` (or \`role: lead\`) and a non-empty \`description\`. Note that changing \`model\` in \`LEAD.md\` to another provider switches the Lead's provider (and affects which peer models are compatible when forking).
2. **Sibling Lead Alignment:** Preserve instructions to inspect concurrent sibling features and align shared contracts/APIs/routes with sibling Leads via \`slp_send_peer_message({ toAgentId, message, waitForReply: true })\`.
3. **Pipeline Definition (\`slp_define_pipeline\`):** Preserve instructions to define stages using role IDs from the \`.slp/peers\` catalog (\`{ pipeline: { name, version, description, stages: [{ name, goal, peers: [{ role, task }] }] } }\`), without inventing a \`systemPrompt\` field inside stage definitions. You can recommend project-specific stage shapes (e.g., \`design-contracts\` -> \`implement\` -> \`verify-and-review\`) referencing your grouped peer role IDs!
4. **Stage Supervision & Lifecycle Tools:** Preserve instructions for:
   - \`slp_approve_stage\` and \`slp_stage_rework\` (reviewing peer reports and diffs),
   - \`slp_handle_peer_shell\` (handling hung peer shell commands flagged by the watchdog),
   - \`slp_finalize_pipeline\` (merging the completed feature worktree branch into the integration branch),
   - \`slp_report\` (reporting the integrated result back to the Supervisor).
5. **No Runtime Spec Files & No Remote Push:** Preserve the rules against creating runtime spec/report files on disk (stored in SQLite) and never running \`git push\` on temporary \`slp/*\` branches.
6. **Turn Termination Rule:** Keep the instruction: *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_handle_peer_shell\`, \`slp_finalize_pipeline\` or \`slp_report\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing Any \`.slp/peers/<group>/*.md\` File
1. **Front Matter:** Ensure \`role\` is unique across all group folders, lowercase-hyphenated compatible, not a reserved root role (\`supervisor\`, \`lead\`, \`master-lead\`), and has a clear \`description\`.
2. **Fork Awareness:** Remind the peer that it forks directly from its Lead in the shared feature worktree and should build on the Lead's investigation rather than re-scanning the entire repo from scratch.
3. **MCP Tool Obligations:** Ensure the workflow instructs the peer to submit its findings via \`slp_stage_report\` (or \`slp_escalate\` when blocked), collaborate with peers/Lead via \`slp_send_peer_message\`, and **never** attempt to approve the stage itself.
4. **Metrics & Evidence Contract:** Keep the requirement to provide concrete Input / Logic / Output metrics (and visual/screenshot evidence for UI/QA roles, or step-by-step methodology + rejected alternatives for engineering roles).
5. **Turn Termination Rule:** Keep the instruction: *"After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN."*

---

## 5. Verification Procedure After Creating or Editing \`.slp\` Files

Whenever you create or modify any file in \`.slp/\`:
1. Verify that every role file under \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, and \`.slp/peers/**/*.md\` starts with \`---\` on line 1 (no leading blank lines) and closes its YAML front matter with \`---\`.
2. Confirm that \`role\` and \`description\` are non-empty strings, YAML keys are unique, and the Markdown body after \`---\` is non-empty.
3. Confirm that no two files across any \`.slp/peers/<group>/\` subdirectories normalize to the same \`role\` slug.
4. Confirm that \`.slp/peers/END_USER_UAT.md\` remains present at \`.slp/peers/END_USER_UAT.md\` so the auto-seeder does not recreate a duplicate UAT file.
5. Confirm that all mandatory \`slp_*\` tool names, \`${BUS_SERVER_NAME}\` transport rules, local-branch hygiene (\`no git push\`), and turn-ending instructions remain intact in the Markdown body.
`;
}

// Write the skill file only when missing or outdated so repeated clicks do not churn disk timestamps unnecessarily.
function writeSkillMarkdownIfChanged(skillMarkdownPath: string, expectedContent: string): void {
  mkdirSync(dirname(skillMarkdownPath), { recursive: true });
  if (existsSync(skillMarkdownPath)) {
    try {
      const existingContent = readFileSync(skillMarkdownPath, "utf8");
      if (existingContent === expectedContent) return;
    } catch {
      // Fall through and rewrite when the existing file cannot be read.
    }
  }
  writeFileSync(skillMarkdownPath, expectedContent, "utf8");
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
  const skillMarkdownContent = renderSlpManagerSkillMarkdown();
  const installedPaths: string[] = [];

  for (const skillRoot of uniqueRoots) {
    const skillMarkdownPath = join(skillRoot, SLP_MANAGER_SKILL_NAME, SKILL_MARKDOWN_FILENAME);
    writeSkillMarkdownIfChanged(skillMarkdownPath, skillMarkdownContent);
    installedPaths.push(skillMarkdownPath);
  }

  return {
    skillName: SLP_MANAGER_SKILL_NAME,
    installedPaths,
  };
}
