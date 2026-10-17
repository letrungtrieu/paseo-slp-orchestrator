# Project role workflows

Selecting a repository in SLP prepares `.slp` before any agents are created. A missing folder, or a legacy folder containing only generated logs/specs, receives these editable defaults:

```text
.slp/
├── SUPERVISOR.md
├── LEAD.md
└── peers/
    ├── DEVELOPER.md
    ├── REVIEWER.md
    ├── QA_ENGINEER.md
    └── SECURITY_REVIEWER.md
```

Existing custom prompt files are preserved. Markdown is discovered recursively, including additional subdirectories. Role IDs come from YAML front matter, independently of filenames. Old root `MASTER_SPEC.md` and `ACCEPTANCE_DOC.md` artifacts are excluded from role discovery because their data was migrated to SQLite.

## File format

The SLP form and **Settings → SLP Orchestrator** share host-wide defaults managed by Paseo. New installations start in `FULL_AUTO`; changes to mode, role models, thinking and permissions save automatically. Once the catalog loads, visible defaults are saved as concrete model/thinking/permission IDs for Supervisor, Lead and Peers. Empty permission choices resolve to Full Access where the provider supports it. Session title, repository and base branch remain specific to each new run.

```markdown
---
role: qa-engineer
name: QA Engineer
description: Review invoice calculations and regression coverage.
model:
thinking:
features:
  - invoice rounding
  - billing regressions
---

# Workflow

1. Read the stage goal and brief through the SLP tools.
2. Inspect decimal precision, currency conversion and refund edge cases.
3. Run relevant tests; add regression tests if needed in the stage worktree.
4. Return concrete evidence through slp_stage_report.
```

`role` and `description` are required. Role names are normalized to lowercase IDs, with spaces or underscores converted to hyphens: `Invoice Specialist` becomes `invoice-specialist`. Duplicate IDs and malformed YAML stop initialization with the affected path.

`model` and `thinking` are optional, independently inherited from the corresponding Supervisor, Lead or Peer selections in the SLP form. Omitted, empty or null fields inherit. A full `provider/model-id` selects a model and provider; a short model ID keeps the provider selected in the form. `thinking` uses the selected model's Paseo thinking option ID. `LEAD.md` model settings also apply to temporary Forked Leads, so native forks use the actual Lead provider.

Run modes apply to the dynamic pipeline generically: `FULL_AUTO` leaves human gates closed, `STEP_BY_STEP_DEBUG` opens a gate after each approved stage, and `SEMI_AUTO` opens one before integration. Forked Lead approval is still required for each stage in every mode.

There is no required `kind`. Each file under `.slp/peers/*.md` is the agent prompt for that peer role: its YAML front matter summary (`role`, `name`, `description`, and any domain metadata) is injected into the Lead's `systemPrompt` so the Lead coordinates stages on its own, while its Markdown body (`# Workflow`) is injected into the peer agent spawned for that role.

## Lead pipeline definition

The Lead receives the summary metadata of all `.slp/peers` roles directly in its `systemPrompt` and creates a complete pipeline with `slp_define_pipeline`. The pipeline is a JSON object; the engine does not impose fixed stages or legacy roles:

```json
{
  "pipeline": {
    "name": "task_A",
    "version": "1.0",
    "worktree": "path/to/worktree",
    "description": "Implementation of task A.",
    "stages": [
      {
        "name": "review-codebase",
        "goal": "Understand the existing design before coding.",
        "peers": [
          {"role": "reviewer", "task": "Review structure and risks."},
          {"role": "developer", "task": "Address the review findings."}
        ]
      },
      {
        "name": "coding",
        "goal": "Implement the accepted design.",
        "peers": [{"role": "developer", "task": "Implement the feature."}]
      },
      {
        "name": "qa",
        "goal": "Check the completed feature.",
        "peers": [{"role": "qa_engineer", "task": "Run quality checks."}]
      }
    ]
  }
}
```

Each `role` must match a Markdown role ID. The daemon loads the matching workflow into the peer system prompt; the Lead does not send a copied workflow string. `goal` is shared context for every peer in that stage, while `task` is the individual assignment. A stage may contain any number of peers. They work concurrently in the handed-off worktree, send direct messages with `slp_send_peer_message`, and submit reports with `slp_stage_report`. The Forked Lead independently decides whether the stage goal is met and calls `slp_approve_stage`; peer unanimity is not required. It calls `slp_stage_rework` when another pass is needed.

After approval, the stage peers are archived. The next stage receives the accepted result and gets a fresh peer set; its coordinator can query prior stage reports and messages when needed, rather than receiving the entire history automatically. Stage messages and reports are stored in SQLite with their stage, so the Lead can audit the discussion without creating files in the repository. The Lead can finish the whole pipeline with `slp_finalize_pipeline`; a paused pipeline resumes through `slp_resume_pipeline`.

`slp_create_worktree` creates the workspace named by the Lead before `slp_define_pipeline`. The pipeline's `worktree` and branch are persisted for monitoring. The operator can inspect the live stage names, peer roles, reports and direct messages in the run detail view.

## Editing and persistence

Edit Markdown, then use **Reload role workflows** in SLP to validate discovery. Starting a run reads the latest files again and saves a complete prompt snapshot in SQLite. That run's agents and forks use the snapshot even if files are subsequently edited; new runs adopt later edits. Existing agent sessions keep their creation-time configuration.

`.slp` contains intentional project configuration only. The runtime creates no pipeline, task specification, report or log files there or in worktrees; pipeline definitions, stage reports, direct messages and audit logs remain in SQLite outside the repository. The shell can initialize or validate configuration without creating any agent:

```bash
tools/bin/slp-rpc slp.project.prompts.init '{"repoPath":"/absolute/path/to/project"}'
```

Runs created by the retired task engine remain available for inspection, but their task controls are read-only and they are not resumed automatically. Start a new run after upgrading to use Lead-defined stages and the current mode gates.
