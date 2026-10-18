#!/usr/bin/env bash
# Dynamically discover executable commands in tools/bin and print their one-line descriptions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_BIN_DIR="${SCRIPT_DIR}/bin"

# Exit cleanly when the project has not created any tools/bin commands yet.
if [[ ! -d "${TOOLS_BIN_DIR}" ]]; then
  exit 0
fi

for tool_executable in "${TOOLS_BIN_DIR}"/*; do
  # Skip non-regular or non-executable files so stray artifacts never break discovery.
  if [[ ! -f "${tool_executable}" || ! -x "${tool_executable}" ]]; then
    continue
  fi
  tool_name="$(basename "${tool_executable}")"
  # Continue scanning remaining tools even if one command fails its --desc contract.
  if tool_description="$("${tool_executable}" --desc 2>/dev/null)"; then
    printf "%s: %s\n" "${tool_name}" "${tool_description}"
  fi
done
