import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { CommLogEntry } from "../../shared/state";
import type { UiStyles } from "../styles";

interface LogEntryRowProps {
  styles: UiStyles;
  theme: PluginTheme;
  logEntry: CommLogEntry;
}

// Blocked/error are the rows an operator hunts for, so they get the loudest colours.
function resolveOutcomeColor(theme: PluginTheme, outcome: CommLogEntry["outcome"]): string {
  switch (outcome) {
    case "delivered":
      return theme.colors.statusSuccess;
    case "queued":
      return theme.colors.statusWarning;
    case "blocked":
    case "error":
      return theme.colors.statusDanger;
    case "info":
      return theme.colors.foregroundMuted;
  }
}

function formatLogTime(isoTimestamp: string): string {
  // toLocaleTimeString follows the viewer's locale; the date is omitted since the monitor only shows recent events.
  const parsedTime = new Date(isoTimestamp);
  // A malformed timestamp must not crash the whole list; show it raw instead.
  return Number.isNaN(parsedTime.getTime()) ? isoTimestamp : parsedTime.toLocaleTimeString();
}

export function LogEntryRow({ styles, theme, logEntry }: LogEntryRowProps) {
  // Computed once and reused for border and badge so the two can never show different colours.
  const outcomeColor = resolveOutcomeColor(theme, logEntry.outcome);
  return (
    // The border colour repeats the outcome so a scan down the list finds blocked/error rows without reading text.
    // The card style is reused (not a new row style) so monitor rows follow the same compact/theme rules as every other panel.
    <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: outcomeColor }]}>
      <View style={styles.row}>
        <Text style={styles.monoText}>{formatLogTime(logEntry.ts)}</Text>
        <Text style={[styles.bodyText, { fontWeight: "600" }]}>
          {logEntry.from} {"->"} {logEntry.to}
        </Text>
        <Text style={styles.mutedText}>{logEntry.kind}</Text>
        <Text
          style={{ color: outcomeColor, fontSize: 12, fontWeight: "700" }}
          // Colour alone is not accessible, so the outcome is also exposed as text for screen readers.
          accessibilityLabel={`Outcome ${logEntry.outcome}`}
        >
          {logEntry.outcome.toUpperCase()}
        </Text>
        {logEntry.taskId ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{logEntry.taskId}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.bodyText}>{logEntry.summary}</Text>
      {logEntry.reason ? <Text style={styles.mutedText}>Reason: {logEntry.reason}</Text> : null}
    </View>
  );
}
