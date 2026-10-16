import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import { FIX_LOOP_LIMIT } from "../../shared/roles";
import { phaseLabel } from "../../shared/card";
import type { Task } from "../../shared/state";
import { resolveTaskPhaseColor } from "../phase-color";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions } from "../use-run";
import { ActionButton } from "./action-button";
import { LabeledInput } from "./labeled-input";

interface TaskRowProps {
  styles: UiStyles;
  theme: PluginTheme;
  runId: string;
  task: Task;
}

export function TaskRow({ styles, theme, runId, task }: TaskRowProps) {
  // Actions are created per row so one task's pending state does not disable buttons of its siblings.
  const { approveGate, resumeTask } = useRunActions();
  // Kept per row: guidance typed for one paused task must not leak into another task's resume.
  const [resumeGuidance, setResumeGuidance] = useState("");

  // Gate and phase feed the same colour function as the chat card, so an open gate looks identical in both places.
  const taskPhaseColor = resolveTaskPhaseColor(theme, task.phase, task.gate !== null);
  // The label comes from the shared module so the table and the Supervisor chat card never disagree on wording.
  const taskPhaseText = phaseLabel(task.phase, task.fixLoopCount, FIX_LOOP_LIMIT);
  // Only a paused task can be resumed; the daemon rejects resume for any other phase.
  const isPausedForHuman = task.phase === "paused";
  const rowErrorMessage = describeRpcError(approveGate.error ?? resumeTask.error);

  return (
    <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: taskPhaseColor }]}>
      <Text style={styles.bodyText}>
        {task.id} · {task.title}
      </Text>
      <Text style={{ color: taskPhaseColor, fontSize: 13, fontWeight: "600" }}>{taskPhaseText}</Text>
      {/* Always shown in the table (unlike the chat card) so the operator sees how close a task is to the circuit breaker. */}
      <Text style={styles.mutedText}>
        Fix loop {task.fixLoopCount}/{FIX_LOOP_LIMIT}
      </Text>
      {task.pausedReason ? <Text style={styles.dangerText}>Paused: {task.pausedReason}</Text> : null}

      {/* Task gates are approved per task (taskId is sent), unlike the run-level gate in the run controls. */}
      {task.gate ? (
        <View style={[styles.stack, { padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 }]}>
          <Text style={styles.warningText}>
            Waiting at gate {task.gate.kind}: {task.gate.note}
          </Text>
          <ActionButton
            styles={styles}
            tone="primary"
            label="Duyệt & chạy tiếp"
            accessibilityLabel={`Approve gate and continue task ${task.id}`}
            disabled={approveGate.isPending}
            // The visible label is Vietnamese because the Supreme Manager works in Vietnamese; the accessibility label stays English for tooling.
            onPress={() => approveGate.mutate({ runId, taskId: task.id })}
          />
        </View>
      ) : null}

      {isPausedForHuman ? (
        <View style={styles.stack}>
          <LabeledInput
            styles={styles}
            theme={theme}
            label="Guidance for resume (optional)"
            value={resumeGuidance}
            onChangeText={setResumeGuidance}
          />
          <ActionButton
            styles={styles}
            label="Resume"
            accessibilityLabel={`Resume paused task ${task.id}`}
            disabled={resumeTask.isPending}
            onPress={() =>
              resumeTask.mutate({
                runId,
                taskId: task.id,
                // Blank guidance is dropped so the daemon does not inject an empty prompt.
                guidance: resumeGuidance.trim() === "" ? undefined : resumeGuidance.trim(),
              })
            }
          />
        </View>
      ) : null}
      {rowErrorMessage ? <Text style={styles.dangerText}>{rowErrorMessage}</Text> : null}
    </View>
  );
}
