import { Pressable, Text } from "react-native";
import type { UiStyles } from "../styles";

export type ActionButtonTone = "primary" | "secondary" | "danger";

interface ActionButtonProps {
  styles: UiStyles;
  label: string;
  // Spoken label; differs from `label` when the visible text is terse ("Resume").
  accessibilityLabel?: string;
  tone?: ActionButtonTone;
  disabled?: boolean;
  onPress: () => void;
}

export function ActionButton({
  styles,
  label,
  accessibilityLabel,
  tone = "secondary",
  disabled = false,
  onPress,
}: ActionButtonProps) {
  // Tone picks both container and label style from the shared sheet, so intent (primary/danger) is expressed in one prop and stays consistent across screens.
  // Danger is a tone, not a separate component, so every destructive control gets the same outlined look.
  const buttonStyle =
    tone === "primary"
      ? styles.primaryButton
      : tone === "danger"
        ? styles.dangerButton
        : styles.secondaryButton;
  const labelStyle =
    tone === "primary"
      ? styles.primaryButtonText
      : tone === "danger"
        ? styles.dangerButtonText
        : styles.secondaryButtonText;
  return (
    <Pressable
      accessibilityRole="button"
      // Falls back to the visible label so screen readers always have a name even when callers pass no custom one.
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      // Native disabled blocks presses while a mutation is pending, which is what prevents double submits.
      disabled={disabled}
      onPress={onPress}
      // Disabled look is explicit because RN Pressable has no built-in dimming.
      style={[buttonStyle, disabled ? styles.disabled : null]}
    >
      <Text style={labelStyle}>{label}</Text>
    </Pressable>
  );
}
