// Focused "SLP" tab form for starting an SLP run from a ticket prepared on the project Kanban board.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { describeTicketRunBlocker, type BoardTicket } from "../../shared/board";
import type { UiStyles } from "../styles";
import { useBoardActions, useBoardTickets } from "../use-board";
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
  // Opens an agent's chat, used to land in the Product Agent after it is spawned from this form.
  onOpenAgent?: (agentId: string) => void;
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
  onOpenAgent,
}: StartRunFormProps) {
  const { startRun } = useRunActions();
  const { spawnProductAgent } = useBoardActions();
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
  // Tickets that cannot start yet are listed with the reason, so "no ready ticket" never leaves the human guessing.
  const blockedTickets = (boardQuery.data?.tickets ?? [])
    .map((ticket) => ({ ticket, blockerReason: describeTicketRunBlocker(ticket) }))
    .filter((blockedEntry): blockedEntry is { ticket: BoardTicket; blockerReason: string } => blockedEntry.blockerReason !== null);

  // Mockups are made only by the Product Agent, so every way of making or changing one starts by opening it.
  const openProductAgent = (targetTicketKey?: string) => {
    if (!effectiveRepoPath.trim()) return;
    spawnProductAgent.mutate(
      { repoPath: effectiveRepoPath.trim(), ticketId: targetTicketKey },
      { onSuccess: (spawnedResponse) => onOpenAgent?.(spawnedResponse.agentId) },
    );
  };

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
          No ready tickets. A ticket is ready when its mockup is approved and its Spec is written and reviewed. Create a new mockup with the Product Agent below, or approve one on the Kanban board.
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
      {blockedTickets.length > 0 ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Not ready yet</Text>
          {blockedTickets.map(({ ticket, blockerReason }) => (
            <View key={ticket.id} style={styles.stack}>
              <Text style={styles.bodyText}>{ticket.ticketKey} · {ticket.title}</Text>
              <Text style={styles.mutedText}>{blockerReason}</Text>
              {/* A ticket already inside a Run is fixed by ending that Run, not by the Product Agent. */}
              {!ticket.activeRunId ? (
                <ActionButton
                  styles={styles}
                  label="Continue with Product Agent"
                  accessibilityLabel={`Continue ${ticket.ticketKey} with the Product Agent`}
                  disabled={spawnProductAgent.isPending}
                  onPress={() => openProductAgent(ticket.ticketKey)}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <ActionButton
        styles={styles}
        label={spawnProductAgent.isPending ? "Opening Agent..." : "+ New mockup with Product Agent"}
        accessibilityLabel="Create a new mockup with the Product Agent"
        disabled={!effectiveRepoPath.trim() || spawnProductAgent.isPending}
        onPress={() => openProductAgent()}
      />
      {describeRpcError(spawnProductAgent.error) ? (
        <Text style={styles.dangerText}>{describeRpcError(spawnProductAgent.error)}</Text>
      ) : null}
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
