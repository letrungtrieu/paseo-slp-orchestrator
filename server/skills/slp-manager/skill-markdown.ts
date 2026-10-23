// SKILL.md body of the `slp-manager` skill: the SLP architecture, .slp role authoring rules and invariants.
// Long project-specific procedures live in sibling reference modules so the always-loaded SKILL.md stays short.
import { BUS_SERVER_NAME } from "../../../shared/roles";
import { SLP_MANAGER_SKILL_NAME } from "./skill-name";

// Render the complete SKILL.md specification for the `slp-manager` skill so coding agents have
// exact parser rules, domain-grouped peer organization patterns, MCP tool obligations, and role-editing invariants.
export function renderSlpManagerSkillMarkdown(): string {
  return `---
name: ${SLP_MANAGER_SKILL_NAME}
description: Explain the 3-tier SLP (Supervisor-Lead-Peer) orchestration model and design, group, customize, or validate .slp/SUPERVISOR.md, .slp/LEAD.md, .slp/QA_LEAD.md, .slp/standards/*, and domain-grouped .slp/peers/<group>/*.md role definitions while preserving SLP runtime contracts and MCP tool obligations. Use when the user asks about SLP architecture, .slp configuration, generating or organizing peer roles for a project, defining test tiers or heavy-resource rules (.slp/standards/TEST_POLICY.md), or customizing Supervisor and Lead workflows.
---

# SLP Manager (\`.slp\` Role & Workflow Authoring Guide)

Use this skill whenever the user asks you to explain the SLP (Supervisor–Lead–Peer) orchestration model, design or add peer roles under \`.slp/peers/\`, organize peers into functional groups, or customize \`.slp/SUPERVISOR.md\` and \`.slp/LEAD.md\`.

> **INVESTIGATE BEFORE YOU GENERATE:** Never generate or regroup \`.slp/peers/\` from generic templates. First run the mandatory project investigation in \`references/PROJECT_INVESTIGATION.md\` (tech stack, how unit tests are written and run, how manual testing is done, which tools are heavy), write \`.slp/standards/TEST_POLICY.md\` from \`references/TEST_POLICY_TEMPLATE.md\`, and only then derive peers from those findings (\`references/STACK_PLAYBOOKS.md\` lists stack-specific starting points).

> **CRITICAL RULE:** At runtime, the SLP engine injects the Markdown body of \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\`, and \`.slp/peers/**/*.md\` **directly** as the role's \`PROJECT WORKFLOW\` without adding hidden hardcoded contract wrappers. If you edit a \`.slp/*.md\` file and accidentally delete its MCP tool-calling obligations, turn-ending rules, or branch/read-only invariants, **the SLP state machine will stall or break**. Always preserve the mandatory SLP invariants documented below when editing any role.

---

## 1. How the 3-Tier SLP Architecture Works

SLP orchestrates multi-agent software delivery across three runtime tiers (\`supervisor\`, \`master_lead\`, \`peer\`) backed by an SQLite state store and a loopback MCP bus (\`${BUS_SERVER_NAME}\`):

1. **Tier 1 — Supervisor (\`.slp/SUPERVISOR.md\`, runtime role \`supervisor\`):**
   - The single human-facing agent. It stays strictly **READ-ONLY** on the repository.
   - Clarifies requirements with the human and analyzes whether the request is a single task or \`N\` independent features/waves that can run in parallel.
   - **Owns the product spec:** for every feature it drafts screens/surfaces and their elements, states (empty, loading, success, error, disabled), Given/When/Then interactions, business rules and out-of-scope items, gets the human's explicit approval, and passes it as \`productSpec\` (\`slp_delegate\` rejects features without one). Leads implement it as a contract; the QA Lead turns every scenario into a test case.
   - Calls \`slp_delegate\` with the human-approved \`productSpec\` for every feature: \`{ acceptanceCriteria, productSpec }\` for one feature, or \`{ tasks: [{ name, acceptanceCriteria, productSpec, worktree? }], sharedContext? }\` for \`N\` parallel features. The engine rejects the whole delegation if any feature lacks a \`productSpec\` of at least 80 characters.
   - For each delegated feature, SLP immediately creates/opens a dedicated Git worktree (\`slp/*\` branch) and spawns a dedicated **Lead**. Every delegation also creates one **QA worktree** (the run's integration branch) and spawns one **QA Lead** in it.
   - When the QA Lead reports the verified QA branch, the Supervisor audits the integrated branch (\`slp_list_pipelines\`, \`slp_get_pipeline\`, \`git diff\`) and either calls \`slp_request_rework\` (if evidence is incomplete) or \`slp_present_to_manager\` (which merges the QA branch into the base branch and presents to the human). Rework requests go to the QA Lead.

2. **Tier 2 — Lead (\`.slp/LEAD.md\`, runtime role \`master_lead\`):**
   - Runs inside its feature's dedicated Git worktree.
   - Receives the full roster of all sibling Leads and concurrent features being built in parallel (\`agentId\`, \`featureName\`, \`worktreePath\`, \`branch\`, \`acceptanceCriteria\`).
   - Receives its own human-approved \`productSpec\` as the implementation contract, plus the QA Lead's id and the QA branch it merges into. Implement the spec's screens, states and scenarios exactly; record any deviation with its reason in the \`slp_finalize_pipeline\` summary.
   - **Cross-Lead Alignment:** Uses \`slp_ask({ toAgentId, question })\` (blocking; the answer is returned by the call) to align shared APIs, schemas, routes, and end-to-end flows with sibling Leads during planning, execution, or merge resolution.
   - **Stage Planning:** Receives the **YAML front matter** of every file in \`.slp/peers/**/*.md\` in its \`systemPrompt\` (as the available peer catalog) and calls \`slp_define_pipeline\` to define dynamic stages (\`stages: [{ name, goal, peers: [{ role, task }] }]\`).
   - **Direct Supervision & Forking:** Supervises each stage via \`slp_approve_stage\` or \`slp_stage_rework\`, handles hung peer commands via \`slp_handle_peer_shell\`, and merges its completed feature branch into the QA branch via \`slp_finalize_pipeline\` (resolving merge conflicts there). Feature Leads never report to the Supervisor and never run heavy verification; they are retired once every feature is merged.

   **QA Lead (\`.slp/QA_LEAD.md\`, runtime role \`qa_lead\`):**
   - Spawned together with the feature Leads and briefed with the same requirements plus the full Lead roster, so it prepares the QA plan (unit, automation and manual testing per \`TEST_POLICY.md\`) while features are built.
   - **Read-only:** file writes and mutating shell commands are denied; every test run, investigation and fix is done by stage peers it spawns.
   - \`slp_define_pipeline\` is rejected until the engine hands over the merged QA branch (after the last feature merge). QA pipelines always run in the QA worktree, one at a time, and their peers fork from the QA Lead's session.
   - Closes the approved QA pipeline with \`slp_finalize_pipeline\` (no merge), then calls \`slp_report\`, which is only accepted after a QA pipeline closed after the last feature merge.

3. **Tier 3 — Stage Peers (\`.slp/peers/**/*.md\`, runtime role \`peer\`):**
   - Every stage Peer runs in the **exact same worktree** as its owning Lead (feature Lead or QA Lead) and **forks directly from that Lead's session**, inheriting the Lead's codebase discovery, sibling-Lead contract agreements, and prior stage outcomes without re-investigating from scratch.
   - Peers remain alive across stages of their pipeline so downstream peers (e.g., QA, reviewers, security/performance auditors) can question upstream peers (e.g., architects, engineers) directly via \`slp_ask\`.
   - Each Peer executes its assigned stage task and submits structured evidence via \`slp_stage_report\` (or escalates blockers via \`slp_escalate\`).

---

## 2. Organizing \`.slp/\` by Functional Groups & Shared Standards

While a brand-new repository is initially seeded with 4 flat default peers (\`DEVELOPER.md\`, \`QA_ENGINEER.md\`, \`REVIEWER.md\`, \`SECURITY_REVIEWER.md\`), **when tailoring \`.slp/\` for any real project, you should analyze the project's domain and organize \`.slp/peers/\` into functional subdirectories** alongside a \`.slp/standards/\` folder for shared engineering and delivery rules.

### Generic Grouped Layout Pattern (Adapt Groups to the Project)

\`\`\`text
.slp/
├── LEAD.md
├── QA_LEAD.md                              # QA Lead: verifies the merged QA branch through spawned peers
├── SUPERVISOR.md
├── standards/                              # Shared project rules & delivery maps (ignored by role parser)
│   ├── DELIVERY_ROADMAP.md
│   ├── ENGINEERING_STANDARDS.md
│   └── TEST_POLICY.md                      # REQUIRED: test tiers, heavy resources, unit/manual test conventions
└── peers/                                  # Recursively scanned; group specialists by discipline!
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
1. **Run the Mandatory Project Investigation First:** Follow \`references/PROJECT_INVESTIGATION.md\` end to end. It requires evidence (file paths, commands actually run, timings, memory) for the tech stack, the unit-test conventions already used in the repo, the manual-test practice, and the heavy resources. Write the result to \`.slp/standards/TEST_POLICY.md\` using \`references/TEST_POLICY_TEMPLATE.md\`. Every later step derives from that file, not from generic templates.
2. **Decompose \`.slp/peers/\` into Functional Subdirectories (\`.slp/peers/<group>/\`):**
   - \`engineering/\`: System/software architects and specialized builders matched to the stack (e.g., backend/API, frontend/UI, mobile, database, simulation/gameplay, devops/build).
   - \`quality/\`: Code reviewers, QA engineers, performance engineers, and security/compliance auditors tailored to the project's risks.
   - \`design/\`: Product, UX, domain-model, or system designers who verify specification fidelity.
   - \`research/\`: Technical researchers for complex algorithms, protocols, or external SDK spikes.
   - **Domain-specific groups:** Add groups that fit the specific project type (for example: \`data-ml/\` for AI pipelines, \`billing-ledger/\` for fintech, \`art-audio/\` for games, \`embedded/\` for IoT).
   - Replace the flat starter files (\`DEVELOPER.md\`, \`REVIEWER.md\`, \`QA_ENGINEER.md\`, \`SECURITY_REVIEWER.md\`) once specialized grouped peers cover their responsibilities. Delete any legacy \`.slp/peers/END_USER_UAT.md\` (role \`end-user\`) left by older SLP versions: verifying the merged build is the QA Lead's job, so a separate UAT peer only duplicates it.
3. **Assign a Test Tier to Every Peer (\`tier:\` front matter):** Peers that build or review code inside parallel feature pipelines get \`tier: feature\` and may run only the \`fast\` commands of \`TEST_POLICY.md\`. Peers whose work needs an engine, emulator, container stack, browser E2E or a real-environment manual test get \`tier: integration\`; they are scheduled only after all feature branches are merged, never inside a feature pipeline. Write each peer's test instructions from the exact commands, frameworks, folders and naming conventions recorded in \`TEST_POLICY.md\`.
4. **Extract Shared Project Rules into \`.slp/standards/\`:**
   - Put shared coding conventions, architectural boundaries, feature delivery maps, test/performance budgets, and Definition of Done in \`.slp/standards/*.md\`.
   - Have \`SUPERVISOR.md\`, \`LEAD.md\`, \`QA_LEAD.md\`, and each peer in \`.slp/peers/<group>/*.md\` reference \`.slp/standards/*.md\` so project-wide standards live in one place instead of being duplicated across every peer file.

### Discovery & Validation Constraints (Enforced by \`loadProjectPrompts\`)
- **Ignored Paths:** Only \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\`, and \`.md\` files inside \`.slp/peers/\` (recursively across all group subdirectories) are parsed as roles. Folders like \`.slp/standards/\` or \`.slp/architecture/\` are ignored by the YAML role parser so reference docs never trigger parser errors.
- **Role ID Normalization:** Role IDs come solely from the YAML \`role\` field (never the folder or filename). \`normalizeRoleId\` trims, lowercases, and replaces spaces or underscores with hyphens:
  - \`"Backend Engineer"\` -> \`"backend-engineer"\`
  - \`"qa_automation_engineer"\` -> \`"qa-automation-engineer"\`
- **Valid Slug Pattern:** Every normalized \`role\` ID must match \`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/\`.
- **Reserved Root IDs:** Peer files under \`.slp/peers/\` **must never** use \`supervisor\`, \`lead\`, \`master-lead\`, or \`qa-lead\`. Conversely, \`.slp/SUPERVISOR.md\` must have \`role: supervisor\`, \`.slp/QA_LEAD.md\` must have \`role: qa-lead\` (it is re-seeded when missing), and \`.slp/LEAD.md\` must have \`role: master-lead\` (or \`role: lead\`).
- **No Duplicate Role IDs:** Two files in \`.slp/peers/**\` cannot normalize to the same \`role\` ID; the parser rejects duplicates immediately with both file paths.

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
tier: feature
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
- TEST TIER: You are a \`tier: feature\` peer. Write unit tests following the conventions in \`.slp/standards/TEST_POLICY.md\` and run ONLY its \`fast\` tier commands. Never start a heavy resource listed there (engine editor, emulator, container stack, browser E2E); record anything that needs one as a hand-off item for the integration QA pipeline in \`slp_stage_report\`.
- Work only in the pipeline worktree and only within the permission mode granted to this stage.
- Coordinate shared-file edits and commits directly with fellow peers via \`slp_ask\` / \`slp_notify\`; report any work that remains uncommitted.

## 2. Method Contract (Mandatory in \`slp_stage_report\`)
1. Chosen Method & Problem Mapping: State technique/algorithm/pattern A chosen to solve problem B.
2. Step-by-Step Quantitative Progression: Present input data C -> processing steps -> output D with measured cost/complexity E (latency, memory, query count, test pass counts).
3. Rejected Alternatives & Rationale: Explain which alternative technique F was rejected and why G.

## 3. Shared SLP Peer Protocol
- When your work and evidence are ready, call \`slp_stage_report\` with structured findings and status (\`completed\` or \`blocked\`).
- Do not approve the stage yourself. The Lead independently decides whether the evidence meets the goal and either approves or requests rework.
- Communicate with other agents only through MCP tools from server "${BUS_SERVER_NAME}". Never use the paseo CLI, curl, or an external messaging path.
- Pipeline definitions, stage reports and communication history live in SQLite. Read them with the available \`slp_\` tools; read-only queries do not end your turn.
- STRICT TECHNICAL METRICS & INPUT/LOGIC/OUTPUT RULE (MANDATORY): Every technical communication (\`slp_ask\`, \`slp_answer\`, \`slp_notify\`, \`slp_stage_report\`) MUST be backed by concrete metrics and technical data. For every function, feature or logic block discussed or delivered, explicitly state: (1) the exact logic/mechanism, (2) the expected input parameters/data/preconditions, and (3) the expected output data/metrics (or exact observable runtime outcome/state transition). Vague prose without concrete input/logic/output or runtime outcome evidence is strictly prohibited.
- CROSS-STAGE PEER LIFECYCLE: Stage peers remain alive across all stages of a pipeline until integration. Use \`slp_ask\` to question peers from current or earlier stages or your Lead when upstream contracts are unclear.
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
6. \`tier\` *(required for every generated peer: \`feature\` or \`integration\`)*: Tells the Lead where the peer may be scheduled. \`feature\` peers run inside parallel feature pipelines and execute only \`fast\` tier tests; \`integration\` peers run only in the final QA pipeline on the merged integration branch, where heavy resources are used one at a time. The value is injected into the Lead's peer catalog with the rest of the front matter.
7. **Custom Metadata Keys (\`domains\`, \`skills\`, \`features\`, etc.)** *(recommended)*: \`FrontMatterSchema\` preserves arbitrary extra YAML keys. Because the **entire raw YAML front matter block** of every peer is injected into the Lead's \`systemPrompt\` under \`AVAILABLE PROJECT PEERS\`, listing \`domains:\` (spec sections/modules owned) and \`skills:\` (provider skills the peer uses) helps the Lead assemble the exact right specialist team for each stage!

---

## 4. Rules for Editing \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\` and \`.slp/QA_LEAD.md\` Safely

When customizing \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, or peer files (for example: tying them to a project's delivery roadmap in \`.slp/standards/\`, setting parallel wave rules, or defining recommended stage templates using your grouped peers), **you must preserve the core SLP protocol mechanics**.

### Mandatory Checklist When Editing \`.slp/SUPERVISOR.md\`
1. **Front Matter:** Keep \`role: supervisor\` and a non-empty \`description\`. (\`model\` in \`SUPERVISOR.md\` can be a short model ID or a full \`provider/model\` ID).
2. **Read-Only Invariant:** Supervisor must remain **READ-ONLY** on the repository (it never edits source files or commits code directly).
3. **Delegation Tool (\`slp_delegate\`):** Preserve instructions to decompose requests into 1 cohesive task (\`{ acceptanceCriteria, productSpec }\`) or \`N\` parallel features (\`{ tasks: [{ name, acceptanceCriteria, productSpec }], sharedContext? }\`) via \`slp_delegate\`, passing shared standards/contracts in \`sharedContext\`. Every feature must carry its human-approved \`productSpec\`; a delegation without one is rejected.
4. **Verification & Completion Tools:** Preserve instructions to inspect pipelines with \`slp_list_pipelines\`, \`slp_get_pipeline\`, \`slp_get_run\`, and \`git diff\`, revive stalled agents with \`slp_revive_agent\`, reject incomplete work with \`slp_request_rework\`, and accept verified work with \`slp_present_to_manager\`.
5. **Product Spec Before Delegation:** Preserve the five-section product spec template (screens and elements, states, Given/When/Then interactions, business rules, out of scope), the rule to get explicit human approval first, and passing it unchanged as \`productSpec\`. Adapt the section names to the project (for example HUD, input and feedback for games; endpoints and payloads for APIs) but keep the scenarios.
6. **Turn Termination Rule:** Keep the instruction: *"After \`slp_delegate\`, \`slp_request_rework\` or \`slp_present_to_manager\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing \`.slp/LEAD.md\`
1. **Front Matter:** Keep \`role: master-lead\` (or \`role: lead\`) and a non-empty \`description\`. Note that changing \`model\` in \`LEAD.md\` to another provider switches the Lead's provider (and affects which peer models are compatible when forking).
2. **Sibling Lead Alignment:** Preserve instructions to inspect concurrent sibling features and align shared contracts/APIs/routes with sibling Leads via \`slp_ask({ toAgentId, question })\`.
3. **Pipeline Definition (\`slp_define_pipeline\`):** Preserve instructions to define stages using role IDs from the \`.slp/peers\` catalog (\`{ pipeline: { name, version, description, stages: [{ name, goal, peers: [{ role, task }] }] } }\`), without inventing a \`systemPrompt\` field inside stage definitions. You can recommend project-specific stage shapes (e.g., \`design-contracts\` -> \`implement\` -> \`verify-and-review\`) referencing your grouped peer role IDs!
4. **Stage Supervision & Lifecycle Tools:** Preserve instructions for:
   - \`slp_approve_stage\` and \`slp_stage_rework\` (reviewing peer reports and diffs),
   - \`slp_handle_peer_shell\` (handling hung peer shell commands flagged by the watchdog),
   - \`slp_finalize_pipeline\` (merging the completed feature worktree branch into the QA branch). Feature Leads do not have \`slp_report\`; do not instruct them to report.
5. **Test Tier Policy:** Keep the rule that feature pipelines schedule only \`tier: feature\` peers and run only the \`fast\` tier of \`.slp/standards/TEST_POLICY.md\`, leaving \`engine\`/\`integration\` tier work to the final QA pipeline after all feature branches are merged.
6. **No Runtime Spec Files & No Remote Push:** Preserve the rules against creating runtime spec/report files on disk (stored in SQLite) and never running \`git push\` on temporary \`slp/*\` branches.
7. **Turn Termination Rule:** Keep the instruction: *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_handle_peer_shell\` or \`slp_finalize_pipeline\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing \`.slp/QA_LEAD.md\`
1. **Front Matter:** Keep \`role: qa-lead\` and a non-empty \`description\`. A \`model\` here applies to the QA Lead only; keep it on the Lead provider so QA peers can fork its session.
2. **Two Phases:** Preserve the preparation phase (study unit, automation and manual testing from \`TEST_POLICY.md\`, ask feature Leads, do NOT define a pipeline) and the post-handover phase (define the QA pipeline over the merged QA branch, omitting \`worktree\`).
3. **Never Edit Code:** Preserve the rule that the QA Lead only spawns peers for testing and fixing; the runtime denies its writes anyway, so instructions to edit would stall it.
4. **Project-Specific QA Stages:** Describe the stage shape from the investigation (for example build and fast suites -> engine/E2E suites -> real-environment manual journeys -> fix and re-verify), referencing \`tier: integration\` peers, and never two peers using the same heavy resource in one stage.
5. **Close Then Report:** Keep \`slp_finalize_pipeline\` (closes the QA pipeline, nothing is merged) followed by \`slp_report\`, and the instruction that Supervisor rework arrives here as a new QA pipeline with a new name.
6. **Turn Termination Rule:** Keep the instruction: *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_handle_peer_shell\`, \`slp_finalize_pipeline\` or \`slp_report\` succeeds, END YOUR TURN."*

### Mandatory Checklist When Editing Any \`.slp/peers/<group>/*.md\` File
1. **Front Matter:** Ensure \`role\` is unique across all group folders, lowercase-hyphenated compatible, not a reserved root role (\`supervisor\`, \`lead\`, \`master-lead\`, \`qa-lead\`), and has a clear \`description\`.
2. **Fork Awareness:** Remind the peer that it forks directly from its Lead in the shared feature worktree and should build on the Lead's investigation rather than re-scanning the entire repo from scratch.
3. **MCP Tool Obligations:** Ensure the workflow instructs the peer to submit its findings via \`slp_stage_report\` (or \`slp_escalate\` when blocked), collaborate with peers/Lead via \`slp_ask\` / \`slp_notify\` and answer incoming questions with \`slp_answer\`, and **never** attempt to approve the stage itself.
4. **Metrics & Evidence Contract:** Keep the requirement to provide concrete Input / Logic / Output metrics (and visual/screenshot evidence for UI/QA roles, or step-by-step methodology + rejected alternatives for engineering roles).
5. **Test Tier:** Ensure \`tier\` is \`feature\` or \`integration\` and that the workflow names the exact test commands, folders and conventions from \`.slp/standards/TEST_POLICY.md\` allowed for that tier.
6. **Turn Termination Rule:** Keep the instruction: *"After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN."*

---

## 5. Verification Procedure After Creating or Editing \`.slp\` Files

Whenever you create or modify any file in \`.slp/\`:
1. Verify that every role file under \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\`, and \`.slp/peers/**/*.md\` starts with \`---\` on line 1 (no leading blank lines) and closes its YAML front matter with \`---\`.
2. Confirm that \`role\` and \`description\` are non-empty strings, YAML keys are unique, and the Markdown body after \`---\` is non-empty.
3. Confirm that no two files across any \`.slp/peers/<group>/\` subdirectories normalize to the same \`role\` slug.
4. Confirm that \`.slp/standards/TEST_POLICY.md\` exists, every command in its \`fast\` tier was actually run during the investigation (with measured time and peak memory), and every heavy resource lists its process signatures.
5. Confirm that every peer declares \`tier: feature\` or \`tier: integration\`, that no \`feature\` peer is instructed to run an \`engine\` or \`integration\` tier command, and that each peer's test instructions match the conventions recorded in \`TEST_POLICY.md\`.
6. Confirm that all mandatory \`slp_*\` tool names, \`${BUS_SERVER_NAME}\` transport rules, local-branch hygiene (\`no git push\`), and turn-ending instructions remain intact in the Markdown body.

## 6. Upgrading an Existing \`.slp\` to the Current Structure

Run this checklist when a project's \`.slp\` was generated before the current engine. Old files still load, but their instructions no longer match the flow:

1. **Supervisor:** every \`slp_delegate\` call needs the human-approved \`productSpec\` (see Tier 1). Remove any instruction to call \`slp_report\` or to wait for a feature Lead's report; only the QA Lead reports.
2. **Lead (\`.slp/LEAD.md\`):** remove every instruction to call \`slp_report\`, to spawn an End-User UAT pipeline, or to merge into the base branch. A feature Lead's last duty is \`slp_finalize_pipeline\` into the QA branch; the engine then hands verification to the QA Lead.
3. **QA Lead (\`.slp/QA_LEAD.md\`):** the plugin re-seeds this file when it is missing. Customize it in place and keep its two phases; never put QA stages into \`LEAD.md\`.
4. **Peers:** add \`tier: feature\` or \`tier: integration\` to every peer's front matter, as decided by the investigation. Feature-tier peers may run only the \`fast\` tier of \`TEST_POLICY.md\`.
5. **Legacy \`.slp/peers/END_USER_UAT.md\`:** read it first and move any project-specific journeys into the QA Lead's plan or into an \`integration\` tier peer. Delete the file only after the human confirms, and remove or rename every reference to the \`end-user\` role with it.
6. **Standards:** create \`.slp/standards/TEST_POLICY.md\` from the investigation. Without it, feature pipelines have no test-tier boundary.

After the edits, run the verification procedure in section 5 and list every changed file for the human.
`;
}
