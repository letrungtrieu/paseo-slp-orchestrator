import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { StyleSheet } from "react-native";

// Declared before the factory it describes so the exported type can be derived from the real return value.
type StyleFactoryResult = ReturnType<(typeof createUiStyles)>;

// Plugin screens render on desktop and phones, so every dimension that changes with the
// viewport is derived from one `compact` flag instead of ad-hoc breakpoints per component.
export function createUiStyles(theme: PluginTheme, compact: boolean) {
  const pagePadding = compact ? 12 : 20;
  const sectionGap = compact ? 10 : 14;
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: theme.colors.surface0 },
    pageContent: { padding: pagePadding, gap: sectionGap },
    // Panels sit inside a tab that already has its own padding, so cards keep a tighter inset.
    card: {
      gap: 8,
      padding: compact ? 10 : 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    sectionTitle: { color: theme.colors.foreground, fontSize: compact ? 15 : 17, fontWeight: "700" },
    bodyText: { color: theme.colors.foreground, fontSize: 14 },
    mutedText: { color: theme.colors.foregroundMuted, fontSize: 12 },
    monoText: { color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "monospace" },
    dangerText: { color: theme.colors.statusDanger, fontSize: 13 },
    warningText: { color: theme.colors.statusWarning, fontSize: 13 },
    successText: { color: theme.colors.statusSuccess, fontSize: 13 },
    fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 2 },
    // Inputs get taller on compact (touch) layouts so they stay comfortable to hit with a thumb.
    input: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: compact ? 10 : 8,
      fontSize: 14,
    },
    // Select controls keep the same hit area as text inputs while delegating option lists to Paseo's modal.
    selectButton: {
      minHeight: compact ? 42 : 38,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    selectButtonText: { color: theme.colors.foreground, fontSize: 14 },
    selectButtonPlaceholder: { color: theme.colors.foregroundMuted, fontSize: 14 },
    // Role cards show three controls side by side even on phones; shorter insets leave room for Full Access.
    denseSelectButton: { minHeight: compact ? 40 : 34, gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
    denseSelectText: { fontSize: 12 },
    providerRoleCard: {
      gap: 6, padding: 8, borderRadius: 8, borderWidth: 1,
      borderColor: theme.colors.border, backgroundColor: theme.colors.surface2,
    },
    // Three related agent settings share one row without forcing long labels to widen their neighbors.
    providerSettingsRow: { flexDirection: "row", flexWrap: "nowrap", alignItems: "flex-start", gap: 8 },
    providerSettingColumn: { flex: 1, minWidth: 0 },
    // Option rows use a full-width press target so long model names remain easy to choose.
    selectOption: {
      minHeight: compact ? 48 : 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    selectOptionSelected: { backgroundColor: theme.colors.surface2 },
    selectOptionText: { color: theme.colors.foreground, fontSize: 14, flexShrink: 1 },
    // Wrap instead of overflow so the three mode buttons stack on narrow screens.
    row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    stack: { gap: 8 },
    // Buttons grow vertically on compact layouts for touch targets; the three kinds share one shape so only colour signals intent.
    primaryButton: {
      backgroundColor: theme.colors.accent,
      paddingVertical: compact ? 12 : 9,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center",
    },
    primaryButtonText: { color: theme.colors.accentForeground, fontWeight: "600", fontSize: 14 },
    secondaryButton: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      paddingVertical: compact ? 10 : 7,
      paddingHorizontal: 12,
      borderRadius: 8,
      alignItems: "center",
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: 13 },
    // The danger button is outlined, not filled, so a destructive action never looks like the primary call to action.
    dangerButton: {
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      paddingVertical: compact ? 10 : 7,
      paddingHorizontal: 12,
      borderRadius: 8,
      alignItems: "center",
    },
    dangerButtonText: { color: theme.colors.statusDanger, fontSize: 13, fontWeight: "600" },
    disabled: { opacity: 0.5 },
    chip: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.foreground, fontSize: 12 },
    chipTextActive: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" },
  });
}

// Alias keeps the style shape derived from the factory, so adding a style never needs a second edit.
export type UiStyles = StyleFactoryResult;

// Memoised so Pressables and rows do not receive new style objects on every poll refresh.
// Theme and compact are the only inputs, so the memo changes exactly when a theme switch or a resize crosses the breakpoint.
export function useUiStyles(theme: PluginTheme, compact: boolean): UiStyles {
  return useMemo(() => createUiStyles(theme, compact), [theme, compact]);
}
