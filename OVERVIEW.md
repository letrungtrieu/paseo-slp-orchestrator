SLP Orchestrator runs a multi-agent software delivery pipeline inside Paseo. You describe a feature to a Supervisor agent in chat; a Master Lead splits it into work packages, each package is built and reviewed by Peer agents in its own git worktree, and the finished result waits for your approval before it is merged into your base branch.

How it works: every agent receives a private MCP tool bus hosted by the plugin and can only call the tools of its role. The plugin routes all messages, checks each stage's git diff against the allowed file scope, runs the QA and Security fix loop (up to three rejected rounds before it pauses the task), and writes an audit trail to `.slp/comm-log.jsonl` in your repository. Before coding starts, a temporary Forked Lead, a copy of the Master Lead's session, reviews the Implementer's plan.

Setup: plugins must be enabled on the daemon, Paseo 0.11.4 or newer, Linux or macOS, and `git` on the PATH. Run state is kept in `~/.slp-orchestrator`. The plugin serves its tool bus on a loopback port only. The Forked Lead uses a native Claude session fork, so the lead provider should be Claude; other providers fall back to a spec-file briefing.

Operating modes: step-by-step debug pauses at every hand-over, semi-auto pauses at circuit breakers and before merging, full auto only asks for the final approval. The Monitor panel shows every inter-agent call and each work package appears as a progress card in the Supervisor chat.

Limits: write restrictions are enforced by prompts, a permission hook and a post-stage git diff check, not by an operating system sandbox. Task worktrees are visible in the sidebar on Paseo 0.11.4.
