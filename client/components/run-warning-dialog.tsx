// Warning dialogs that protect running SLP sessions from accidental x-button closures and destructive aborts.
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { RunSummary } from "../../shared/rpc";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions, useRunList } from "../use-run";
import { ActionButton } from "./action-button";

interface ConfirmStopRunModalProps {
  styles: UiStyles;
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  runTitle: string;
  runStatus: string;
}

// Confirmation modal shown before stopping an active SLP run from SLP Orchestrator.
export function ConfirmStopRunModal({
  styles,
  theme,
  open,
  onOpenChange,
  runId,
  runTitle,
  runStatus,
}: ConfirmStopRunModalProps) {
  const { abortRun } = useRunActions();
  const stopErrorMessage = describeRpcError(abortRun.error);

  const handleArchiveSafely = async () => {
    // Archiving with archiveOnly=true pauses agents while preserving git worktrees and branches for restoration.
    await abortRun.mutateAsync({ runId, archiveOnly: true });
    onOpenChange(false);
  };

  const handlePermanentAbort = async () => {
    // Permanent abort closes agents and cleans up all owned git worktrees and local slp/* branches.
    await abortRun.mutateAsync({ runId, archiveOnly: false });
    onOpenChange(false);
  };

  return (
    <Modal title="Cảnh báo: Tiến trình SLP đang chạy" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <View style={styles.stack}>
          <View
            style={[
              styles.stack,
              {
                padding: 12,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                borderWidth: 1,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text style={styles.sectionTitle}>{runTitle}</Text>
            <Text style={styles.warningText}>
              Tiến trình SLP đang ở trạng thái &quot;{runStatus}&quot;. Nếu xóa toàn bộ tiến trình ngay lúc này, các nhánh
              worktree đang chạy sẽ bị hủy.
            </Text>
            <Text style={styles.bodyText}>
              Bạn có thể chọn &quot;Tạm dừng &amp; Lưu vào Archive&quot; để giữ nguyên toàn bộ code, worktree và khôi phục
              (Restore) lại bất cứ lúc nào trong SLP Orchestrator.
            </Text>
          </View>

          {stopErrorMessage ? <Text style={styles.dangerText}>{stopErrorMessage}</Text> : null}

          <View style={styles.row}>
            <ActionButton
              styles={styles}
              tone="primary"
              label={abortRun.isPending ? "Đang xử lý..." : "Tạm dừng & Lưu vào Archive (Để Restore)"}
              accessibilityLabel={`Archive running SLP ${runTitle} safely for later restore`}
              disabled={abortRun.isPending}
              onPress={() => {
                void handleArchiveSafely();
              }}
            />
            <ActionButton
              styles={styles}
              tone="danger"
              label="Hủy & Xóa toàn bộ worktree"
              accessibilityLabel={`Permanently abort and delete worktrees for ${runTitle}`}
              disabled={abortRun.isPending}
              onPress={() => {
                void handlePermanentAbort();
              }}
            />
            <ActionButton
              styles={styles}
              label="Quay lại (Tiếp tục chạy)"
              accessibilityLabel="Cancel stop and keep SLP running"
              disabled={abortRun.isPending}
              onPress={() => onOpenChange(false)}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

interface InterruptedRunWarningModalProps {
  styles: UiStyles;
  theme: PluginTheme;
  onRestored?: (runId: string, supervisorAgentId: string) => void;
  onOpenOrchestratorScreen?: () => void;
}

// Global watcher modal that alerts the user immediately if an active SLP run was closed via Paseo's x button.
export function InterruptedRunWarningModal({
  styles,
  theme,
  onRestored,
  onOpenOrchestratorScreen,
}: InterruptedRunWarningModalProps) {
  const runListQuery = useRunList();
  const { restoreRun, dismissArchiveWarning, abortRun } = useRunActions();
  const allRuns: RunSummary[] = runListQuery.data?.runs ?? [];

  // Surface the most recently interrupted run whose archiveWarningPending flag is active.
  const pendingArchiveWarningRun =
    allRuns.find((candidateRun) => candidateRun.archiveWarningPending) ?? null;

  if (!pendingArchiveWarningRun) {
    return null;
  }

  const isBusy =
    restoreRun.isPending || dismissArchiveWarning.isPending || abortRun.isPending;
  const actionErrorMessage = describeRpcError(
    restoreRun.error ?? dismissArchiveWarning.error ?? abortRun.error,
  );

  const handleRestoreImmediately = async () => {
    const restoredPayload = await restoreRun.mutateAsync({ runId: pendingArchiveWarningRun.id });
    onRestored?.(restoredPayload.runId, restoredPayload.supervisorAgentId);
  };

  const handleKeepArchivedForLater = async () => {
    // Clearing the warning flag keeps the run safely in the Archived SLP list for later restoration.
    await dismissArchiveWarning.mutateAsync({ runId: pendingArchiveWarningRun.id });
    onOpenOrchestratorScreen?.();
  };

  const handleDeletePermanently = async () => {
    await abortRun.mutateAsync({ runId: pendingArchiveWarningRun.id, archiveOnly: false });
  };

  return (
    <Modal
      title="Cảnh báo: Tiến trình SLP đang chạy vừa bị đóng (Archive)"
      open={true}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) {
          void dismissArchiveWarning.mutateAsync({ runId: pendingArchiveWarningRun.id });
        }
      }}
    >
      <Modal.Content>
        <View style={styles.stack}>
          <View
            style={[
              styles.stack,
              {
                padding: 12,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                borderWidth: 1,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text style={styles.sectionTitle}>{pendingArchiveWarningRun.title}</Text>
            <Text style={styles.mutedText}>
              Repository: {pendingArchiveWarningRun.repoPath} · Trạng thái trước khi đóng:{" "}
              {pendingArchiveWarningRun.archivedFromStatus ?? "running"}
            </Text>
            <Text style={styles.warningText}>
              Phiên SLP này vừa bị đóng (nhấn nút x) khi đang chạy. Để bảo vệ công việc của bạn, SLP Orchestrator đã
              GIỮ NGUYÊN toàn bộ nhánh Git, worktree và trạng thái các stage (không xóa tiến trình).
            </Text>
            <Text style={styles.bodyText}>
              Bạn muốn khôi phục (Restore) để chạy tiếp ngay lập tức hay lưu trong danh sách SLP bị Archive để restore
              sau?
            </Text>
          </View>

          {actionErrorMessage ? <Text style={styles.dangerText}>{actionErrorMessage}</Text> : null}

          <View style={styles.row}>
            <ActionButton
              styles={styles}
              tone="primary"
              label={restoreRun.isPending ? "Đang khôi phục..." : "Khôi phục & Chạy tiếp ngay (Restore)"}
              accessibilityLabel={`Restore interrupted SLP run ${pendingArchiveWarningRun.title}`}
              disabled={isBusy}
              onPress={() => {
                void handleRestoreImmediately();
              }}
            />
            <ActionButton
              styles={styles}
              label="Giữ trong danh sách Archive (Restore sau)"
              accessibilityLabel={`Keep ${pendingArchiveWarningRun.title} in archived list`}
              disabled={isBusy}
              onPress={() => {
                void handleKeepArchivedForLater();
              }}
            />
            <ActionButton
              styles={styles}
              tone="danger"
              label="Xóa hẳn tiến trình & worktree"
              accessibilityLabel={`Permanently delete worktrees for ${pendingArchiveWarningRun.title}`}
              disabled={isBusy}
              onPress={() => {
                void handleDeletePermanently();
              }}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
