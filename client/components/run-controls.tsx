import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Run } from "../../shared/state";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions } from "../use-run";
import { ActionButton } from "./action-button";
import { ConfirmStopRunModal } from "./run-warning-dialog";

interface RunControlsProps {
  styles: UiStyles;
  theme: PluginTheme;
  run: Run;
  readOnly?: boolean;
  onRestored?: (supervisorAgentId: string) => void;
}

export function RunControls({ styles, theme, run, readOnly = false, onRestored }: RunControlsProps) {
  // Each action keeps its own pending/error state, so retrying a blocked merge never disables or mislabels the stop button.
  const { approveGate, approveMain, abortRun, restoreRun } = useRunActions();
  // Stopping a running SLP session opens a warning dialog so an accidental tap cannot wipe active worktrees.
  const [stopDialogOpen, setStopDialogOpen] = useState(false);

  // Only the first error is shown: the buttons are mutually exclusive in practice and several stacked messages would be noise.
  const controlErrorMessage = describeRpcError(
    approveGate.error ?? approveMain.error ?? abortRun.error ?? restoreRun.error,
  );
  // Runs merge into baseBranch automatically on Supervisor acceptance; this fallback only appears if a dirty base checkout blocked auto-merge.
  const canApproveMain = run.status === "awaiting_user";
  const isRunFinished = run.status === "completed" || run.status === "aborted";
  const canRestoreRun = run.status === "aborted" && !readOnly;

  // Legacy snapshots are historical evidence; exposing their old controls could restart retired work.
  if (readOnly) {
    return <Text style={styles.mutedText}>Legacy task engine · read-only</Text>;
  }

  const handleRestoreRun = async () => {
    const restoredPayload = await restoreRun.mutateAsync({ runId: run.id });
    onRestored?.(restoredPayload.supervisorAgentId);
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
        {canRestoreRun ? (
          <ActionButton
            styles={styles}
            tone="primary"
            label={restoreRun.isPending ? "Đang Restore..." : "Khôi phục (Restore)"}
            accessibilityLabel={`Restore archived SLP run ${run.title}`}
            disabled={restoreRun.isPending}
            onPress={() => {
              void handleRestoreRun();
            }}
          />
        ) : null}
        {/* Active runs open the warning dialog before stopping so the user can archive safely or confirm cleanup. */}
        {isRunFinished ? null : (
          <ActionButton
            styles={styles}
            tone="danger"
            label="Dừng / Archive..."
            accessibilityLabel="Open warning dialog to stop or archive run"
            disabled={abortRun.isPending}
            onPress={() => setStopDialogOpen(true)}
          />
        )}
      </View>
      {controlErrorMessage ? <Text style={styles.dangerText}>{controlErrorMessage}</Text> : null}
      <ConfirmStopRunModal
        styles={styles}
        theme={theme}
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        runId={run.id}
        runTitle={run.title}
        runStatus={run.status}
      />
    </View>
  );
}
