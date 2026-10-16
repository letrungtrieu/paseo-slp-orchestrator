import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { TASK_CARD_KIND, TASK_CARD_VERSION, TaskCardSchema } from "./shared/card";
import { MonitorPanel } from "./client/monitor-panel";
import { RunControlScreen } from "./client/run-control-screen";
import { TaskCard } from "./client/task-card";
import { SlpSettingsScreen } from "./client/settings-screen";

// A single stable id is shared by the screen and the sidebar row so the row can tell when its own screen is the one on display.
const RUN_SCREEN_ID = "slp";
const MONITOR_PANEL_ID = "slp-monitor";

function SlpSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Workflow"
      active={currentScreen?.screenId === RUN_SCREEN_ID}
      // openScreen replaces the current screen instead of stacking, so repeated clicks on the sidebar row never pile up screens.
      onPress={() => openScreen({ screenId: RUN_SCREEN_ID })}
    />
  );
}

// Contributions are registered synchronously and unregistered by the returned cleanup, so a plugin reload leaves no duplicate panels.
export default function contribute(client: PluginClientContext) {
  // Each add* returns a remover; collecting them lets the entry cleanup undo everything in one go.
  const removers = [
    // A native settings entry exposes the same persisted defaults as the Start run form.
    client.addSettingsScreen({ id: RUN_SCREEN_ID, title: "SLP Orchestrator", icon: "Workflow", Component: SlpSettingsScreen }),
    client.addScreen({ id: RUN_SCREEN_ID, title: "SLP Orchestrator", Component: RunControlScreen }),
    client.addSidebarHeaderItem({ id: RUN_SCREEN_ID, title: "SLP Orchestrator", Component: SlpSidebarItem }),
    client.addWorkspacePanel({
      id: MONITOR_PANEL_ID,
      title: "SLP Monitor",
      icon: "Activity",
      // The monitor is a workspace panel (not a screen) so it can sit beside an agent chat while a run is in progress.
      context: "workspace",
      Component: MonitorPanel,
    }),
    client.addCommandCenterItem({
      id: "open-slp-monitor",
      title: "Open SLP Live Tool-Call Monitor",
      icon: "Activity",
      context: "workspace",
      keywords: ["slp", "monitor", "log", "orchestrator"],
      onSelect({ openPanel }) {
        openPanel(MONITOR_PANEL_ID);
      },
    }),
    // The card is registered with kind + version + schema: Paseo only renders rows whose payload validates, so an older stored card degrades to hidden instead of crashing.
    client.addTimelineRenderer({
      kind: TASK_CARD_KIND,
      version: TASK_CARD_VERSION,
      schema: TaskCardSchema,
      Component: TaskCard,
    }),
  ];
  return () => {
    for (const removeContribution of removers) removeContribution();
  };
}
