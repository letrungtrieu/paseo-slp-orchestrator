// Focused "SLP" tab form for starting an SLP run from a ticket prepared on the project Kanban board.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { describeTicketRunBlocker } from "../../shared/board";
import type { UiStyles } from "../styles";
import { useBoardTickets } from "../use-board";
import { describeRpcError, useRunActions } from "../use-run";
import { useRunStartOptions } from "../use-run-start-options";
import { ActionButton } from "./action-button";
import { RepositoryFolderPicker } from "./repository-folder-picker";

interface StartRunFormProps {
  styles: UiStyles;
  theme: PluginTheme;
  onRunStarted: (startedRunId: string, supervisorAgentId: string) => void;
  selectedRepositoryPath?: string;
  onSelectRepositoryPath?: (nextRepositoryPath: string) => void;
  currentHost?: { id: string; label: string };
  selectedHostId?: string;
  onSelectHostId?: (nextHostId: string) => void;
}

export function StartRunForm({
  styles,
  theme,
  onRunStarted,
  selectedRepositoryPath,
  onSelectRepositoryPath,
  currentHost,
  selectedHostId,
  onSelectHostId,
}: StartRunFormProps) {
  const { startRun } = useRunActions();
  // Support controlled repository selection shared across tabs while keeping local state as a fallback.
  const [internalRepoPath, setInternalRepoPath] = useState("");
  const effectiveRepoPath = selectedRepositoryPath ?? internalRepoPath;
  const handleSelectRepoPath = onSelectRepositoryPath ?? setInternalRepoPath;

  const [selectedTicketKey, setSelectedTicketKey] = useState<string | null>(null);
  const { runInput, isReady, settings, promptsErrorMessage } = useRunStartOptions(
    effectiveRepoPath,
    selectedHostId,
  );
  const { orchestration } = settings.configuration;
  const [spawnWorktrees, setSpawnWorktrees] = useState<boolean>(
    orchestration.spawnWorktrees ?? true,
  );
  // Keep the local checkbox synced with persisted host settings when loaded.
  useEffect(() => {
    setSpawnWorktrees(orchestration.spawnWorktrees ?? true);
  }, [orchestration.spawnWorktrees]);

  // Only prepared tickets can start a Run, because a Run delivers an approved mockup and Spec rather than a new idea.
  const boardQuery = useBoardTickets({ repoPath: effectiveRepoPath || null });
  const readyTickets = (boardQuery.data?.tickets ?? []).filter(
    (ticket) => describeTicketRunBlocker(ticket) === null,
  );
  const selectedTicket =
    readyTickets.find((ticket) => ticket.ticketKey === selectedTicketKey) ?? null;

  // Trimmed here because a pasted path often carries a trailing newline that git would reject.
  const submitRun = () => {
    if (!selectedTicket) return;
    startRun.mutate(
      {
        ...runInput,
        repoPath: effectiveRepoPath.trim(),
        name: selectedTicket.title,
        ticketId: selectedTicket.ticketKey,
        spawnWorktrees,
      },
      // The Supervisor is the human's control point; pass its id so the client can open that chat after creation.
      { onSuccess: (startedRun) => onRunStarted(startedRun.runId, startedRun.supervisorAgentId) },
    );
  };

  const handleToggleSpawnWorktrees = () => {
    const nextValue = !spawnWorktrees;
    setSpawnWorktrees(nextValue);
    settings.changeOrchestration({
      ...orchestration,
      spawnWorktrees: nextValue,
    });
  };

  // Daemon-side failures (not a git repo, detached HEAD) arrive as thrown RPC errors and are shown inline under the button.
  const startErrorMessage = describeRpcError(startRun.error) ?? promptsErrorMessage;
  const isStartDisabled = !isReady || !selectedTicket || startRun.isPending;

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Start SLP</Text>
      <RepositoryFolderPicker
        styles={styles}
        theme={theme}
        selectedRepositoryPath={effectiveRepoPath}
        onSelectRepositoryPath={handleSelectRepoPath}
        currentHost={currentHost}
        selectedHostId={selectedHostId}
        onSelectHostId={onSelectHostId}
      />
      <Text style={styles.fieldLabel}>Ready Ticket</Text>
      {readyTickets.length === 0 ? (
        <Text style={styles.mutedText}>
          No ready tickets. Open the project Kanban board, shape a feature with + New Feature, approve its mockup and write its Spec.
        </Text>
      ) : (
        <View style={styles.row}>
          {readyTickets.map((readyTicket) => {
            const isSelectedTicket = readyTicket.ticketKey === selectedTicketKey;
            return (
              <Pressable
                key={readyTicket.id}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelectedTicket }}
                accessibilityLabel={`Select ${readyTicket.ticketKey} ${readyTicket.title}`}
                onPress={() => setSelectedTicketKey(readyTicket.ticketKey)}
                style={[
                  styles.chip,
                  { borderColor: isSelectedTicket ? theme.colors.accent : theme.colors.border },
                ]}
              >
                <Text style={styles.chipText}>
                  {readyTicket.ticketKey} · {readyTicket.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {/* Checkbox allowing the user to disable worktree spawning so all SLP agents work directly on baseBranch. */}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: spawnWorktrees }}
        accessibilityLabel="Spawn worktree for tasks"
        onPress={handleToggleSpawnWorktrees}
        style={[styles.row, { alignItems: "center", gap: 8, paddingVertical: 4 }]}
      >
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            borderWidth: 1.5,
            borderColor: spawnWorktrees ? theme.colors.accent : theme.colors.border,
            backgroundColor: spawnWorktrees ? theme.colors.accent : theme.colors.surface1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {spawnWorktrees ? (
            <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "800" }}>
              ✓
            </Text>
          ) : null}
        </View>
        <Text style={styles.bodyText}>Spawn worktree</Text>
      </Pressable>
      <ActionButton
        styles={styles}
        tone="primary"
        label={startRun.isPending ? "Starting..." : "Start run"}
        accessibilityLabel="Start SLP run"
        disabled={isStartDisabled}
        onPress={submitRun}
      />
      {startErrorMessage ? <Text style={styles.dangerText}>{startErrorMessage}</Text> : null}
    </View>
  );
}
