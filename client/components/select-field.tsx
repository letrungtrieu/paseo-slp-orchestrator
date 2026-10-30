import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import type { UiStyles } from "../styles";
import { filterSelectOptions, type SelectOption } from "../models/provider-selection";

export { filterSelectOptions, type SelectOption };

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
  trailingAction?: ReactNode;
  onOpenMenu?: () => void;
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
  trailingAction,
  onOpenMenu,
}: SelectFieldProps) {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  // IDs stay stable when a provider changes the user-facing model label.
  const selectedOption = options.find((option) => option.value === value);
  // Allow opening the menu to trigger onOpenMenu refresh even when options are currently empty.
  const isDisabled = disabled || (options.length === 0 && !onOpenMenu);
  // Provider IDs and full `provider/model` codes are searchable alongside display labels.
  const visibleOptions = searchable ? filterSelectOptions(options, searchText) : options;
  // Clear stale terms on close so reopening always starts with the full Paseo catalog.
  const changeMenuOpen = (nextMenuOpen: boolean) => {
    if (nextMenuOpen) onOpenMenu?.();
    setMenuOpen(nextMenuOpen);
    if (!nextMenuOpen) setSearchText("");
  };

  return (
    <View style={{ flex: 1, minWidth: 220 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {/* Expanded state helps assistive technology announce the controlled menu. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: isDisabled, expanded: isMenuOpen }}
          disabled={isDisabled}
          onPress={() => changeMenuOpen(true)}
          // Dense agent controls retain touch targets while reducing the space spent on secondary settings.
          style={[
            styles.selectButton,
            { flex: 1 },
            dense ? styles.denseSelectButton : null,
            isDisabled ? { opacity: 0.55 } : null,
          ]}
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
        {trailingAction}
      </View>
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
                  {/* Always show the detail line inside the modal so provider names and `provider/model` codes stay visible while choosing. */}
                  {option.detail ? <Text style={styles.mutedText}>{option.detail}</Text> : null}
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
