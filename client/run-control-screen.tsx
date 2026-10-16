import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { RunDetail } from "./components/run-detail";
import { StartRunForm } from "./components/start-run-form";
import { useUiStyles } from "./styles";
import { describeRpcError, useRunList } from "./use-run";

// This is an explicit run selection; null falls back to the most recently active run.
type NullableId = string | null;

// Composition root of the "slp" screen: owns which run is selected; the form and detail each own their data.
export function RunControlScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useUiStyles(theme, layout.compact);
  // The run created by this screen stays selected while the compact view omits the multi-run history list.
  const [selectedRunId, setSelectedRunId] = useState<NullableId>(null);
  const runListQuery = useRunList();
  // The daemon orders summaries by recent activity, so one latest detail keeps controls available without the long list.
  const latestRunId = runListQuery.data?.runs[0]?.id ?? null;
  const visibleRunId = selectedRunId ?? latestRunId;
  const runListErrorMessage = describeRpcError(runListQuery.error);
  // Older clients may omit navigation, so the run detail keeps working even without direct agent routing.
  const openSupervisorChat = navigation?.openAgent
    ? (supervisorAgentId: string) => navigation.openAgent({ agentId: supervisorAgentId })
    : undefined;
  const handleRunStarted = (startedRunId: string, supervisorAgentId: string) => {
    setSelectedRunId(startedRunId);
    // Creating the prompted child can focus Master Lead, so explicitly focus the parent that talks to the user.
    openSupervisorChat?.(supervisorAgentId);
  };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      // Keep taps on buttons working while a TextInput holds the keyboard on mobile.
      keyboardShouldPersistTaps="handled"
    >
      <StartRunForm styles={styles} theme={theme} onRunStarted={handleRunStarted} />
      {runListErrorMessage ? <Text style={styles.dangerText}>{runListErrorMessage}</Text> : null}
      {visibleRunId ? (
        <RunDetail
          styles={styles}
          theme={theme}
          selectedRunId={visibleRunId}
          onOpenSupervisor={openSupervisorChat}
        />
      ) : null}
    </ScrollView>
  );
}
