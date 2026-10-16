import { Pressable, Text } from "react-native";
import type { UiStyles } from "../styles";

interface FilterChipProps {
  styles: UiStyles;
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}

// Shared by the mode selector and the monitor filters: a toggle that reports its state
// to screen readers via accessibilityState instead of colour alone.
export function FilterChip({ styles, label, selected, onPress, disabled = false }: FilterChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      // Saving global settings locks the chips until Paseo returns the next document revision.
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      // The active look is additive on top of the base chip so the layout never shifts when selection changes.
      style={[styles.chip, selected ? styles.chipActive : null, disabled ? styles.disabled : null]}
    >
      <Text style={selected ? styles.chipTextActive : styles.chipText}>{label}</Text>
    </Pressable>
  );
}
