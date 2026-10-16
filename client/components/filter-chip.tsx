import { Pressable, Text } from "react-native";
import type { UiStyles } from "../styles";

interface FilterChipProps {
  styles: UiStyles;
  label: string;
  selected: boolean;
  onPress: () => void;
}

// Shared by the mode selector and the monitor filters: a toggle that reports its state
// to screen readers via accessibilityState instead of colour alone.
export function FilterChip({ styles, label, selected, onPress }: FilterChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      // The active look is additive on top of the base chip so the layout never shifts when selection changes.
      style={[styles.chip, selected ? styles.chipActive : null]}
    >
      <Text style={selected ? styles.chipTextActive : styles.chipText}>{label}</Text>
    </Pressable>
  );
}
