import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Run } from "../../shared/state";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions } from "../use-run";
import { ActionButton } from "./action-button";

interface RunControlsProps {
  styles: UiStyles;
  theme: PluginTheme;
  run: Run;
  readOnly?: boolean;
}

export function RunControls({ styles, theme, run, readOnly = false }: RunControlsProps) {
  // Each action keeps its own pending/error state, so retrying a blocked merge never disables or mislabels the abort button.
  const { approveGate, approveMain, abortRun } = useRunActions();
  // Abort is destructive and irreversible, so the first press only arms it.
  const [abortArmed, setAbortArmed] = useState(false);

  // Only the first error is shown: the buttons are mutually exclusive in practice and several stacked messages would be noise.
  const controlErrorMessage = describeRpcError(
    approveGate.error ?? approveMain.error ?? abortRun.error,
  );
  // Runs merge into baseBranch automatically on Supervisor acceptance; this fallback only appears if a dirty base checkout blocked auto-merge.
  const canApproveMain = run.status === "awaiting_user";
  const isRunFinished = run.status === "completed" || run.status === "aborted";

  // Legacy snapshots are historical evidence; exposing their old controls could restart retired work.
  if (readOnly) {
    return <Text style={styles.mutedText}>Legacy task engine · read-only</Text>;
  }

  // Two-step abort: a mistap on a phone must not archive every agent and discard the run, so the second press confirms.
  const pressAbort = () => {
    if (!abortArmed) {
      setAbortArmed(true);
      return;
    }
    // Disarmed before mutating so a slow request cannot leave the button in the confirm state.
    setAbortArmed(false);
    abortRun.mutate({ runId: run.id });
  };

  return (
    <View style={styles.stack}>
      {run.gate ? (
        <View style={[styles.stack, { padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 }]}>
          <Text style={styles.warningText}>
            Run gate {run.gate.kind}: {run.gate.note}
          </Text>
          <ActionButton
            styles={styles}
            tone="primary"
            label="Duyệt & chạy tiếp"
            accessibilityLabel="Approve run level gate and continue"
            disabled={approveGate.isPending}
            // Omitting taskId targets the run level gate (see approveGateRpc).
            onPress={() => approveGate.mutate({ runId: run.id })}
          />
        </View>
      ) : null}

      <View style={styles.row}>
        {canApproveMain ? (
          <ActionButton
            styles={styles}
            tone="primary"
            label="Approve -> main"
            accessibilityLabel={`Approve merging ${run.integrationBranch} into ${run.baseBranch}`}
            disabled={approveMain.isPending}
            onPress={() => approveMain.mutate({ runId: run.id })}
          />
        ) : null}
        {/* Finished runs hide Abort: there is nothing left to archive and the merge cannot be undone anyway. */}
        {isRunFinished ? null : (
          <ActionButton
            styles={styles}
            tone="danger"
            label={abortArmed ? "Press again to abort" : "Abort"}
            accessibilityLabel={abortArmed ? "Confirm abort run" : "Abort run"}
            disabled={abortRun.isPending}
            onPress={pressAbort}
          />
        )}
        {abortArmed ? (
          // Cancel appears only while armed, giving the operator an explicit way out of the confirm state. *
          <ActionButton styles={styles} label="Cancel" onPress={() => setAbortArmed(false)} />
        ) : null}
      </View>
      {controlErrorMessage ? <Text style={styles.dangerText}>{controlErrorMessage}</Text> : null}
    </View>
  );
}
