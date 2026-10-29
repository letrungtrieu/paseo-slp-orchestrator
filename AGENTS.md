# AGENTS.md — Paseo SLP Orchestrator Guidelines

## 1. Mandatory Lockstep Synchronization Rule (`initSkill` & Default `.slp` Workflows)

> [!IMPORTANT]
> **Mandatory Requirement for Every Mechanism or Tool Change:**
> Whenever you add, modify, or remove any SLP orchestration mechanism, pipeline stage rule, Kanban board workflow (`SPEC -> BRIEF -> SCORE -> REWORK`), peer lifecycle rule, or MCP bus tool (`slp_*` in `server/bus/tool-schemas.ts`), you **MUST** inspect and update the `initSkill` (`slp-manager`) skill content in the **same change** so provisioned project skills never drift behind the runtime engine.

### Required Lockstep Checklist Before Completing Any Mechanism Change

1. **MCP Bus Tool Catalogue (`server/bus/tool-schemas.ts` & `server/pipeline/*`)**:
   - Verify role permissions (`supervisor`, `master_lead`, `qa_lead`, `peer`), input schemas, and whether the tool ends the agent's turn or mutates `awaitingTool`.
2. **Default Seeded Role Workflows (`server/prompts/default-workflows.ts` & `server/project-prompts/defaults.ts`)**:
   - Update `DEFAULT_WORKFLOWS` (`supervisor`, `master_lead`, `qa_lead`, `peer`) and seeded `.slp/` templates so newly initialized repositories receive instructions and turn-ending rules that match the current engine contract.
3. **`initSkill` Skill Generator (`server/skills/slp-manager/*`)**:
   - Audit and update `server/skills/slp-manager/skill-markdown.ts` (`renderSlpManagerSkillMarkdown`) — including:
     - **Section 1**: 3-Tier SLP Architecture (`Supervisor`, `Lead`, `QA Lead`, `Stage Peers`), Kanban board lifecycle, and run settings.
     - **Section 3**: Peer role template and YAML front-matter reference (`role`, `description`, `model`, `thinking`, `kind`, `tier`).
     - **Section 4**: Mandatory checklists for `.slp/SUPERVISOR.md`, `.slp/LEAD.md`, `.slp/QA_LEAD.md`, and `.slp/peers/<group>/*.md` (including exact tool names and turn-ending rules).
     - **Section 6**: Migration checklist for upgrading existing `.slp/` directories to the new mechanism.
   - Audit `server/skills/slp-manager/peer-templates-reference.ts`, `project-investigation-reference.ts`, `stack-playbooks-reference.ts`, and `test-policy-template-reference.ts` if peer kinds, test tiers, or templates are affected.
4. **Skill Provisioning & Contract Tests (`tests/slp-manager-skill.test.ts`)**:
   - Update or add assertions in `tests/slp-manager-skill.test.ts` verifying that `renderSlpManagerSkillMarkdown()` documents the new tools/mechanisms and that every `slp_*` tool named in `SKILL.md` exists in `BUS_TOOL_DEFINITIONS`.

---

## 2. Architecture & Key Modules

- **`shared/`**: Shared Zod schemas and TypeScript contracts across daemon and UI (`shared/state.ts`, `shared/pipeline.ts`, `shared/board.ts`, `shared/orchestration.ts`, `shared/rpc.ts`, `shared/roles.ts`).
- **`server/bus/`**: Loopback HTTP MCP server (`slp-bus`) and role-scoped tool definitions (`server/bus/tool-schemas.ts`).
- **`server/pipeline/`**: Stage state machine (`stage-engine.ts`), stage reports/rework/escalation (`stage-messages.ts`), Kanban board operations (`board-tools.ts`), Lead peer pause/resume (`peer-pause.ts`), and verification scorecard loop (`verify-loop.ts`).
- **`server/prompts/` & `server/project-prompts/`**: System prompt assembly (`system-prompts.ts`), default `.slp` role workflows (`default-workflows.ts`), `.slp` Markdown parser (`markdown.ts`), and per-tier provider/model resolution (`agent-settings.ts`).
- **`server/skills/slp-manager/`**: Source files for the `slp-manager` skill installed into target repositories (`<repoPath>/.agents/skills/slp-manager` and `<repoPath>/.claude/skills/slp-manager`) via `ensureSlpManagerSkill` (`initProjectSkillsRpc`).
- **`client/`**: Paseo UI screens and components (`run-control-screen.tsx`, `kanban-panel.tsx`, `settings-screen.tsx`, `components/kanban/*`).

---

## 3. Verification Commands

Run these checks before considering any task complete:

```bash
# Typecheck server, client, and shared modules
npm run typecheck

# Run the skill & workflow synchronization test suite
npx vitest run tests/slp-manager-skill.test.ts

# Reload the local Paseo plugin when server or UI code changes
paseo plugin reload paseo-slp-orchestrator
paseo plugin ls
```
