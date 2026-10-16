#!/usr/bin/env bash
# Fork an Antigravity (agy) conversation non-interactively and print the new conversation id.
# agy only supports /fork inside its interactive TUI (print mode rejects it), so this script
# drives the TUI through a detached tmux session.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: agy-fork.sh <conversation-id> [cwd]

Forks an existing agy conversation via the TUI /fork command and prints the
new conversation id on stdout.

Arguments:
  conversation-id   Source conversation UUID (must be idle, not open elsewhere)
  cwd               Workspace directory to open agy in (default: current dir)

Environment:
  AGY_BIN           agy binary (default: agy)
  AGY_FORK_TIMEOUT  Seconds to wait for each TUI step (default: 60)

Example:
  tools/scripts/agy-fork.sh 27ac5843-1a74-46d0-a8f2-461661cc3bee /path/to/repo
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; exit 0; fi
if [[ "${1:-}" == "--desc" ]]; then echo "Fork an agy conversation via its TUI /fork command"; exit 0; fi
if [[ $# -lt 1 ]]; then usage >&2; exit 2; fi

source_conversation_id="$1"
workspace_dir="$(cd "${2:-.}" && pwd)"
agy_bin="${AGY_BIN:-agy}"
step_timeout_seconds="${AGY_FORK_TIMEOUT:-60}"
conversations_dir="$HOME/.gemini/antigravity-cli/conversations"
# Unique tmux session name so concurrent forks never share a pane.
tmux_session="agyfork-$$-$RANDOM"

# Validate the id shape up front; it is interpolated into a command line below.
if [[ ! "$source_conversation_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "error: invalid conversation id: $source_conversation_id" >&2; exit 2
fi
if [[ ! -f "$conversations_dir/$source_conversation_id.db" ]]; then
  echo "error: conversation not found: $source_conversation_id" >&2; exit 1
fi

cleanup() { tmux kill-session -t "$tmux_session" 2>/dev/null || true; }
trap cleanup EXIT

# Snapshot existing conversation ids: other agy sessions may touch their own dbs concurrently,
# so "newest file" is unreliable; the fork is the id that did not exist before.
# An associative set avoids `printf | grep -q`, which breaks under pipefail via SIGPIPE.
declare -A conversations_before_fork=()
for conversation_file in "$conversations_dir"/*.db; do
  conversations_before_fork["$(basename "$conversation_file")"]=1
done

pane_text() { tmux capture-pane -p -t "$tmux_session" 2>/dev/null || true; }

# Poll the pane until a regex appears, failing loudly on timeout so callers can fall back.
wait_for_pane() {
  local expected_pattern="$1" waited_seconds=0
  until pane_text | grep -qE "$expected_pattern"; do
    sleep 1; waited_seconds=$((waited_seconds + 1))
    if (( waited_seconds >= step_timeout_seconds )); then
      echo "error: timed out waiting for: $expected_pattern" >&2
      pane_text | grep -v '^\s*$' | tail -15 >&2
      return 1
    fi
  done
}

tmux new-session -d -s "$tmux_session" -x 200 -y 50 -c "$workspace_dir" \
  "$agy_bin --conversation $source_conversation_id"

# First launch in an untrusted folder shows a trust dialog; accept it, otherwise go straight on.
wait_for_pane 'Do you trust the contents|for shortcuts'
if pane_text | grep -q 'Do you trust the contents'; then
  tmux send-keys -t "$tmux_session" Enter
  wait_for_pane 'for shortcuts'
fi

# Literal typing keeps tmux from interpreting the slash command as key names.
tmux send-keys -t "$tmux_session" -l "/fork"
sleep 1
tmux send-keys -t "$tmux_session" Enter
wait_for_pane 'Forked conversation\.'

# Exit cleanly so the fork's db is flushed and not left open by this TUI.
tmux send-keys -t "$tmux_session" -l "/exit"
tmux send-keys -t "$tmux_session" Enter
sleep 2

forked_conversation_ids=()
for conversation_file in "$conversations_dir"/*.db; do
  conversation_file_name="$(basename "$conversation_file")"
  if [[ -z "${conversations_before_fork[$conversation_file_name]:-}" ]]; then
    forked_conversation_ids+=("${conversation_file_name%.db}")
  fi
done

# Exactly one new conversation is expected; anything else means another process raced us.
if [[ ${#forked_conversation_ids[@]} -ne 1 ]]; then
  echo "error: expected 1 new conversation, found ${#forked_conversation_ids[@]}: ${forked_conversation_ids[*]:-none}" >&2
  exit 1
fi
echo "${forked_conversation_ids[0]}"
