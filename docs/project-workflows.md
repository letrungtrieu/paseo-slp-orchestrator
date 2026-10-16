# Project role workflows

Selecting a repository in SLP prepares `.slp` before any agents are created. A missing folder, or a legacy folder containing only generated logs/specs, receives these editable defaults:

```text
.slp/
├── SUPERVISOR.md
├── LEAD.md
└── peers/
    ├── IMPLEMENTER.md
    ├── QA.md
    ├── SECURITY.md
    └── DOC.md
```

Existing prompt files are never overwritten. Markdown is discovered recursively, including additional subdirectories. Role IDs come from YAML front matter, independently of filenames. Old root `MASTER_SPEC.md` and `ACCEPTANCE_DOC.md` artifacts are excluded from role discovery because their data was migrated to SQLite.

## File format

The SLP form and **Settings → SLP Orchestrator** share host-wide defaults managed by Paseo. New installations start in `FULL_AUTO`; changes to mode, role models, thinking and permissions save automatically. Once the catalog loads, visible defaults are saved as concrete model/thinking/permission IDs for Supervisor, Lead and Peers. Empty permission choices resolve to Full Access where the provider supports it. Session title, repository and base branch remain specific to each new run.

```markdown
---
role: QA
description: Review invoice calculations and regression coverage.
model:
thinking:
features:
  - invoice rounding
  - billing regressions
---

# Workflow

1. Read the task and acceptance criteria through the SLP tools.
2. Inspect decimal precision, currency conversion and refund edge cases.
3. Run relevant tests; add regression tests if the assignment grants test writes.
4. Return concrete evidence through the assignment's completion tool.
```

`role` and `description` are required. Role names are normalized to lowercase IDs, with spaces or underscores converted to hyphens: `Invoice Specialist` becomes `invoice-specialist`. Duplicate IDs and malformed YAML stop initialization with the affected path.

`model` and `thinking` are optional, independently inherited from the corresponding Supervisor, Lead or Peer selections in the SLP form. Omitted, empty or null fields inherit. A full `provider/model-id` selects a model and provider; a short model ID keeps the provider selected in the form. `thinking` uses the selected model's Paseo thinking option ID. `LEAD.md` model settings also apply to temporary Forked Leads, so native forks use the actual Lead provider.

There is no required `kind`. Additional front matter, including domain features and configured model/thinking, is supplied to the Lead as metadata. The workflow body is injected into the agent selected for that project role. The transport, tool authorization, task scope and phase handoff rules are retained by the plugin.

## Lead assignment

The Lead receives the root and peer front matter in its system prompt, and can query `slp_list_peer_roles`. It selects project role IDs in `slp_define_tasks`:

```json
{
  "masterSpec": "Project architecture and acceptance contracts...",
  "tasks": [{
    "id": "billing-ui",
    "title": "Billing screen",
    "purpose": "Implement the accepted billing screen",
    "writableScope": ["src/billing/"],
    "implementerRole": "frontend",
    "verifiers": ["qa", "performance"],
    "reviewerPermissions": {"qa": "tests", "performance": "read-only"},
    "documentedBy": "writer"
  }]
}
```

Those role IDs must exist in the project's Markdown. The same role can occupy different assignments on different tasks, or separate implementation/review instances on one task. `documentedBy: "implementer"` reuses the primary peer; another role ID creates a dedicated report author. Custom reviewers default to read-only; QA retains its test-writing default unless overridden.

`slp_spawn_peer` lets the Lead start an additional role with a brief whenever it needs domain expertise. Omitting `taskId` creates a read-only project consultation, including before task decomposition. A task-bound assignment is read-only by default; `allowWrites: true` grants the task scope during implementing/fixing. The agent receives its selected workflow and reports with `slp_peer_report`. `slp_prompt_peer` reuses that session for follow-up questions. Reports are stored in SQLite and delivered to the Lead, which decides the next assignment.

## Editing and persistence

Edit Markdown, then use **Reload role workflows** in SLP to validate discovery. Starting a run reads the latest files again and saves a complete prompt snapshot in SQLite. That run's agents and forks use the snapshot even if files are subsequently edited; new runs adopt later edits. Existing agent sessions keep their creation-time configuration.

`.slp` contains intentional project configuration. Task definitions, specs, acceptance evidence, additional peer reports and audit logs remain in SQLite outside the repository. The shell can initialize or validate configuration without creating any agent:

```bash
tools/bin/slp-rpc slp.project.prompts.init '{"repoPath":"/absolute/path/to/project"}'
```
