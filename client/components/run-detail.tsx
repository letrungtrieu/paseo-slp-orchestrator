import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { describeRpcError, useRunDetail } from "../use-run";
import type { UiStyles } from "../styles";
import { RunControls } from "./run-controls";
import { TaskRow } from "./task-row";

interface RunDetailProps {
  styles: UiStyles;
  theme: PluginTheme;
  selectedRunId: string;
}

export function RunDetail({ styles, theme, selectedRunId }: RunDetailProps) {
  // The detail owns its own poll so a 2 s refresh re-renders only this panel, not the form or the list.
  const runDetailQuery = useRunDetail(selectedRunId);
  // Null both while loading and when unknown; the isLoading flag below tells the two apart.
  const selectedRun = runDetailQuery.data?.run ?? null;
  const detailErrorMessage = describeRpcError(runDetailQuery.error);

  // The error comes first so a failing poll is visible instead of silently showing a stale run.
  if (detailErrorMessage) {
    return <Text style={styles.dangerText}>{detailErrorMessage}</Text>;
  }
  if (!selectedRun) {
    // `run: null` means the daemon no longer knows this id (e.g. state was reset).
    return (
      <Text style={styles.mutedText}>
        {runDetailQuery.isLoading ? "Loading run..." : "Run not found."}
      </Text>
    );
  }

  // Sorted by creation-independent id so rows do not jump around between polls.
  const sortedTasks = Object.values(selectedRun.tasks).sort((firstTask, secondTask) =>
    firstTask.id.localeCompare(secondTask.id),
  );

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>{selectedRun.title}</Text>
      <Text style={styles.mutedText}>
        {selectedRun.status} · {selectedRun.baseBranch} ← {selectedRun.integrationBranch}
      </Text>
      {/* Surfaced because a degraded fork means the Forked Lead got a spec-file briefing, which changes how much to trust the handshake. */}
      {selectedRun.forkDegradedReason ? (
        <Text style={styles.warningText}>Fork degraded: {selectedRun.forkDegradedReason}</Text>
      ) : null}
      {selectedRun.criteria ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Acceptance criteria</Text>
          <Text style={styles.bodyText}>{selectedRun.criteria}</Text>
        </View>
      ) : null}
      {/* Controls receive the whole run so gate and status checks use the same snapshot as the task rows below. */}
      <RunControls styles={styles} theme={theme} run={selectedRun} />
      <Text style={styles.sectionTitle}>Tasks ({sortedTasks.length})</Text>
      {sortedTasks.length === 0 ? <Text style={styles.mutedText}>No tasks defined yet.</Text> : null}
      {sortedTasks.map((task) => (
        <TaskRow key={task.id} styles={styles} theme={theme} runId={selectedRun.id} task={task} />
      ))}
      {selectedRun.finalReport ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Final report</Text>
          <Text style={styles.bodyText}>{selectedRun.finalReport}</Text>
        </View>
      ) : null}
    </View>
  );
}
