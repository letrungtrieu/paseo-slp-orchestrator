import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { FilterChip } from "./components/filter-chip";
import { LogEntryRow } from "./components/log-entry-row";
import { LogFilters } from "./components/log-filters";
import type { CommLogEntry } from "../shared/state";
import { useUiStyles } from "./styles";
import { describeRpcError, useLogTail, useRunList } from "./use-run";

// Run and task ids are plain strings; null means "nothing picked yet".
type NullableId = string | null;
type OutcomeFilter = CommLogEntry["outcome"] | null;

// Live Tool-Call Monitor (spec section 5, tool 1).
export function MonitorPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const styles = useUiStyles(theme, layout.compact);
  const runListQuery = useRunList();
  // Fallback to an empty list keeps the first render (before the poll answers) free of null checks below.
  const runSummaries = runListQuery.data?.runs ?? [];
  const [pickedRunId, setPickedRunId] = useState<NullableId>(null);
  const [selectedOutcome, setSelectedOutcome] = useState<OutcomeFilter>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<NullableId>(null);

  // Default to the most recently touched run so the panel is useful without any clicks.
  // Memoised because sorting on every 1.5 s log poll would re-run for a list that rarely changes.
  const latestRunId = useMemo(() => {
    const newestFirst = [...runSummaries].sort((first, second) =>
      second.updatedAt.localeCompare(first.updatedAt),
    );
    return newestFirst[0]?.id ?? null;
  }, [runSummaries]);
  // An explicit pick wins; otherwise follow the newest run so a freshly started run takes over the monitor.
  const monitoredRunId = pickedRunId ?? latestRunId;

  const logTailQuery = useLogTail(monitoredRunId);
  const logEntries = logTailQuery.data?.entries ?? [];

  // Task filter options come from the entries actually loaded, so the chips never offer a task with no rows.
  const availableTaskIds = useMemo(
    () => [...new Set(logEntries.flatMap((logEntry) => (logEntry.taskId ? [logEntry.taskId] : [])))].sort(),
    [logEntries],
  );

  // The daemon returns oldest-first (file order); the monitor wants the latest event on top.
  const visibleEntries = useMemo(
    () =>
      logEntries
        .filter((logEntry) => selectedOutcome === null || logEntry.outcome === selectedOutcome)
        .filter((logEntry) => selectedTaskId === null || logEntry.taskId === selectedTaskId)
        // Sorted on the client because the daemon returns file order and the tail limit is applied there; newest-first needs only the rows already fetched.
        .sort((first, second) => second.ts.localeCompare(first.ts)),
    [logEntries, selectedOutcome, selectedTaskId],
  );

  const monitorErrorMessage = describeRpcError(logTailQuery.error ?? runListQuery.error);
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent}>
      <Text style={styles.sectionTitle}>Live Tool-Call Monitor</Text>
      <View style={styles.row}>
        {runSummaries.map((runSummary) => (
          <FilterChip
            key={runSummary.id}
            styles={styles}
            label={runSummary.title}
            selected={runSummary.id === monitoredRunId}
            onPress={() => {
              setPickedRunId(runSummary.id);
              // Task ids are per run, so a stale task filter would hide every row.
              setSelectedTaskId(null);
            }}
          />
        ))}
      </View>
      <LogFilters
        styles={styles}
        selectedOutcome={selectedOutcome}
        availableTaskIds={availableTaskIds}
        selectedTaskId={selectedTaskId}
        onSelectOutcome={setSelectedOutcome}
        onSelectTaskId={setSelectedTaskId}
      />
      {monitorErrorMessage ? <Text style={styles.dangerText}>{monitorErrorMessage}</Text> : null}
      {monitoredRunId === null ? <Text style={styles.mutedText}>No runs to monitor yet.</Text> : null}
      {monitoredRunId !== null && visibleEntries.length === 0 ? (
        <Text style={styles.mutedText}>No matching log entries.</Text>
      ) : null}
      {visibleEntries.map((logEntry, entryIndex) => (
        <LogEntryRow
          // The log has no stable id, so timestamp plus index keeps keys unique when two events share a millisecond.
          key={`${logEntry.ts}-${entryIndex}`}
          styles={styles}
          theme={theme}
          logEntry={logEntry}
        />
      ))}
    </ScrollView>
  );
}
