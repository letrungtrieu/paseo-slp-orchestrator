// Per-project Kanban workspace panel and top-right workspace header icon button registration.
import {
  type PluginButtonRegistration,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";
import { KanbanBoardSection } from "./components/kanban/kanban-board-section";
import { useUiStyles } from "./styles";

// Renders the Spec & Brief Kanban board inside a workspace panel scoped to the active workspace's project root.
export function KanbanWorkspacePanel({
  theme,
  layout,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const styles = useUiStyles(theme, layout.compact);
  // Select primitive project strings with shallow equality so the panel scopes tickets to this workspace's repository.
  const projectRepoPath = useWorkspace(
    workspaceId,
    (workspace) => workspace.projectRootPath || workspace.directory,
  );
  const projectDisplayName = useWorkspace(
    workspaceId,
    (workspace) => workspace.projectDisplayName || workspace.name,
  );

  // Allow jumping straight from the Kanban panel to the project's active Supervisor chat.
  const handleOpenSupervisorChat = (supervisorAgentId: string) => {
    if (!supervisorAgentId) return;
    navigation?.openAgent?.({ agentId: supervisorAgentId });
  };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      // Keep button taps responsive while editing Spec Markdown inside the workspace panel.
      keyboardShouldPersistTaps="handled"
    >
      <KanbanBoardSection
        styles={styles}
        theme={theme}
        projectRepoPath={projectRepoPath}
        projectDisplayName={projectDisplayName}
        onOpenSupervisor={handleOpenSupervisorChat}
      />
    </ScrollView>
  );
}

// Registers a compact icon-only Kanban button in the top-right workspace header bar (next to the VSCode icon) for every workspace.
export function registerWorkspaceKanbanHeaderButtons(
  client: PluginClientContext,
  kanbanPanelId: string,
): () => void {
  const headerButtonByWorkspaceId = new Map<string, PluginButtonRegistration>();
  const subscriptionLifetime = new AbortController();

  // Attach an icon-only header button (label omitted) to the workspace header bar that opens the project's Kanban panel.
  const registerWorkspaceHeaderButton = (workspaceId: string | null | undefined) => {
    if (subscriptionLifetime.signal.aborted || !workspaceId) return;
    if (headerButtonByWorkspaceId.has(workspaceId)) return;
    headerButtonByWorkspaceId.set(
      workspaceId,
      client.addHeaderButton({
        id: kanbanPanelId,
        workspaceId,
        button: {
          title: "Open Project Spec & Brief Kanban",
          icon: "PanelsTopLeft",
          // Omitting `label` renders a small icon button in the top-right workspace header bar beside the VSCode icon.
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel(kanbanPanelId, { workspaceId });
            },
          },
        },
      }),
    );
  };

  // Remove a single workspace's header button when that workspace is removed from the daemon directory.
  const removeWorkspaceHeaderButton = (workspaceId: string) => {
    headerButtonByWorkspaceId.get(workspaceId)?.remove();
    headerButtonByWorkspaceId.delete(workspaceId);
  };

  // Clear all registered header buttons on reconnect snapshot replacement or plugin teardown.
  const removeAllHeaderButtons = () => {
    for (const registration of headerButtonByWorkspaceId.values()) {
      registration.remove();
    }
    headerButtonByWorkspaceId.clear();
  };

  let releaseWorkspaceSubscription: (() => void) | null = null;

  // Observe live workspace directory snapshots and updates so every workspace gets the top-right Kanban icon button.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (subscriptionLifetime.signal.aborted) {
        void subscription.release();
        return undefined;
      }
      const unsubscribeObserver = subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAllHeaderButtons();
          for (const workspaceEntry of entries) {
            registerWorkspaceHeaderButton(workspaceEntry.id);
          }
        },
        update: (outboundMessage) => {
          if (outboundMessage.type !== "workspace_update") return;
          const workspaceUpdate = outboundMessage.payload;
          if (workspaceUpdate.kind === "upsert") {
            registerWorkspaceHeaderButton(workspaceUpdate.workspace.id);
            return;
          }
          removeWorkspaceHeaderButton(workspaceUpdate.id);
        },
      });
      releaseWorkspaceSubscription = () => {
        unsubscribeObserver();
        void subscription.release();
      };
      return undefined;
    })
    .catch((workspaceObservationError) => {
      if (!subscriptionLifetime.signal.aborted) {
        console.error("[slp] Workspace observation for Kanban header button failed", workspaceObservationError);
      }
    });

  return () => {
    subscriptionLifetime.abort();
    releaseWorkspaceSubscription?.();
    removeAllHeaderButtons();
  };
}
