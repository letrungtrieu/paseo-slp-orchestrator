// Tabbed SLP Orchestrator screen dividing controls into 4 focused tabs: SLP, Skills, Settings, and History.
import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AgentDefaultSettings } from "./components/agent-default-settings";
import { RunsOverviewSection } from "./components/archived-runs-section";
import { ProjectSkillsTab } from "./components/project-skills-tab";
import { RunDetail } from "./components/run-detail";
import { InterruptedRunWarningModal } from "./components/run-warning-dialog";
import { StartRunForm } from "./components/start-run-form";
import { useUiStyles } from "./styles";
import { useProviderCatalog } from "./use-provider-catalog";
import { useSlpSettings } from "./use-slp-settings";

export type SlpOrchestratorTabId = "slp" | "skills" | "settings" | "history";

const ORCHESTRATOR_TABS: ReadonlyArray<{ id: SlpOrchestratorTabId; label: string }> = [
  { id: "slp", label: "SLP" },
  { id: "skills", label: "Skills" },
  { id: "settings", label: "Settings" },
  { id: "history", label: "History" },
];

// Shared 4-tab view rendered by both the main SLP Orchestrator screen and the Paseo Settings screen.
export function SlpOrchestratorTabbedView({
  theme,
  host,
  layout,
  navigation,
  initialTab = "slp",
}: PluginSurfaceProps & { initialTab?: SlpOrchestratorTabId }) {
  const styles = useUiStyles(theme, layout.compact);
  const [activeTab, setActiveTab] = useState<SlpOrchestratorTabId>(initialTab);
  const [selectedHostId, setSelectedHostId] = useState<string>(host.id);
  const [selectedRepositoryPath, setSelectedRepositoryPath] = useState<string>("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Resolve provider models in the selected host and project context so the Settings tab reflects available models.
  const providerCatalog = useProviderCatalog(selectedRepositoryPath, selectedHostId);
  const slpSettings = useSlpSettings(providerCatalog);

  const openSupervisorChat = (supervisorAgentId: string) => {
    if (!supervisorAgentId) return;
    // Creating or restoring child cohorts can shift focus, so explicitly focus the Supervisor chat for the operator.
    navigation?.openAgent?.({ agentId: supervisorAgentId });
  };

  const handleRunStarted = (startedRunId: string, supervisorAgentId: string) => {
    setSelectedRunId(startedRunId);
    openSupervisorChat(supervisorAgentId);
  };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      // Keep taps on buttons working while a TextInput holds the keyboard on mobile.
      keyboardShouldPersistTaps="handled"
    >
      <InterruptedRunWarningModal
        styles={styles}
        theme={theme}
        onRestored={(restoredRunId, supervisorAgentId) => {
          setSelectedRunId(restoredRunId);
          setActiveTab("history");
          openSupervisorChat(supervisorAgentId);
        }}
      />

      {/* Top tab bar dividing SLP Orchestrator into SLP, Skills, Settings, and History. */}
      <View
        style={[
          styles.row,
          {
            padding: 4,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          },
        ]}
      >
        {ORCHESTRATOR_TABS.map((tabOption) => {
          const isTabActive = activeTab === tabOption.id;
          return (
            <Pressable
              key={tabOption.id}
              onPress={() => setActiveTab(tabOption.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: isTabActive }}
              accessibilityLabel={`Switch to ${tabOption.label} tab`}
              style={{
                flex: 1,
                minWidth: 80,
                paddingVertical: layout.compact ? 10 : 8,
                paddingHorizontal: 12,
                borderRadius: 8,
                alignItems: "center",
                backgroundColor: isTabActive ? theme.colors.accent : "transparent",
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: isTabActive ? "700" : "600",
                  color: isTabActive ? theme.colors.accentForeground : theme.colors.foreground,
                }}
              >
                {tabOption.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Tab 1 (SLP): Start a new SLP session with host selection, project selection, and a ready ticket. */}
      {activeTab === "slp" ? (
        <StartRunForm
          styles={styles}
          theme={theme}
          currentHost={host}
          selectedHostId={selectedHostId}
          onSelectHostId={setSelectedHostId}
          selectedRepositoryPath={selectedRepositoryPath}
          onSelectRepositoryPath={setSelectedRepositoryPath}
          onRunStarted={handleRunStarted}
        />
      ) : null}

      {/* Tab 2 (Skills): Initialize the project-scoped slp-manager skill and reload role workflows. */}
      {activeTab === "skills" ? (
        <ProjectSkillsTab
          styles={styles}
          theme={theme}
          currentHost={host}
          selectedHostId={selectedHostId}
          onSelectHostId={setSelectedHostId}
          selectedRepositoryPath={selectedRepositoryPath}
          onSelectRepositoryPath={setSelectedRepositoryPath}
        />
      ) : null}

      {/* Tab 3 (Settings): Configure agent models, shell watchdog heartbeat timeout, and max rework round loops. */}
      {activeTab === "settings" ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Agent & Orchestration Settings</Text>
          <AgentDefaultSettings
            styles={styles}
            theme={theme}
            catalog={providerCatalog}
            settings={slpSettings}
          />
        </View>
      ) : null}

      {/* Tab 4 (History): Inspect active, completed, and archived SLP sessions and restore interrupted runs. */}
      {activeTab === "history" ? (
        <View style={styles.stack}>
          <RunsOverviewSection
            styles={styles}
            theme={theme}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            onOpenSupervisor={openSupervisorChat}
          />
          {selectedRunId ? (
            <RunDetail
              styles={styles}
              theme={theme}
              selectedRunId={selectedRunId}
              onOpenSupervisor={openSupervisorChat}
            />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

// Composition root of the "slp" screen opened from the left sidebar Workflow icon.
export function RunControlScreen(props: PluginScreenProps) {
  return <SlpOrchestratorTabbedView {...props} initialTab="slp" />;
}
