import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { TaskCardData } from "../shared/card";
import { resolveTaskPhaseColor } from "./phase-color";
import { useUiStyles } from "./styles";

// Progress card rendered inside the Supervisor chat. The daemon re-appends the same row id on
// every phase change, so this component stays purely presentational.
export function TaskCard({ item, theme, layout }: PluginTimelineItemProps<TaskCardData>) {
  const styles = useUiStyles(theme, layout.compact);
  // The card payload is the whole truth: it is re-appended on each change, so nothing is derived from previous renders.
  const taskCard = item.data;
  const hasOpenGate = taskCard.gateNote !== null;
  const phaseColor = resolveTaskPhaseColor(theme, taskCard.phase, hasOpenGate);
  // Loop counter is only interesting while the circuit breaker could still trip.
  const showFixLoop = taskCard.fixLoopCount > 0;

  return (
    <View
      accessible
      accessibilityLabel={`Task ${taskCard.taskId}: ${taskCard.phaseLabel}`}
      style={[styles.card, { borderLeftWidth: 4, borderLeftColor: phaseColor }]}
    >
      <Text style={styles.bodyText}>
        {taskCard.taskId} · {taskCard.title}
      </Text>
      <Text style={{ color: phaseColor, fontSize: 14, fontWeight: "700" }}>{taskCard.phaseLabel}</Text>
      {showFixLoop ? (
        <Text style={styles.mutedText}>
          Fix loop {taskCard.fixLoopCount}/{taskCard.fixLoopLimit}
        </Text>
      ) : null}
      {taskCard.gateNote ? <Text style={styles.warningText}>{taskCard.gateNote}</Text> : null}
      {taskCard.pausedReason ? <Text style={styles.dangerText}>{taskCard.pausedReason}</Text> : null}
    </View>
  );
}
