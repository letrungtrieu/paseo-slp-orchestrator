#!/usr/bin/env node
// Spike: verify a NEW Paseo agent can natively fork an existing Claude session by passing
// `--resume <id> --fork-session` through `config.options.extraArgs`, instead of `paseo import`.
// Success = the fork recalls a secret only the source knew, has its own session id, and the
// fork's new messages never reach the source session.
import { mkdirSync } from "node:fs";
import { createPaseoClient } from "@getpaseo/client";

if (process.argv.includes("--help")) {
  console.log("Usage: claude-fork-spike.mjs [--keep]\n  Creates two temporary Claude agents, forks one into the other, prints a verdict.\n  --keep  do not archive the agents afterwards\n  PASEO_URL (default ws://127.0.0.1:6767/ws), SPIKE_MODEL (default claude/claude-sonnet-5-5)");
  process.exit(0);
}
if (process.argv.includes("--desc")) {
  console.log("Spike: fork a Claude session into a new Paseo agent via extraArgs");
  process.exit(0);
}

const daemon_ws_url = process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
const spike_provider_model = process.env.SPIKE_MODEL ?? "claude/claude-sonnet-5-5";
// Claude stores sessions per project directory, so source and fork must share one cwd.
const shared_project_cwd = "/tmp/claude-fork-spike";
const source_secret = `KIWI-${Math.floor(Math.random() * 1000)}`;
const fork_only_secret = `PLUM-${Math.floor(Math.random() * 1000)}`;
// Plan mode keeps the temporary agents from touching files even if they try.
const spike_mode_id = "plan";
const turn_timeout_ms = 180_000;

mkdirSync(shared_project_cwd, { recursive: true });
const paseo_client = createPaseoClient({ url: daemon_ws_url });
await paseo_client.connect();
const created_agent_handles = [];

// Normalizes run results so failures (permission prompts, errors) are visible in the report.
function replyText(turn_result) {
  if (turn_result.status !== "idle") return `<${turn_result.status}>`;
  return String(turn_result.lastMessage ?? "").trim();
}

try {
  const source_agent = await paseo_client.agents.create({
    config: { provider: spike_provider_model, modeId: spike_mode_id },
    cwd: shared_project_cwd,
    title: "slp-spike source",
    labels: { "slp.spike": "claude-fork" },
    prompt: `Remember this code word: ${source_secret}. Reply only with OK.`,
  });
  created_agent_handles.push(source_agent);
  const source_first_turn = await source_agent.waitForFinish(turn_timeout_ms);
  await source_agent.refresh();
  const source_session_id = source_agent.runtimeInfo?.sessionId ?? null;
  console.log("source agent:", source_agent.id, "session:", source_session_id, "reply:", replyText(source_first_turn));
  if (!source_session_id) throw new Error("source agent exposes no runtimeInfo.sessionId");

  // The flag under test: Paseo spreads `options` into Claude SDK options, and extraArgs become CLI flags.
  const forked_agent = await paseo_client.agents.create({
    config: {
      provider: spike_provider_model,
      modeId: spike_mode_id,
      options: { extraArgs: { resume: source_session_id, "fork-session": null } },
    },
    cwd: shared_project_cwd,
    title: "slp-spike fork",
    labels: { "slp.spike": "claude-fork" },
    prompt: `What code word did I ask you to remember? Then remember a second word: ${fork_only_secret}. Reply with the first word only.`,
  });
  created_agent_handles.push(forked_agent);
  const fork_recall_turn = await forked_agent.waitForFinish(turn_timeout_ms);
  await forked_agent.refresh();
  const forked_session_id = forked_agent.runtimeInfo?.sessionId ?? null;
  const fork_recall_reply = replyText(fork_recall_turn);
  console.log("forked agent:", forked_agent.id, "session:", forked_session_id, "reply:", fork_recall_reply);

  // Isolation check: the source must not have seen anything said inside the fork.
  const source_isolation_turn = await source_agent.run(
    "Did anyone tell you a second code word starting with PLUM? Reply YES with the word, or NO.",
    { timeoutMs: turn_timeout_ms },
  );
  const source_isolation_reply = replyText(source_isolation_turn);
  console.log("source isolation reply:", source_isolation_reply);

  const fork_inherited_memory = fork_recall_reply.includes(source_secret);
  const fork_has_own_session = Boolean(forked_session_id) && forked_session_id !== source_session_id;
  const source_stayed_isolated = !source_isolation_reply.includes(fork_only_secret);
  console.log(JSON.stringify({ fork_inherited_memory, fork_has_own_session, source_stayed_isolated }, null, 2));
  process.exitCode = fork_inherited_memory && fork_has_own_session && source_stayed_isolated ? 0 : 1;
} finally {
  // Archive by default so spike agents do not pile up in the user's Paseo UI.
  if (!process.argv.includes("--keep")) {
    for (const agent_handle of created_agent_handles) {
      await agent_handle.archive().catch((archive_error) => console.error("archive failed:", agent_handle.id, archive_error.message));
    }
  }
  await paseo_client.close();
}
