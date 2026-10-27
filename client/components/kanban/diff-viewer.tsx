// Renders Git-style unified diffs (+ / - / headers) for Spec and Brief revisions in the Kanban UI.
import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { UiStyles } from "../../styles";

interface DiffViewerProps {
  styles: UiStyles;
  theme: PluginTheme;
  diffFromPrevious: string;
}

// Color-codes unified diff lines so operators can immediately spot added, removed, or unchanged Spec/Brief clauses.
function resolveDiffLineColor(theme: PluginTheme, diffLine: string): string {
  // File/revision header lines use muted text so they do not compete with actual content additions or removals.
  if (diffLine.startsWith("+++") || diffLine.startsWith("---")) {
    return theme.colors.foregroundMuted;
  }
  // Added lines (+) use green success color, while removed lines (-) use red danger color.
  if (diffLine.startsWith("+")) {
    return theme.colors.statusSuccess;
  }
  if (diffLine.startsWith("-")) {
    return theme.colors.statusDanger;
  }
  return theme.colors.foreground;
}

// Renders a Git-style unified diff block inside a dark monospace box for Spec and Brief revision inspection.
export function DiffViewer({ styles, theme, diffFromPrevious }: DiffViewerProps) {
  // Guard against empty diffs when a revision had only metadata changes.
  if (!diffFromPrevious.trim()) {
    return <Text style={styles.mutedText}>No diff recorded for this revision.</Text>;
  }

  // Split into individual lines so each added/removed line receives its own semantic color.
  const diffLines = diffFromPrevious.split("\n");

  return (
    <View
      style={{
        padding: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        gap: 2,
      }}
    >
      {diffLines.map((diffLine, lineIndex) => (
        <Text
          key={`${lineIndex}-${diffLine.slice(0, 24)}`}
          style={[
            styles.monoText,
            { color: resolveDiffLineColor(theme, diffLine) },
          ]}
        >
          {diffLine}
        </Text>
      ))}
    </View>
  );
}
