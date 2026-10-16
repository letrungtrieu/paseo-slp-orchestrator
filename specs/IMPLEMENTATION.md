# SLP Orchestrator: implementation notes

Implements `specs/MVP.md` as a Paseo plugin (`@getpaseo/plugin` 0.11.4). This file records how the
spec maps onto Paseo and which parts are enforced softly.

## Module map

| Path | Responsibility |
| --- | --- |
| `shared/` | Zod contracts shared by daemon and app: roles/limits, run + task state, RPCs, progress card |
| `server/store/` | `RunStore` (atomic `~/.slp-orchestrator/state.json`), `comm-log.jsonl` writer/reader |
| `server/bus/` | Plugin-hosted MCP server (hand-written streamable HTTP) and the role-scoped tool catalogue |
| `server/runtime/` | `AgentGateway` (create/prompt/archive agents), `Mailbox` (deliver only to idle agents), SDK holder |
| `server/fork/` | `SessionForker` registry; Claude adapter is wired, Codex/Antigravity degrade to a spec-file briefing |
| `server/git/` | git helpers, scope rules (pure), worktree creation and `TASK_SPEC.md` |
| `server/pipeline/` | The state machine: run lifecycle, handshake, execution/verification/fix loop, collaboration, gates |
| `server/hooks/` | Permission policy (pure) and lifecycle hooks (nudges, permission answers) |
| `server/sweeper.ts` | 3 s loop: answer permissions, flush mail, restart stuck tasks (events are best effort) |
| `client/` | Run control screen, Live Monitor panel, progress card renderer |

## Flow

1. UI `slp.run.start` creates the Supervisor (in the user's checkout), an integration worktree
   `slp/<run>/dev` and the Master Lead inside it. Every agent gets its own bus URL `/mcp/<token>`.
2. Supervisor `slp_delegate` -> Master Lead surveys, writes the Master Spec, calls `slp_define_tasks`.
3. After the Master Lead's turn ends (the fork checkpoint) each task gets a worktree
   `slp/<run>/<task>`, a **Forked Lead** (Claude session fork in the Lead's cwd) and a read-only Implementer.
4. Handshake: `slp_submit_plan` -> Forked Lead replies with a JSON verdict (approve/clarify/escalate)
   -> approve unlocks writes, archives the Forked Lead, briefs the Master Lead.
5. `slp_stage_done` -> scope gate (git diff vs `writableScope`, `TASK_SPEC.md` restored) -> QA/Security
   (parallel or sequential) -> reject loop up to 3 rounds, then circuit breaker -> acceptance doc ->
   `ready_for_merge` -> Master Lead merges and calls `slp_archive_task`.
6. All merged -> `slp_report` -> Supervisor audits -> `slp_present_to_manager` -> human presses
   "Approve -> main" (`slp.run.approve_main`).

## Enforcement (soft by design)

- Zero-CLI-Send: prompts forbid it, the permission hook denies `paseo` CLI / daemon `curl`.
- Write lock: permission hook decides per role + phase + path; the scope gate catches shell writes.
- Contract escalation: only when a peer calls `slp_escalate` (no semantic detection).
- Circuit breaker: `fixLoopCount > 3` pauses the task and notifies the Master Lead.

## Known limits

- Paseo 0.11.4 has no hidden (background) workspaces, so task worktrees are visible.
- Native fork is wired for Claude only. Codex needs a core patch (thread id on create); Antigravity's
  `/fork` only works in the TUI (`tools/scripts/agy-fork.sh`) and its provider cannot attach to it.
- Mode cannot change at runtime from the SDK, so every peer runs in `default` mode and the hook is the gate.
- Progress cards live in the daemon timeline; they are republished on every task change.
