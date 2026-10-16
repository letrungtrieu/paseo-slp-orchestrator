import { Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { UiStyles } from "../styles";

interface LabeledInputProps {
  styles: UiStyles;
  theme: PluginTheme;
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (nextText: string) => void;
}

export function LabeledInput({
  styles,
  theme,
  label,
  value,
  placeholder,
  onChangeText,
}: LabeledInputProps) {
  return (
    <View>
      {/* A separate label keeps the field readable after the user types, unlike a placeholder that disappears. */}
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        // The visible label is not tied to the input natively, so the same text is repeated as the accessibility label.
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        // Placeholder colour must come from the theme or it is invisible on dark surfaces.
        placeholderTextColor={theme.colors.foregroundMuted}
        // Paths and provider ids are case-sensitive identifiers; autocorrect would corrupt them.
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
}
