import { View } from "react-native";
import { RUN_MODES, type RunMode } from "../../shared/roles";
import type { UiStyles } from "../styles";
import { FilterChip } from "./filter-chip";

interface ModeSelectorProps {
  styles: UiStyles;
  selectedMode: RunMode;
  onSelectMode: (nextMode: RunMode) => void;
  disabled?: boolean;
}

// Raw enum names are shown on purpose: they match the vocabulary in specs/MVP.md and the logs.
export function ModeSelector({ styles, selectedMode, onSelectMode, disabled = false }: ModeSelectorProps) {
  return (
    // The shared row style wraps, so three long mode names stack on a phone instead of overflowing.
    <View style={styles.row}>
      {/* Driven by RUN_MODES from shared code, so a new mode in the daemon appears here without a client change. */}
      {RUN_MODES.map((runMode) => (
        <FilterChip
          key={runMode}
          styles={styles}
          label={runMode}
          selected={runMode === selectedMode}
          // Waiting for persistence avoids a second mode change writing against the previous revision.
          disabled={disabled}
          onPress={() => onSelectMode(runMode)}
        />
      ))}
    </View>
  );
}
