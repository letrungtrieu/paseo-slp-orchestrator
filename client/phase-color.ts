import type { PluginTheme } from "@getpaseo/plugin";
import type { TaskPhase } from "../shared/state";

// One mapping shared by the Supervisor chat card and the run table so a task never shows
// different colours in different places.
export function resolveTaskPhaseColor(
  theme: PluginTheme,
  taskPhase: TaskPhase,
  hasOpenGate: boolean,
): string {
  // Paused/failed outrank a gate: a human must act, which is more urgent than "waiting".
  if (taskPhase === "paused" || taskPhase === "failed") return theme.colors.statusDanger;
  if (taskPhase === "ready_for_merge" || taskPhase === "merged") return theme.colors.statusSuccess;
  if (hasOpenGate) return theme.colors.statusWarning;
  // Queued is muted because nothing has started and no human action is expected.
  if (taskPhase === "queued") return theme.colors.foregroundMuted;
  return theme.colors.accent;
}
