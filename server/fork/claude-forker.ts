// Claude Code adapter. Verified by tools/scripts/claude-fork-spike.mjs: creating a Paseo agent with
// `--resume <source> --fork-session` yields a new session that remembers the source conversation
// while leaving the source untouched. The fork must share the source's cwd, because Claude
// stores sessions per project directory.
import type { ForkSource, NativeForkBinding, SessionForker } from "./session-forker";

export const claudeForker: SessionForker = {
  family: "claude",
  async bind(source: ForkSource): Promise<NativeForkBinding> {
    return {
      mode: "native",
      providerOptions: {
        // `null` renders a bare flag (--fork-session) in the Claude SDK extraArgs contract
        extraArgs: { resume: source.providerSessionId, "fork-session": null },
      },
    };
  },
};
