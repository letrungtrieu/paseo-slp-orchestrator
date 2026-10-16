import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView } from "react-native";
import { RunDetail } from "./components/run-detail";
import { RunList } from "./components/run-list";
import { StartRunForm } from "./components/start-run-form";
import { useUiStyles } from "./styles";

// Run and task ids are plain strings; null means "nothing picked yet".
type NullableId = string | null;

// Composition root of the "slp" screen: owns only which run is selected; the form, list and
// detail each own their data so a poll of one never re-renders the others.
export function RunControlScreen({ theme, layout }: PluginScreenProps) {
  const styles = useUiStyles(theme, layout.compact);
  // Held here (not in the list) because the form selects the new run after start and the detail reads it.
  const [selectedRunId, setSelectedRunId] = useState<NullableId>(null);

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      // Keep taps on buttons working while a TextInput holds the keyboard on mobile.
      keyboardShouldPersistTaps="handled"
    >
      <StartRunForm styles={styles} theme={theme} onRunStarted={setSelectedRunId} />
      <RunList
        styles={styles}
        theme={theme}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
      />
      {selectedRunId ? (
        <RunDetail styles={styles} theme={theme} selectedRunId={selectedRunId} />
      ) : null}
    </ScrollView>
  );
}
