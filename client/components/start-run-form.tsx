import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { RunMode } from "../../shared/roles";
import { describeRpcError, useRunActions } from "../use-run";
import type { UiStyles } from "../styles";
import { ActionButton } from "./action-button";
import { LabeledInput } from "./labeled-input";
import { ModeSelector } from "./mode-selector";

// Shown as a placeholder (not a default value) so an empty field really means 'let the daemon pick'.
const PROVIDER_PLACEHOLDER = "claude/claude-sonnet-5-5";

interface StartRunFormProps {
  styles: UiStyles;
  theme: PluginTheme;
  onRunStarted: (startedRunId: string) => void;
}

export function StartRunForm({ styles, theme, onRunStarted }: StartRunFormProps) {
  const { startRun } = useRunActions();
  // Form state is local: nothing is sent until Start run, so typing never touches the daemon.
  const [repoPath, setRepoPath] = useState("");
  const [runTitle, setRunTitle] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  // Starts in STEP_BY_STEP_DEBUG: the safest mode for a first run, and it can be switched later from the run controls.
  const [runMode, setRunMode] = useState<RunMode>("STEP_BY_STEP_DEBUG");
  const [supervisorProvider, setSupervisorProvider] = useState("");
  const [leadProvider, setLeadProvider] = useState("");
  const [peerProvider, setPeerProvider] = useState("");

  // Empty optional fields must be omitted, not sent as "", so the daemon applies its defaults.
  const omitIfBlank = (typedText: string) => (typedText.trim() === "" ? undefined : typedText.trim());

  // Trimmed here because a pasted path often carries a trailing newline that git would reject.
  const submitRun = () => {
    startRun.mutate(
      {
        repoPath: repoPath.trim(),
        title: omitIfBlank(runTitle),
        baseBranch: omitIfBlank(baseBranch),
        mode: runMode,
        supervisorProvider: omitIfBlank(supervisorProvider),
        leadProvider: omitIfBlank(leadProvider),
        peerProvider: omitIfBlank(peerProvider),
      },
      // The new run is selected on success so the operator lands on its gates and tasks immediately.
      { onSuccess: (startedRun) => onRunStarted(startedRun.runId) },
    );
  };

  // Daemon-side failures (not a git repo, detached HEAD) arrive as thrown RPC errors and are shown inline under the button.
  const startErrorMessage = describeRpcError(startRun.error);
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Start run</Text>
      <LabeledInput styles={styles} theme={theme} label="Repository path" value={repoPath} onChangeText={setRepoPath} placeholder="/absolute/path/to/repo" />
      <LabeledInput styles={styles} theme={theme} label="Title (optional)" value={runTitle} onChangeText={setRunTitle} />
      <LabeledInput styles={styles} theme={theme} label="Base branch (optional)" value={baseBranch} onChangeText={setBaseBranch} placeholder="main" />
      <Text style={styles.fieldLabel}>Mode</Text>
      <ModeSelector styles={styles} selectedMode={runMode} onSelectMode={setRunMode} />
      <LabeledInput styles={styles} theme={theme} label="Supervisor provider" value={supervisorProvider} onChangeText={setSupervisorProvider} placeholder={PROVIDER_PLACEHOLDER} />
      <LabeledInput styles={styles} theme={theme} label="Lead provider" value={leadProvider} onChangeText={setLeadProvider} placeholder={PROVIDER_PLACEHOLDER} />
      <LabeledInput styles={styles} theme={theme} label="Peer provider" value={peerProvider} onChangeText={setPeerProvider} placeholder={PROVIDER_PLACEHOLDER} />
      <ActionButton
        styles={styles}
        tone="primary"
        label={startRun.isPending ? "Starting..." : "Start run"}
        accessibilityLabel="Start SLP run"
        // A blank repo path can never succeed, and double-submit would spawn two runs.
        disabled={repoPath.trim() === "" || startRun.isPending}
        onPress={submitRun}
      />
      {startErrorMessage ? <Text style={styles.dangerText}>{startErrorMessage}</Text> : null}
    </View>
  );
}
