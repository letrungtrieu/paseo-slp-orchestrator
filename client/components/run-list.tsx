import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { RunSummary } from "../../shared/rpc";
import { describeRpcError, useRunList } from "../use-run";
import type { UiStyles } from "../styles";

interface RunListProps {
  styles: UiStyles;
  theme: PluginTheme;
  selectedRunId: string | null;
  onSelectRun: (pickedRunId: string) => void;
}

// One line carries the facts an operator scans for: stage, mode, progress and whether a human is needed.
function describeRunSummary(runSummary: RunSummary): string {
  const gateNote = runSummary.openGateCount > 0 ? ` · ${runSummary.openGateCount} gate(s) open` : "";
  return `${runSummary.status} · ${runSummary.mode} · ${runSummary.mergedTaskCount}/${runSummary.taskCount} merged${gateNote}`;
}

export function RunList({ styles, theme, selectedRunId, onSelectRun }: RunListProps) {
  const runListQuery = useRunList();
  // The list query is shared with the monitor through the same key, so both views reuse one poll.
  // Defaults to empty so the first render, before the poll answers, shows the empty state instead of crashing.
  const runSummaries = runListQuery.data?.runs ?? [];
  const listErrorMessage = describeRpcError(runListQuery.error);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Runs</Text>
      {listErrorMessage ? <Text style={styles.dangerText}>{listErrorMessage}</Text> : null}
      {/* Suppressed while an error is shown: 'No runs yet' would be misleading when the list simply failed to load. */}
      {runSummaries.length === 0 && !listErrorMessage ? (
        <Text style={styles.mutedText}>No runs yet.</Text>
      ) : null}
      {runSummaries.map((runSummary) => {
        // Selection lives in the parent screen so the detail panel and the highlight can never disagree.
        const isSelected = runSummary.id === selectedRunId;
        return (
          <Pressable
            key={runSummary.id}
            accessibilityRole="button"
            accessibilityLabel={`Select run ${runSummary.title}`}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelectRun(runSummary.id)}
            // Selection is shown by an accent border so it survives every theme.
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface2 },
              isSelected ? { borderColor: theme.colors.accent } : null,
            ]}
          >
            <Text style={styles.bodyText}>{runSummary.title}</Text>
            <Text style={styles.mutedText}>{describeRunSummary(runSummary)}</Text>
            <Text style={styles.monoText}>{runSummary.repoPath}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
