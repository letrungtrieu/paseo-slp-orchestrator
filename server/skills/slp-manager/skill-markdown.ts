// SKILL.md body of the `slp-manager` skill: the SLP architecture, .slp role authoring rules and invariants.
// Long project-specific procedures and the advisor/QA templates live in sibling reference modules so the
// always-loaded SKILL.md stays short; the developer template stays here because it is the canonical example.
import { SLP_CONTRACT_VERSION } from "../../../shared/project-prompts";
import { BUS_SERVER_NAME } from "../../../shared/roles";
import { SLP_MANAGER_SKILL_NAME } from "./skill-name";

// The text mirrors the engine contract (peer kinds, one developer, Kanban Spec/Brief board, peer pause/resume, scorecards, rework cap),
// so it must change together with stage-shape.ts, stage-messages.ts, board-tools.ts, peer-pause.ts and the bus tool catalogue.
export function renderSlpManagerSkillMarkdown(): string {
  return `---
name: ${SLP_MANAGER_SKILL_NAME}
description: Explain the SLP (Supervisor-Lead-Peer) orchestration model and design, group, customize, upgrade or validate .slp/SUPERVISOR.md, .slp/LEAD.md, .slp/QA_LEAD.md, .slp/standards/* and .slp/peers/<group>/*.md for the current engine (peer kinds advisor/developer/qa, one developer per pipeline, project Kanban Spec/Brief board with revision diffs, peer pause/resume, QA scorecards, rework cap). Use when the user asks about SLP architecture, .slp configuration, generating or organizing peer roles, test tiers and heavy resources (.slp/standards/TEST_POLICY.md), or customizing Supervisor and Lead workflows.
---

# SLP Manager (\`.slp\` Role & Workflow Authoring Guide)

Use this skill whenever the user asks you to explain the SLP (Supervisor–Lead–Peer) orchestration model, design or add peer roles under \`.slp/peers/\`, organize peers into functional groups, customize \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\` or \`.slp/QA_LEAD.md\`, or upgrade an older \`.slp\`.

> **INVESTIGATE BEFORE YOU GENERATE:** Never generate or regroup \`.slp/peers/\` from generic templates. First run the project investigation in \`references/PROJECT_INVESTIGATION.md\` (tech stack, how unit tests are written and run, how manual testing is done, which tools are heavy), write \`.slp/standards/TEST_POLICY.md\` from \`references/TEST_POLICY_TEMPLATE.md\`, and only then derive peers from those findings (\`references/STACK_PLAYBOOKS.md\` lists stack-specific starting points, \`references/PEER_TEMPLATES.md\` holds the advisor and QA grader templates).

> **Invariant:** At runtime, the SLP engine injects the Markdown body of \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\`, and \`.slp/peers/**/*.md\` **directly** as the role's \`PROJECT WORKFLOW\` without hidden wrappers. If an edit deletes a role's MCP tool obligations, turn-ending rules or read-only invariants, **the SLP state machine stalls**. Preserve the invariants in section 4 whenever you edit a role.

> **WHY THE CURRENT MODEL EXISTS:** Agents used to over-engineer: several peers wrote code in one worktree, peers chatted with each other and widened the scope, and prompts full of "MANDATORY" rules made models over-apply them. The engine now enforces a small contract (section 1). Generated \`.slp\` files must describe that contract, never fight it. Write instructions in a calm voice ("Do X when Y"); do not use MANDATORY/MUST/STRICT walls, "enumerate all edge cases" or "always present rejected alternatives".

---

## 0. When the User Says "update"

After this skill changes, the user often just says *update* (or *cập nhật*). Bring every \`.slp\` file in this repository in line with the contract below, and leave alone what the project has customized on purpose.

**Contract version:** \`${SLP_CONTRACT_VERSION}\`. Every file the engine seeds, and every file you update, carries \`slp-contract: ${SLP_CONTRACT_VERSION}\` in its front matter. A file without that line predates this contract.

1. **Read this whole file**, sections 1 to 6, and the references it names. Do not update from memory of an earlier version.
2. **Inventory** \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\`, every \`.slp/peers/**/*.md\` and \`.slp/standards/*\`. Note each file's \`slp-contract\` value.
3. **Check every file, stamped or not.** A stamp says when the file was last brought up to date, not that it still matches. A user may have edited it since.
4. **Fix only what contradicts the contract:** a missing tool obligation, a stage shape the engine rejects, a removed turn rule, a tool name that does not exist, a mockup step that belongs to the retired flow. Apply the checklist for that role in section 4, and the peer checklist for peers.
5. **Keep project-specific content:** peer groups, domains, stack commands, references to standards, custom front-matter keys and the project's tone. Edit in place; do not rewrite a file wholesale.
6. **Apply section 6** for anything older than the current contract, and check the front-matter fields in section 3 (\`kind\`, \`tier\`, \`role\`) for every peer that lacks them.
7. **Stamp** every file you changed with \`slp-contract: ${SLP_CONTRACT_VERSION}\`.
8. **Verify** with section 5.
9. **Report** every changed file and the reason; each contradiction you kept on purpose; and each decision you could not make without the user, such as two peers whose responsibilities now overlap. Ask instead of guessing.

This skill is installed from the plugin. Its own file is refreshed by the plugin's skill initialization, so do not edit \`SKILL.md\` in place; if it is stale, ask the user to run that initialization again.

---

## 1. How the 3-Tier SLP Architecture Works

SLP orchestrates software delivery across three tiers and four runtime roles (\`supervisor\`, \`master_lead\`, \`qa_lead\`, \`peer\`), backed by an SQLite state store, a project-scoped **Mockup, Spec & Brief Kanban Board** (\`MOCKUP -> SPEC -> BRIEF -> SCORE -> REWORK -> DONE\`), and a loopback MCP bus (\`${BUS_SERVER_NAME}\`):

**Before any Run — Product Agent (standalone, no \`.slp\` file):** new work starts here, not with a Supervisor. The human opens a **Product Agent** from the Kanban board (\`+ New Feature\`, or \`Discuss with Agent\` on a card). It runs outside any Run with the tools \`slp_board_list_tickets\`, \`slp_board_get_ticket\`, \`slp_board_save_spec\` and \`slp_board_set_mockup\`, and may write only inside \`.slp/mockup/\`.

   - **Mockup ownership:** only the Product Agent creates or edits mockups. The permission policy refuses every write to \`.slp/mockup/\` (and the older \`.slp/mockups/\`) from a Supervisor, Lead, QA Lead or peer, and refuses shell commands that name those folders unless they only read. It only sees agents whose permission mode asks for approval, so agents in \`bypassPermissions\` mode are bound by the prompt rule alone. No Run, pipeline or peer task may exist to make or change a mockup; roles read the approved mockup as the UI contract and escalate when it is wrong. The engine adds this rule to every role's system prompt itself, so older \`.slp\` files are bound by it too.
   - **Model:** the Product Agent has its own provider, model, thinking and permission setting under Agent settings (listed first, before the Supervisor). Until one is chosen it borrows the Supervisor's. No \`.slp\` file configures it.
   - **Mockup first:** for anything with a UI it builds the idea as a git-tracked set of files. \`.slp/mockup/<feature>.html\` is only an index that loads files with plain \`<link>\` and \`<script src>\` tags. The feature's own \`.js\` and \`.css\` live in \`.slp/mockup/features/<feature>/\`, and shared style and logic live in \`.slp/mockup/core/\` with images in \`.slp/mockup/assets/\`. Inline \`<script>\` or \`<style>\` code in the index is refused. Git holds the history; there are no version folders.
   - **Review loop:** \`slp_board_set_mockup({ ticketId?, title?, file, summary })\` links the file to its card. The human previews it in the \`1. MOCKUP\` column, attaches element-level comments, and sends them to the agent, which revises the file.
   - **Approval:** the human presses **Approve**. The engine refuses while \`.slp/mockup\` has uncommitted changes and otherwise pins the current commit on the ticket. The human commits and pushes, or asks the Product Agent to; agents never do this unprompted.
   - **Dependency (stored in SQLite):** a ticket has at most one mockup; its Spec depends on that mockup (one to one); every Brief revision depends on the Spec it was derived from (one Spec, many Briefs). The tables are \`board_mockups\`, \`board_specs\`, \`board_spec_revisions\` and \`board_brief_revisions\`.
   - **Spec lock:** while a ticket's mockup is a draft, the Spec cannot be created or changed by anyone: \`slp_board_save_spec\` and the Spec editor are refused. Agents edit the mockup only and never keep the Spec in step with a draft.
   - **Thin Spec on approval:** approving the mockup makes the engine ask the Product Agent for the Spec (a fresh agent is opened when no session holds the ticket). It saves a Spec with \`slp_board_save_spec\` that references the mockup and records only what it cannot show (business rules, data, permissions, edge cases, out of scope). Features without a UI skip the mockup and get a full Spec.
   - **Edit after approval:** changing an approved mockup returns it to draft and locks the Spec again. The next approval asks the Product Agent to review the existing Spec against the new commit: it saves a revised Spec, or the same text to confirm. The ticket cannot start a Run until that review is saved.
   - **Starting a Run:** a ticket whose mockup is approved and whose Spec exists and matches the approved commit shows **Start Run**. That Run opens the Supervisor on the ticket. The Start SLP form lists tickets that are not ready with the reason, and opens the Product Agent for a new mockup. Aborting a Run releases its ticket (Spec, mockup and Brief history stay) so the feature can start a new Run.

1. **Tier 1 — Supervisor (\`.slp/SUPERVISOR.md\`, runtime role \`supervisor\`):**
   - The human-facing tier. It stays **read-only** on the repository.
   - **Takes over a prepared ticket:** it reads the ticket named in its start briefing and does not redraft its mockup or Spec. Only a Run with no starting ticket has it draft the spec itself (screens/surfaces and their elements, states, Given/When/Then interactions, business rules and out-of-scope items), saving every draft with \`slp_board_save_spec({ title, acceptanceCriteria, spec, summary })\` instead of only pasting it in chat.
   - Calls \`slp_delegate\` with the approved Spec unchanged: \`{ acceptanceCriteria, productSpec }\` for one feature, or \`{ tasks: [{ name, acceptanceCriteria, productSpec, worktree? }], sharedContext? }\` for \`N\` truly independent features. The engine rejects a delegation whose feature lacks a \`productSpec\` of at least 80 characters.
   - **Kanban Spec Updates:** when the human or the Product Agent changes a Spec or mockup during a Run, the engine sends the Supervisor the change, and it calls \`slp_board_notify_lead({ ticketId, message })\` so the active Lead pauses its peers and updates the Brief. A Spec the Supervisor revises itself is saved with \`slp_board_save_spec\` first. The Supervisor never creates or reviews mockups.
   - Every delegation creates one **Lead** per feature and one **QA Lead**. With worktrees on (the default), each Lead gets its own Git worktree and the QA Lead gets the QA worktree (the run's QA branch). With worktrees off, every agent works on the base branch in the main checkout.
   - With worktrees off, the engine adds a **shared-checkout delegation rule** to the Supervisor prompt: read the code before splitting, give each task a write scope (globs, plus the shared files it must not touch unless it owns them), keep parallel tasks disjoint or run them in sequence, name one owner per shared contract, and leave \`tasks[].worktree\` empty. Nothing in the engine enforces the scope, so a \`.slp/SUPERVISOR.md\` that splits work freely must not contradict this rule.
   - **Human decisions & Lead questions:** when a Lead asks a question via \`slp_ask\`, the Supervisor answers it with \`slp_answer({ questionId, answer })\` (and can also reach Leads via \`slp_notify\` / \`slp_ask\`). When a Lead uses up its rework rounds and escalates, the Supervisor receives the latest scorecard, presents it to the human, and passes the human's verdict back with \`slp_relay_decision({ pipelineId, decision })\`.
   - When the QA Lead reports, the Supervisor audits the QA branch (\`slp_list_pipelines\`, \`slp_get_pipeline\`, \`slp_board_list_tickets\`, \`slp_board_get_ticket\`, \`git diff\`) and calls \`slp_request_rework\` (goes to the QA Lead) or \`slp_present_to_manager\` (merges the QA branch into the base branch).

2. **Tier 2 — Lead (\`.slp/LEAD.md\`, runtime role \`master_lead\`):**
   - Runs inside its assigned checkout, receives the sibling Lead roster and its own \`productSpec\` as a contract, and aligns shared APIs/schemas with sibling Leads via \`slp_ask({ toAgentId, question })\`.
   - Receives the **YAML front matter and \`kind\`** of every \`.slp/peers/**/*.md\` file as its peer catalog and calls \`slp_define_pipeline\`. The engine rejects any other shape than:

     \`\`\`text
     [planning: advisor peers only]?  ->  implement: exactly one developer peer
     \`\`\`

   - **Planning (optional, always first):** \`kind: advisor\` peers investigate techniques and design options and discuss them **with the Lead only**. They are read-only and are retired when planning closes. Small, clear changes skip planning.
   - **Approved mockup:** its delegation briefing names the approved file and commit. That file is the UI source of truth: the Lead names it in the developer's task and never edits it.
   - **Brief & Controlled Revisions on the Kanban Board:** \`{ approach, criteria: [{ id, requirement, verification }], inScope, outOfScope }\`. The Lead supplies the initial Brief in \`slp_approve_stage({ summary, brief })\` when closing planning, or as \`pipeline.brief\` in \`slp_define_pipeline\` when there is no planning stage. For stage peers, the Brief is a **locked contract** (developers and QA graders never edit it). When the Supervisor notifies the Lead of a Spec diff (\`slp_board_notify_lead\`) or when implementation/merge conflicts require switching technical approaches, the Lead calls \`slp_pause_peers({ pipelineId, reason })\` to immediately stop active child stage peers and lock their writes, calls \`slp_board_update_brief({ ticketId, pipelineId, reason, approach, items })\` to record a new Brief revision with a unified diff (preserving \`pass\` scores on unchanged bullets while resetting modified/added bullets to \`todo\`), and calls \`slp_resume_peers({ pipelineId, guidance })\` to resume its peers on the updated Brief.
   - \`slp_create_worktree\` exists for a pipeline that needs a checkout of its own. \`slp_define_pipeline\` already attaches each pipeline to the Lead's checkout, so leave the call out unless the pipeline truly needs a second one.
   - **Implement:** exactly one \`kind: developer\` peer builds the locked brief. Feature pipelines never contain a QA/verify stage.
   - The Lead decides every stage with \`slp_approve_stage\` or \`slp_stage_rework\`. Each stage has a rework cap (run setting, default 3). At the cap \`slp_stage_rework\` is refused; the Lead approves or calls \`slp_escalate\`, and the human decides through the Supervisor.
   - When the implement stage is approved, the Lead merges into the QA branch with \`slp_finalize_pipeline\`. Feature Leads never report to the Supervisor.

   **QA Lead (\`.slp/QA_LEAD.md\`, runtime role \`qa_lead\`):**
   - Spawned with the feature Leads; prepares the QA plan from \`TEST_POLICY.md\`, the product specs and the feature briefs while features are built. Read-only: it never edits code. Phase 1 ends your turn once the plan is ready; phase 2 starts only when the engine says every feature branch is merged.
   - \`slp_define_pipeline\` is rejected until every feature branch is merged. QA pipelines run in the QA checkout, one at a time, and contain only **verify** stages: one or more \`kind: qa\` graders plus at most one \`kind: developer\` fixer.
   - **Scorecard loop:** graders submit \`slp_stage_report\` with \`scorecard: [{ criterionId, status: pass|fail|blocked, reason, evidence }]\` (which automatically updates item scores on the project Kanban board; \`slp_board_score_item\` and \`slp_board_get_ticket\` are also available) and optional \`observations\` (anything outside the criteria, not graded). The QA Lead decides from the scorecard alone: approve, or send a fix to the developer with \`slp_stage_rework\`. The developer stays idle until asked; after its fix the engine asks the graders to re-grade before waking the QA Lead. The same rework cap and human escalation apply.
   - Closes with \`slp_finalize_pipeline\` (no merge), then \`slp_report\` with the final scorecard.
   - Besides the verify-stage tools, it also holds \`slp_stage_rework\`, \`slp_pause_peers\`, \`slp_resume_peers\`, \`slp_board_update_brief\`, \`slp_board_score_item\` and \`slp_handle_peer_shell\`, and it observes the same rework cap as a Lead.

3. **Tier 3 — Stage Peers (\`.slp/peers/**/*.md\`, runtime role \`peer\`):**
   - Every peer has a \`kind\`. It decides which stage the peer may join and whether it may write:

     | \`kind\` | Joins | Writes? | Delivers |
     |---|---|---|---|
     | \`advisor\` | planning stage of a feature pipeline | no (file writes and mutating shell are denied) | a short recommendation: chosen option, why, main risk, what to leave out |
     | \`developer\` | implement stage (feature) or as the single fixer in a verify stage (QA) | yes, inside the pipeline checkout (unless paused via \`slp_pause_peers\`) | the change, its tests, files changed, commands run with results |
     | \`qa\` | verify stages of the QA pipeline | no | a scorecard entry per criterion plus observations |

   - Peers talk **only to their Lead** (\`slp_ask\` / \`slp_notify\` / \`slp_answer\`); the bus rejects peer-to-peer messages. Developers can also inspect their Kanban ticket with \`slp_board_get_ticket\` and update individual bullet progress via \`slp_board_update_item\`.
   - Peers run in the Lead's checkout. Whether they fork the Lead's session is a run setting (off by default, and cross-provider peers automatically fall back to a fresh session with full stage mail), so a peer workflow must never assume it inherited the Lead's context: everything it needs arrives in its stage mail (goal, task, acceptance criteria, locked brief or criteria to grade). The engine also adds a short kind-specific instruction to that mail; peer files must not contradict it.

**Run settings, not \`.slp\` content:** "Fork peers from the Lead session", "Use Git worktrees for Leads and QA" (\`spawnWorktrees\`, on by default; off runs every agent on the base branch in the main checkout), "Max rework rounds per stage" and default per-tier models/providers live in the SLP Orchestrator settings and are snapshotted per run. Do not write them into \`.slp\` files.

---

## 2. Organizing \`.slp/\` by Functional Groups & Shared Standards

A brand-new repository is seeded with five flat peers: \`DEVELOPER.md\` (developer), \`QA_ENGINEER.md\` (qa), and the advisors \`ARCHITECT.md\`, \`REVIEWER.md\`, \`SECURITY_REVIEWER.md\`. When tailoring \`.slp/\` for a real project, derive the peers from the investigation and group them by discipline, with a \`.slp/standards/\` folder for shared rules.

### Generic Grouped Layout Pattern (Adapt Groups to the Project)

\`\`\`text
.slp/
├── LEAD.md
├── QA_LEAD.md                              # QA Lead: grades the merged QA branch through QA peers
├── SUPERVISOR.md
├── standards/                              # Shared rules (ignored by the role parser)
│   ├── ENGINEERING_STANDARDS.md
│   └── TEST_POLICY.md                      # REQUIRED: test tiers, heavy resources, unit/manual conventions
└── peers/                                  # Recursively scanned
    ├── design/
    │   └── PRODUCT_DESIGNER.md             # kind: advisor
    ├── engineering/
    │   ├── SYSTEM_ARCHITECT.md             # kind: advisor
    │   ├── BACKEND_ENGINEER.md             # kind: developer
    │   └── FRONTEND_ENGINEER.md            # kind: developer
    ├── quality/
    │   ├── CODE_REVIEWER.md                # kind: advisor  (reviews the approach before code exists)
    │   ├── SECURITY_ADVISOR.md             # kind: advisor
    │   ├── QA_AUTOMATION_ENGINEER.md       # kind: qa       (tier: integration)
    │   └── PLAYTESTER_OR_MANUAL_QA.md      # kind: qa       (tier: integration)
    └── <domain-group>/                     # e.g. data-ml/, billing/, art-audio/
        └── <DOMAIN_SPECIALIST>.md
\`\`\`

### How to Analyze Any Project and Derive Its Peers
1. **Run the project investigation first** (\`references/PROJECT_INVESTIGATION.md\`) and write \`.slp/standards/TEST_POLICY.md\`. Every later step derives from that file.
2. **Pick the kind of each peer from the work it does:**
   - \`developer\`: one per stack area with distinct conventions (for example backend vs frontend, gameplay vs UI). Several developer roles may exist in the catalog, but a pipeline uses exactly one, so write each developer to deliver a whole feature slice in its area.
   - \`advisor\`: one or two per concern that genuinely needs a design decision before coding (architecture, a tricky algorithm, security, product/UX fidelity). Advisors only recommend; their value is a better brief, not more process.
   - \`qa\`: the graders the QA pipeline needs (automated suites, real-environment/manual journeys, performance only when the project has budgets).
3. **Keep the catalog small.** Do not create peers for stacks that are not present, merge roles with almost no distinct work, and do not add a "reviewer of the code" developer-stage peer: code-level checking is the QA graders' job against the brief.
4. **Assign a test tier (\`tier:\`)** that matches the kind: advisors and developers are \`tier: feature\` (only the \`fast\` commands of \`TEST_POLICY.md\`); QA graders are \`tier: integration\` (heavy resources allowed in the QA pipeline, one at a time). A developer that fixes in the QA pipeline stays \`tier: feature\`.
5. **Extract shared project rules into \`.slp/standards/\`** (coding conventions, architecture boundaries, Definition of Done) and reference them from the role files instead of duplicating them.
6. Replace the flat starter files once grouped peers cover their responsibilities. Delete any legacy \`.slp/peers/END_USER_UAT.md\` only as described in section 6.

### Discovery & Validation Constraints (Enforced by \`loadProjectPrompts\`)
- **Parsed files:** only \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\`, \`.slp/QA_LEAD.md\` and \`.md\` files inside \`.slp/peers/\` (recursively) are roles. \`.slp/standards/\` and other folders are ignored by the parser.
- **Role IDs** come only from the YAML \`role\` field, normalized by trimming, lowercasing and turning spaces/underscores into hyphens (\`"Backend Engineer"\` -> \`backend-engineer\`), and must match \`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/\`.
- **\`kind\`** must be \`advisor\`, \`developer\` or \`qa\`; any other value is rejected with the file path. When omitted, the engine guesses from the role ID: an ID containing review, audit, architect, design, advis, research, consult or analyst is an advisor; an ID whose segment starts with qa, test, tester, testing, verif or playtest is a QA grader; anything else is a developer. Always set it explicitly.
- **Reserved root IDs:** peers must never use \`supervisor\`, \`lead\`, \`master-lead\` or \`qa-lead\`. \`.slp/SUPERVISOR.md\` has \`role: supervisor\`, \`.slp/QA_LEAD.md\` has \`role: qa-lead\` (re-seeded when missing), \`.slp/LEAD.md\` has \`role: master-lead\` (or \`lead\`).
- **No duplicate role IDs** across all peer folders.

---

## 3. How to Create a New Grouped Peer Role in \`.slp/peers/<group>/<ROLE>.md\`

Each file has YAML front matter and a \`# Workflow\` body. The developer template is below; the advisor and QA grader templates are in \`references/PEER_TEMPLATES.md\`. Adapt the commands, folders and conventions to what \`TEST_POLICY.md\` records.

### Developer Template (\`kind: developer\`)

\`\`\`markdown
---
role: backend-engineer
name: Backend & API Engineer
description: Builds backend features end to end (domain services, data access, API endpoints) with unit tests, exactly as the locked brief describes.
model:
thinking:
kind: developer
tier: feature
domains:
  - domain services and state transitions
  - database schemas, migrations and queries
  - REST/RPC API contracts and validation
skills: []
---

# Workflow

ROLE: Pipeline peer (Backend & API Engineer), the only developer of this pipeline.

## 1. Build the Brief
- Your stage mail holds the goal, your task, the acceptance criteria and the locked brief. Build everything in scope and nothing out of scope; no extra features, abstractions or configuration.
- If the brief is wrong or cannot be built as written, call \`slp_escalate\` instead of redesigning it yourself.
- Follow \`.slp/standards/ENGINEERING_STANDARDS.md\` and the existing patterns of the code you touch.

## 2. Test and Commit
- Write unit tests following \`.slp/standards/TEST_POLICY.md\` and run only its \`fast\` tier commands. Never start a heavy resource listed there; list anything that needs one as a hand-off item in your report.
- Commit your work in your assigned checkout.

## 3. Report
- Call \`slp_stage_report\` with: files changed, commands run with their results, and any brief criterion you could not meet and why. Explain a design trade-off only when it is not obvious, in one or two sentences.

## 4. SLP Peer Protocol
- Ask only your Lead (\`slp_ask\` / \`slp_notify\`); answer the Lead's questions with \`slp_answer\`. Other peers are not reachable.
- Communicate only through MCP tools from server "${BUS_SERVER_NAME}". Do not use the paseo CLI, curl or another messaging path.
- Do not approve the stage yourself; the Lead decides.
- Pipeline branches (\`slp/*\`) are local only. Do not run \`git push\`.
- After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN.
\`\`\`

### Front-Matter Field Reference
1. \`role\` *(required)*: the ID the Lead passes in \`slp_define_pipeline\` -> \`peers: [{ role, task }]\`.
2. \`description\` *(required)*: when the Lead should schedule this peer and what it owns. The Lead picks peers from this line, so state the kind of problem it is for.
3. \`name\` *(optional)*: display title, defaults to \`role\`.
4. \`model\` *(optional)*: empty inherits the run's Peer model. A short ID keeps the run's provider; \`provider/model\` switches it. When the run forks peers, a model from another provider than the Lead's automatically falls back to a fresh session on that provider with full stage mail.
5. \`thinking\` *(optional)*: reasoning option ID (\`low\`, \`medium\`, \`high\`), empty inherits.
6. \`kind\` *(recommended)*: \`advisor\`, \`developer\` or \`qa\` (see section 1). Set it explicitly: when omitted, the engine guesses from the role ID.
7. \`tier\` *(convention; the engine does not enforce it)*: \`feature\` or \`integration\`, matching the kind (section 2, step 4).
8. **Custom keys** (\`domains\`, \`skills\`, \`features\`, ...): kept and shown to the Lead with the rest of the front matter, so listing owned modules helps it pick the right developer.

---

## 4. Rules for Editing \`.slp/SUPERVISOR.md\`, \`.slp/LEAD.md\` and \`.slp/QA_LEAD.md\` Safely

Start from the seeded files (the plugin writes them into an empty \`.slp/\`) and adapt them to the project; keep every item of the matching checklist.

### Checklist When Editing \`.slp/SUPERVISOR.md\`
1. **Front matter:** \`role: supervisor\` and a non-empty \`description\`.
2. **Read-only:** the Supervisor never edits files or commits.
3. **Prepared tickets first:** a Run started from a ticket uses its approved mockup and Spec unchanged as \`productSpec\`. Only without a starting ticket, draft the five-section spec (screens and elements, states, Given/When/Then interactions, business rules, out of scope), immediately persist every draft or revision onto the project Kanban board with \`slp_board_save_spec({ title, acceptanceCriteria, spec, summary })\` instead of only sending it in chat, get explicit human approval, and pass it unchanged as \`productSpec\`. Adapt section names to the project (HUD/input/feedback for games, endpoints/payloads for APIs) but keep the scenarios.
4. **Kanban Spec updates:** when the engine reports a Spec or mockup change during a Run, call \`slp_board_notify_lead\` so the active Lead can pause its peers and update its Brief. Save your own Spec revisions with \`slp_board_save_spec\` first. Never create or review mockups; they are settled with the Product Agent before a Run.
5. **Delegation:** one task \`slp_delegate({ acceptanceCriteria, productSpec })\` or truly independent parallel features \`slp_delegate({ tasks: [{ name, acceptanceCriteria, productSpec }], sharedContext? })\`. With worktrees off, parallel features also need disjoint write scopes (the shared-checkout delegation rule in section 1), and any split guidance in this file must stay consistent with it.
6. **Human decisions & Lead questions:** answer Lead questions asked via \`slp_ask\` using \`slp_answer({ questionId, answer })\`; present a rework-capped scorecard to the human (what passes, what fails and why, the Lead's recommendation) and relay the answer with \`slp_relay_decision\`.
7. **Verification and completion:** inspect with \`slp_list_pipelines\`, \`slp_get_pipeline\`, \`slp_board_list_tickets\`, \`slp_board_get_ticket\`, \`slp_get_run\`, \`git diff\`; revive with \`slp_revive_agent\`; finish with \`slp_request_rework\` or \`slp_present_to_manager\`.
8. **Turn rule:** *"After \`slp_delegate\`, \`slp_board_notify_lead\`, \`slp_request_rework\`, \`slp_relay_decision\` or \`slp_present_to_manager\` succeeds, END YOUR TURN."*

### Checklist When Editing \`.slp/LEAD.md\`
1. **Front matter:** \`role: master-lead\` (or \`lead\`) and a non-empty \`description\`. A \`model\` from another provider switches the Lead's provider.
2. **Product spec and approved mockup are a contract:** the mockup under \`.slp/mockup/\` is the UI source of truth, the developer's task names it, and sibling Leads align shared contracts via \`slp_ask\`. Never edit a mockup or give a peer a task that creates or changes one; report a wrong mockup with \`slp_escalate\`.
3. **Pipeline shape:** \`{ pipeline: { name, description, stages: [{ name, kind?, goal, peers: [{ role, task }] }], brief? } }\` with role IDs from the catalog, no \`systemPrompt\` field, and the enforced shape \`[planning with advisors]? -> implement with one developer\`. Never recommend a review, QA or verify stage inside a feature pipeline.
4. **When to plan:** say which project situations deserve planning and which advisors fit them (for example: new subsystem -> \`system-architect\`; auth or payment change -> \`security-advisor\`), and that small, clear changes skip planning and pass \`brief\` directly.
5. **How to write and revise the brief:** few criteria, each observable and tied to the acceptance criteria or a product spec scenario, each with a concrete \`verification\` (test file, command or manual step a QA grader can run); tempting extras go to \`outOfScope\`. When implementation/merge conflicts require switching technical approaches or when the Supervisor notifies the Lead of a Spec diff, call \`slp_pause_peers\` to stop active stage peers, call \`slp_board_update_brief\` to revise the Brief bullets with a clear reason, and call \`slp_resume_peers\` to resume the peers on the updated Brief.
6. **Deciding:** judge the developer's report against the brief; approve or \`slp_stage_rework\` with concrete corrections; never request work outside the brief; at the rework cap approve or \`slp_escalate\` with the open problems and a recommendation.
7. **Lifecycle tools:** \`slp_handle_peer_shell\` for watchdog alerts, \`slp_finalize_pipeline\` to merge into the QA branch (feature Leads have no \`slp_report\`).
8. **Test tier:** feature pipelines schedule only \`tier: feature\` peers and run only the \`fast\` tier of \`TEST_POLICY.md\`.
9. **No runtime files, no push:** runtime specs and reports live in SQLite; never \`git push\` \`slp/*\` branches.
10. **Turn rule:** *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_resume_peers\`, \`slp_handle_peer_shell\` or \`slp_finalize_pipeline\` succeeds, END YOUR TURN."*

### Checklist When Editing \`.slp/QA_LEAD.md\`
1. **Front matter:** \`role: qa-lead\` and a non-empty \`description\`. A \`model\` here applies to the QA Lead only.
2. **Two phases:** preparation (read \`TEST_POLICY.md\`, map every product spec scenario and every feature brief criterion to a check, ask feature Leads via \`slp_ask\`, do not define a pipeline) and post-handover (define the QA pipeline, omitting \`worktree\`).
3. **Never edit code or mockups:** the runtime denies its writes; fixes go to the verify stage's developer, and no stage task may create or change a mockup. Grade the build against the approved mockup as written.
4. **Verify stages from the investigation:** for example fast suites -> engine/E2E suites -> real-environment journeys, each stage with \`kind: qa\` graders and at most one \`kind: developer\` fixer, \`tier: integration\` graders for heavy work, and never two peers on the same heavy resource in one stage.
5. **Scorecard loop & Kanban sync:** decide from the graded criteria (graders submit \`scorecard\` in \`slp_stage_report\` or via \`slp_board_score_item\`); send fixes with \`slp_stage_rework\`; observations are a judgement call, not automatic fixes; at the rework cap approve or \`slp_escalate\`.
6. **Close then report:** \`slp_finalize_pipeline\` (closes, no merge) then \`slp_report\` with the final scorecard; Supervisor rework arrives as a new QA pipeline with a new name.
7. **Turn rule:** *"After \`slp_define_pipeline\`, \`slp_approve_stage\`, \`slp_stage_rework\`, \`slp_resume_pipeline\`, \`slp_handle_peer_shell\`, \`slp_finalize_pipeline\` or \`slp_report\` succeeds, END YOUR TURN."*

### Checklist When Editing Any \`.slp/peers/<group>/*.md\` File
1. **Front matter:** unique, valid, non-reserved \`role\`, a clear \`description\`, an explicit \`kind\` and a \`tier\` that matches it.
2. **Work from the stage mail:** the workflow relies on the goal, task, acceptance criteria and brief in the stage mail, never on an inherited Lead session.
3. **Stay inside the kind:** advisors never write or propose implementing it themselves; QA graders never fix; the developer never widens the brief. No peer creates or edits anything under \`.slp/mockup/\`: read it as the UI contract and \`slp_escalate\` when it cannot be followed.
4. **Tool obligations:** \`slp_stage_report\` (graders with \`scorecard\` and \`observations\`), \`slp_escalate\` when blocked, \`slp_ask\` / \`slp_notify\` with the Lead only, \`slp_answer\` for the Lead's questions, optional \`slp_board_update_item\` for developer progress tracking, never approve the stage.
5. **Proportionate evidence:** facts (files, commands, results, screenshot paths for visual criteria only), no essays, no peer-to-peer coordination.
6. **Test commands** from \`TEST_POLICY.md\` allowed for its tier.
7. **Turn rule:** *"After \`slp_stage_report\` or \`slp_escalate\` succeeds, END YOUR TURN."*

---

## 5. Verification Procedure After Creating or Editing \`.slp\` Files

1. Every role file starts with \`---\` on line 1 and closes its front matter with \`---\`; \`role\` and \`description\` are non-empty, keys are unique, the body is non-empty.
2. No two peer files normalize to the same \`role\`.
3. Every peer declares \`kind\` (\`advisor\`, \`developer\`, \`qa\`) and a matching \`tier\`; the catalog has at least one developer per stack area that features will touch and at least one \`qa\` grader.
4. \`.slp/standards/TEST_POLICY.md\` exists, its \`fast\` commands were actually run, and every heavy resource lists process signatures.
5. No role file mentions peer-to-peer messages, a "Prior Stage Peers" roster, a review/QA stage inside feature pipelines, or MANDATORY-style method contracts.
6. Every \`slp_*\` tool named in a role file exists, the \`${BUS_SERVER_NAME}\` transport rule, the no-push rule and the turn rules are intact.
7. Run the plugin's "Reload role workflows" button; it parses every file and reports the exact path of any error.
8. Every changed file carries \`slp-contract: ${SLP_CONTRACT_VERSION}\` in its front matter.

## 6. Upgrading an Existing \`.slp\` to the Current Structure

Old files still load, but their instructions contradict the engine and cause rejected tool calls or scope creep. For a \`.slp\` generated before the current engine:

1. **Supervisor:** runs now start from a ticket prepared with the Product Agent, so use its approved mockup and Spec instead of redrafting them; save your own Spec revisions via \`slp_board_save_spec\`; notify the Lead of Spec and mockup changes via \`slp_board_notify_lead\`; remove any step that reviews a mockup during a Run; every \`slp_delegate\` needs the human-approved \`productSpec\`; add the human-decision rule with \`slp_relay_decision\` and add it to the turn rule. Remove any instruction to wait for a feature Lead's report.
2. **Lead:** replace recommended stage shapes such as \`design -> implement -> verify-and-review\` or multi-developer stages with \`[planning with advisors]? -> implement with one developer\`; remove any mockup stage or mockup submission step, and treat the approved \`.slp/mockup/<feature>.html\` as the UI contract; add the brief guidance, and the peer-pause / Brief-revision workflow (\`slp_pause_peers\` -> \`slp_board_update_brief\` -> \`slp_resume_peers\`, checklist item 5); remove \`slp_report\`, End-User UAT pipelines, merges into the base branch and "Prior Stage Peers" consultation; and remove steps that create worktrees yourself (a \`slp_create_worktree\` call before \`slp_define_pipeline\`, or a line saying the engine automatically creates an isolated worktree), because \`slp_define_pipeline\` attaches each pipeline to its checkout.
3. **QA Lead:** the plugin re-seeds \`.slp/QA_LEAD.md\` when missing. Rewrite its stages as verify stages with graders and one fixer, and add the scorecard loop.
4. **Peers:** add \`kind\` and a matching \`tier\` to every peer; turn code-reviewer style peers into planning advisors; give QA peers the scorecard report from \`references/PEER_TEMPLATES.md\`; delete "Method Contract", "Rejected Alternatives", "enumerate all edge cases", "STRICT TECHNICAL METRICS" and peer-to-peer coordination sections.
5. **Mockups:** new mockups live in the git-tracked \`.slp/mockup/\`, with each \`<feature>.html\` as an index over \`features/<feature>/\`, \`core/\` and \`assets/\`. Move any inline script or style out of an old index. Remove any ignore rule covering it. Old \`.slp/mockups/<feature>/versions/\` folders stay previewable from their tickets and can be deleted once nothing references them.
6. **Legacy \`.slp/peers/END_USER_UAT.md\`:** read it first and move project-specific journeys into the QA Lead's plan or into a \`kind: qa\` integration grader. Delete the file only after the human confirms, and remove every reference to the \`end-user\` role with it.
7. **Standards:** create \`.slp/standards/TEST_POLICY.md\` from the investigation if it is missing.

After the edits, run the verification procedure in section 5 and list every changed file for the human.
`;
}
