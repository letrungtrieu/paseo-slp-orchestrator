import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView } from "react-native";
import { RunsOverviewSection } from "./components/archived-runs-section";
import { RunDetail } from "./components/run-detail";
import { InterruptedRunWarningModal } from "./components/run-warning-dialog";
import { StartRunForm } from "./components/start-run-form";
import { useUiStyles } from "./styles";

// Composition root of the "slp" screen: starts runs, guards active runs with warning dialogs, and restores archived runs.
export function RunControlScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useUiStyles(theme, layout.compact);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

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
          openSupervisorChat(supervisorAgentId);
        }}
      />
      <StartRunForm styles={styles} theme={theme} onRunStarted={handleRunStarted} />
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
    </ScrollView>
  );
}
