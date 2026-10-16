import { Text, View } from "react-native";
import type { CommLogEntry } from "../../shared/state";
import type { UiStyles } from "../styles";
import { FilterChip } from "./filter-chip";

// Must cover every value of CommLogEntry outcome, otherwise rows of a missing outcome could never be isolated.
export const LOG_OUTCOMES: readonly CommLogEntry["outcome"][] = [
  "delivered",
  "queued",
  "blocked",
  "error",
  "info",
];

interface LogFiltersProps {
  styles: UiStyles;
  selectedOutcome: CommLogEntry["outcome"] | null;
  availableTaskIds: readonly string[];
  selectedTaskId: string | null;
  onSelectOutcome: (nextOutcome: CommLogEntry["outcome"] | null) => void;
  onSelectTaskId: (nextTaskId: string | null) => void;
}

export function LogFilters({
  styles,
  selectedOutcome,
  availableTaskIds,
  selectedTaskId,
  onSelectOutcome,
  onSelectTaskId,
}: LogFiltersProps) {
  return (
    <View style={styles.stack}>
      {/* Outcome comes first because it is the filter used most: the operator usually hunts for blocked or error rows. */}
      <Text style={styles.fieldLabel}>Outcome</Text>
      <View style={styles.row}>
        <FilterChip styles={styles} label="all" selected={selectedOutcome === null} onPress={() => onSelectOutcome(null)} />
        {LOG_OUTCOMES.map((outcomeOption) => (
          <FilterChip
            key={outcomeOption}
            styles={styles}
            label={outcomeOption}
            selected={selectedOutcome === outcomeOption}
            // Pressing the active chip again clears it, saving a trip back to "all".
            onPress={() => onSelectOutcome(selectedOutcome === outcomeOption ? null : outcomeOption)}
          />
        ))}
      </View>
      {/* Hidden until entries carry task ids, so run-level traffic alone does not show an empty, useless filter row. */}
      {availableTaskIds.length > 0 ? (
        <>
          <Text style={styles.fieldLabel}>Task</Text>
          <View style={styles.row}>
            {/* An explicit 'all' chip is the reset; unlike outcomes there is no implicit default chip to fall back to. */}
            <FilterChip styles={styles} label="all" selected={selectedTaskId === null} onPress={() => onSelectTaskId(null)} />
            {availableTaskIds.map((taskIdOption) => (
              <FilterChip
                // Task ids are unique within a run, and the list is rebuilt per run, so the id alone is a stable key.
                key={taskIdOption}
                styles={styles}
                label={taskIdOption}
                selected={selectedTaskId === taskIdOption}
                // Same toggle behaviour as the outcome chips: tapping the active task again returns to "all".
                onPress={() => onSelectTaskId(selectedTaskId === taskIdOption ? null : taskIdOption)}
              />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}
