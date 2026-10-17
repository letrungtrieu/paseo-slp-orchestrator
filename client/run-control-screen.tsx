import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";
import { StartRunForm } from "./components/start-run-form";
import { useUiStyles } from "./styles";

// Composition root of the "slp" screen: configures and starts a run, then opens the Supervisor chat.
export function RunControlScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useUiStyles(theme, layout.compact);
  const handleRunStarted = (_startedRunId: string, supervisorAgentId: string) => {
    // Creating the prompted child can focus Master Lead, so explicitly focus the parent that talks to the user.
    navigation?.openAgent?.({ agentId: supervisorAgentId });
  };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      // Keep taps on buttons working while a TextInput holds the keyboard on mobile.
      keyboardShouldPersistTaps="handled"
    >
      <StartRunForm styles={styles} theme={theme} onRunStarted={handleRunStarted} />
    </ScrollView>
  );
}
