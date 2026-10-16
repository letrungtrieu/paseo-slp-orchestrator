import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import type { UiStyles } from "../styles";

export interface SelectOption {
  value: string;
  label: string;
  detail?: string;
}

interface SelectFieldProps {
  styles: UiStyles;
  theme: PluginTheme;
  label: string;
  value: string | null;
  options: readonly SelectOption[];
  placeholder: string;
  onValueChange: (nextValue: string) => void;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  dense?: boolean;
  showDetails?: boolean;
}

// A Paseo modal provides the same native menu behavior on desktop, web and compact layouts.
export function SelectField({
  styles,
  theme,
  label,
  value,
  options,
  placeholder,
  onValueChange,
  disabled = false,
  searchable = false,
  searchPlaceholder = "Search options…",
  dense = false,
  showDetails = true,
}: SelectFieldProps) {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  // IDs stay stable when a provider changes the user-facing model label.
  const selectedOption = options.find((option) => option.value === value);
  // An empty catalog cannot produce a useful menu, so it is also treated as disabled.
  const isDisabled = disabled || options.length === 0;
  // Provider IDs are searchable too, which helps distinguish models with repeated display names.
  const normalizedSearchText = searchText.trim().toLowerCase();
  const visibleOptions = searchable
    ? options.filter((option) =>
        [option.label, option.value, option.detail ?? ""].some((searchableText) =>
          searchableText.toLowerCase().includes(normalizedSearchText),
        ),
      )
    : options;
  // Clear stale terms on close so reopening always starts with the full Paseo catalog.
  const changeMenuOpen = (nextMenuOpen: boolean) => {
    setMenuOpen(nextMenuOpen);
    if (!nextMenuOpen) setSearchText("");
  };

  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      {/* Expanded state helps assistive technology announce the controlled menu. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: isDisabled, expanded: isMenuOpen }}
        disabled={isDisabled}
        onPress={() => changeMenuOpen(true)}
        // Dense agent controls retain touch targets while reducing the space spent on secondary settings.
        style={[styles.selectButton, dense ? styles.denseSelectButton : null, isDisabled ? { opacity: 0.55 } : null]}
      >
        {/* Keep the chevron separate so the selected value can shrink on narrow plugin layouts. */}
        <Text
          numberOfLines={1}
          style={[selectedOption ? styles.selectButtonText : styles.selectButtonPlaceholder,
            dense ? styles.denseSelectText : null, { flexShrink: 1 }]}
        >
          {selectedOption?.label ?? placeholder}
        </Text>
        <Text style={styles.selectButtonText}>⌄</Text>
      </Pressable>
      {showDetails && selectedOption?.detail ? (
        /* Repository pickers need path context; agent settings can opt out of these extra lines. */
        <Text style={styles.mutedText}>{selectedOption.detail}</Text>
      ) : null}
      <Modal title={label} open={isMenuOpen} onOpenChange={changeMenuOpen}>
        <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
          {searchable ? (
            <TextInput
              accessibilityLabel={searchPlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setSearchText}
              placeholder={searchPlaceholder}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.input, { marginHorizontal: 12, marginTop: 12, marginBottom: 8 }]}
              value={searchText}
            />
          ) : null}
          {visibleOptions.length === 0 ? (
            <Text style={[styles.mutedText, { padding: 16 }]}>No matching options</Text>
          ) : null}
          {visibleOptions.map((option) => {
            // A selected mark is useful when the label is identical across providers.
            const isSelected = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                onPress={() => {
                  // Close only after the new choice is sent, so controlled menus cannot hide an uncommitted pick.
                  onValueChange(option.value);
                  changeMenuOpen(false);
                }}
                style={[styles.selectOption, isSelected ? styles.selectOptionSelected : null]}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.selectOptionText}>{option.label}</Text>
                  {/* Search still includes hidden details, so provider IDs remain discoverable in concise menus. */}
                  {showDetails && option.detail ? <Text style={styles.mutedText}>{option.detail}</Text> : null}
                </View>
                {isSelected ? (
                  <Text style={{ color: theme.colors.accent, fontWeight: "700" }}>✓</Text>
                ) : null}
              </Pressable>
            );
          })}
        </Modal.Content>
      </Modal>
    </View>
  );
}
