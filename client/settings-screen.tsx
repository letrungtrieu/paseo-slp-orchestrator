// Paseo Settings entry for SLP Orchestrator exposing the same 4-tab layout (SLP, Skills, Settings, History).
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SlpOrchestratorTabbedView } from "./run-control-screen";

export function SlpSettingsScreen(props: PluginSurfaceProps) {
  return <SlpOrchestratorTabbedView {...props} initialTab="slp" />;
}
