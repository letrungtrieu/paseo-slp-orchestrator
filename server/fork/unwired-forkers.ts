// Providers that have a native fork but cannot be bound to a NEW Paseo agent from a plugin yet.
// They return null so the registry degrades to the spec-file briefing and records why.
import type { SessionForker } from "./session-forker";

// Codex: `thread/fork` exists in the app-server protocol, but CodexProviderOptionsSchema is strict
// and ensureThread() always issues thread/start, so a plugin cannot resume a forked thread.
// Needs a small Paseo core patch exposing a forkFrom/resume thread id on agents.create.
export const codexForker: SessionForker = {
  family: "codex",
  async bind() {
    return null;
  },
};

// Antigravity: `/fork` works in the interactive TUI only (tools/scripts/agy-fork.sh proves it),
// and the Paseo antigravity provider cannot attach to an arbitrary conversation id on create.
export const antigravityForker: SessionForker = {
  family: "antigravity",
  async bind() {
    return null;
  },
};
