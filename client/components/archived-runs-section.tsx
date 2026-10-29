// Lists active SLP runs and archived SLP runs inside SLP Orchestrator with warning-protected stop and one-click restore.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { RunSummary } from "../../shared/rpc";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions, useRunList } from "../use-run";
import { ActionButton } from "./action-button";
import { ConfirmStopRunModal } from "./run-warning-dialog";

interface RunsOverviewSectionProps {
  styles: UiStyles;
  theme: PluginTheme;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onOpenSupervisor?: (supervisorAgentId: string) => void;
}

const ACTIVE_RUN_STATUS_SET = new Set([
  "initializing",
  "delegating",
  "planning",
  "running",
  "reporting",
  "awaiting_user",
]);

export function RunsOverviewSection({
  styles,
  theme,
  selectedRunId,
  onSelectRun,
  onOpenSupervisor,
}: RunsOverviewSectionProps) {
  const runListQuery = useRunList();
  const { restoreRun, abortRun } = useRunActions();
  const [confirmingStopRun, setConfirmingStopRun] = useState<RunSummary | null>(null);
  const [confirmingCleanupRunId, setConfirmingCleanupRunId] = useState<string | null>(null);
  const [restoringRunId, setRestoringRunId] = useState<string | null>(null);

  const runSummaries = runListQuery.data?.runs ?? [];
  // Separate live executing runs, completed runs, and archived/aborted runs so the History tab covers every session.
  const activeRunSummaries = runSummaries.filter((runSummary) =>
    ACTIVE_RUN_STATUS_SET.has(runSummary.status),
  );
  const completedRunSummaries = runSummaries.filter(
    (runSummary) => runSummary.status === "completed" && !runSummary.archivedAt,
  );
  const archivedRunSummaries = runSummaries.filter(
    (runSummary) => runSummary.status === "aborted" || Boolean(runSummary.archivedAt),
  );

  const sectionErrorMessage = describeRpcError(
    runListQuery.error ?? restoreRun.error ?? abortRun.error,
  );

  const handleRestoreArchivedRun = async (archivedRun: RunSummary) => {
    setRestoringRunId(archivedRun.id);
    try {
      const restoredPayload = await restoreRun.mutateAsync({ runId: archivedRun.id });
      onSelectRun(restoredPayload.runId);
      onOpenSupervisor?.(restoredPayload.supervisorAgentId);
    } finally {
      setRestoringRunId(null);
    }
  };

  const handlePermanentCleanup = async (archivedRunId: string) => {
    setConfirmingCleanupRunId(null);
    await abortRun.mutateAsync({ runId: archivedRunId, archiveOnly: false });
  };

  return (
    <View style={styles.stack}>
      {sectionErrorMessage ? <Text style={styles.dangerText}>{sectionErrorMessage}</Text> : null}

      {/* Active running SLP processes with warning modal protection before stopping/closing. */}
      {activeRunSummaries.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            Tiến trình SLP đang chạy ({activeRunSummaries.length})
          </Text>
          <Text style={styles.mutedText}>
            Đang thực thi. Nhấn &quot;Dừng / Archive&quot; sẽ hiển thị hộp thoại cảnh báo để bảo vệ tiến trình.
          </Text>
          {activeRunSummaries.map((activeRun) => {
            const isSelected = activeRun.id === selectedRunId;
            return (
              <View
                key={activeRun.id}
                style={[
                  styles.stack,
                  {
                    padding: 10,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                    borderWidth: 1,
                    borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                  },
                ]}
              >
                <View style={[styles.row, { justifyContent: "space-between" }]}>
                  <Text style={styles.fieldLabel}>{activeRun.title}</Text>
                  <Text style={styles.warningText}>
                    {activeRun.status} · {activeRun.mode}
                  </Text>
                </View>
                <Text style={styles.mutedText}>
                  {activeRun.repoPath} · Pipelines merged: {activeRun.mergedTaskCount}/{activeRun.taskCount}
                  {activeRun.openGateCount > 0 ? ` · Open gates: ${activeRun.openGateCount}` : ""}
                </Text>
                <View style={styles.row}>
                  {onOpenSupervisor && activeRun.supervisorAgentId ? (
                    <ActionButton
                      styles={styles}
                      tone="primary"
                      label="Mở Supervisor Chat"
                      accessibilityLabel={`Open Supervisor chat for ${activeRun.title}`}
                      onPress={() => onOpenSupervisor(activeRun.supervisorAgentId)}
                    />
                  ) : null}
                  <ActionButton
                    styles={styles}
                    label={isSelected ? "Đang xem chi tiết" : "Xem chi tiết"}
                    accessibilityLabel={`Inspect active run ${activeRun.title}`}
                    onPress={() => onSelectRun(activeRun.id)}
                  />
                  <ActionButton
                    styles={styles}
                    tone="danger"
                    label="Dừng / Archive..."
                    accessibilityLabel={`Stop or archive running SLP ${activeRun.title}`}
                    onPress={() => setConfirmingStopRun(activeRun)}
                  />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Completed SLP sessions so operators can inspect finished runs in the History tab. */}
      {completedRunSummaries.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            Phiên SLP đã hoàn thành ({completedRunSummaries.length})
          </Text>
          {completedRunSummaries.map((completedRun) => {
            const isSelected = completedRun.id === selectedRunId;
            return (
              <View
                key={completedRun.id}
                style={[
                  styles.stack,
                  {
                    padding: 10,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                    borderWidth: 1,
                    borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                  },
                ]}
              >
                <View style={[styles.row, { justifyContent: "space-between" }]}>
                  <Text style={styles.fieldLabel}>{completedRun.title}</Text>
                  <Text style={styles.successText}>
                    {completedRun.status} · {completedRun.mode}
                  </Text>
                </View>
                <Text style={styles.mutedText}>
                  {completedRun.repoPath} · Pipelines merged: {completedRun.mergedTaskCount}/{completedRun.taskCount}
                </Text>
                <View style={styles.row}>
                  {onOpenSupervisor && completedRun.supervisorAgentId ? (
                    <ActionButton
                      styles={styles}
                      label="Mở Supervisor Chat"
                      accessibilityLabel={`Open Supervisor chat for ${completedRun.title}`}
                      onPress={() => onOpenSupervisor(completedRun.supervisorAgentId)}
                    />
                  ) : null}
                  <ActionButton
                    styles={styles}
                    label={isSelected ? "Đang xem chi tiết" : "Xem chi tiết"}
                    accessibilityLabel={`Inspect completed run ${completedRun.title}`}
                    onPress={() => onSelectRun(completedRun.id)}
                  />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Archived SLP runs list allowing the user to restore any interrupted or paused SLP session. */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          Danh sách SLP bị Archive ({archivedRunSummaries.length})
        </Text>
        <Text style={styles.mutedText}>
          Các phiên SLP bị đóng (nhấn nút x) hoặc tạm dừng đều được giữ lại tại đây để bạn Khôi phục (Restore) và chạy
          tiếp.
        </Text>
        {archivedRunSummaries.length === 0 ? (
          <Text style={styles.mutedText}>Chưa có tiến trình SLP nào trong danh sách Archive.</Text>
        ) : (
          archivedRunSummaries.map((archivedRun) => {
            const isSelected = archivedRun.id === selectedRunId;
            const isRestoringThisRun =
              restoreRun.isPending && restoringRunId === archivedRun.id;
            const isCleanupArmed = confirmingCleanupRunId === archivedRun.id;
            const statusLabel = archivedRun.archivedAt
              ? `Archive (từ ${archivedRun.archivedFromStatus ?? "running"})`
              : "Đã dừng (Aborted)";

            return (
              <View
                key={archivedRun.id}
                style={[
                  styles.stack,
                  {
                    padding: 10,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                    borderWidth: 1,
                    borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                  },
                ]}
              >
                <View style={[styles.row, { justifyContent: "space-between" }]}>
                  <Text style={styles.fieldLabel}>{archivedRun.title}</Text>
                  <Text style={styles.mutedText}>
                    {statusLabel} · {archivedRun.mode}
                  </Text>
                </View>
                <Text style={styles.mutedText}>
                  {archivedRun.repoPath} · Pipelines merged: {archivedRun.mergedTaskCount}/{archivedRun.taskCount}
                </Text>
                <View style={styles.row}>
                  <ActionButton
                    styles={styles}
                    tone="primary"
                    label={isRestoringThisRun ? "Đang Restore..." : "Khôi phục (Restore)"}
                    accessibilityLabel={`Restore archived SLP run ${archivedRun.title}`}
                    disabled={restoreRun.isPending || abortRun.isPending}
                    onPress={() => {
                      void handleRestoreArchivedRun(archivedRun);
                    }}
                  />
                  <ActionButton
                    styles={styles}
                    label={isSelected ? "Đang xem chi tiết" : "Xem chi tiết"}
                    accessibilityLabel={`Inspect archived run ${archivedRun.title}`}
                    onPress={() => onSelectRun(archivedRun.id)}
                  />
                  {archivedRun.archivedAt ? (
                    <ActionButton
                      styles={styles}
                      tone="danger"
                      label={isCleanupArmed ? "Xác nhận xóa worktree" : "Xóa worktree"}
                      accessibilityLabel={`Delete worktrees for ${archivedRun.title}`}
                      disabled={abortRun.isPending || restoreRun.isPending}
                      onPress={() => {
                        if (!isCleanupArmed) {
                          setConfirmingCleanupRunId(archivedRun.id);
                          return;
                        }
                        void handlePermanentCleanup(archivedRun.id);
                      }}
                    />
                  ) : null}
                  {isCleanupArmed ? (
                    <ActionButton
                      styles={styles}
                      label="Hủy"
                      onPress={() => setConfirmingCleanupRunId(null)}
                    />
                  ) : null}
                </View>
              </View>
            );
          })
        )}
      </View>

      {confirmingStopRun ? (
        <ConfirmStopRunModal
          styles={styles}
          theme={theme}
          open={true}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setConfirmingStopRun(null);
          }}
          runId={confirmingStopRun.id}
          runTitle={confirmingStopRun.title}
          runStatus={confirmingStopRun.status}
        />
      ) : null}
    </View>
  );
}
