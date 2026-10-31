// "Start Run" action on a prepared ticket: the one place a feature crosses from product work into an SLP Run.
import { Text, View } from "react-native";
import { describeTicketRunBlocker, type BoardTicket } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { describeRpcError, useRunActions } from "../../use-run";
import { useRunStartOptions } from "../../use-run-start-options";
import { ActionButton } from "../action-button";

export function StartTicketRunButton({
  styles,
  ticket,
  onOpenSupervisor,
}: {
  styles: UiStyles;
  ticket: BoardTicket;
  onOpenSupervisor?: (supervisorAgentId: string) => void;
}) {
  const { startRun } = useRunActions();
  const { runInput, isReady, settings, promptsErrorMessage } = useRunStartOptions(ticket.repoPath);
  const startErrorMessage = describeRpcError(startRun.error) ?? promptsErrorMessage;
  // Tickets already in a Run show nothing: the Supervisor chat is the way back to that work.
  if (ticket.activeRunId) return null;
  const runBlocker = describeTicketRunBlocker(ticket);

  const handleStartRun = () => {
    startRun.mutate(
      {
        ...runInput,
        repoPath: ticket.repoPath,
        name: ticket.title,
        ticketId: ticket.ticketKey,
        spawnWorktrees: settings.configuration.orchestration.spawnWorktrees ?? true,
      },
      // The Supervisor is the human's control point once a Run begins, so its chat opens right away.
      { onSuccess: (startedRun) => onOpenSupervisor?.(startedRun.supervisorAgentId) },
    );
  };

  return (
    <View style={{ gap: 4, flexShrink: 0 }}>
      <ActionButton
        styles={styles}
        tone="primary"
        label={startRun.isPending ? "Starting..." : "Start Run"}
        accessibilityLabel={`Start an SLP Run for ${ticket.ticketKey}`}
        disabled={Boolean(runBlocker) || !isReady || startRun.isPending}
        onPress={handleStartRun}
      />
      {runBlocker ? <Text style={styles.mutedText}>{runBlocker}</Text> : null}
      {startErrorMessage ? <Text style={styles.dangerText}>{startErrorMessage}</Text> : null}
    </View>
  );
}
