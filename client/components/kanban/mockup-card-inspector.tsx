// Sidebar inspector for a selected Mockup card in Column 1 (MOCKUP), with concise 1-2 word review controls.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { BoardTicket } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions } from "../../use-board";
import { describeRpcError } from "../../use-run";
import { ActionButton } from "../action-button";
import { resolveSpecColorIdentity } from "./kanban-palette";
import { InspectorTagBadge } from "./option-card-inspector";

export interface MockupCardInspectorProps {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  onOpenPreview: (ticket: BoardTicket) => void;
  onOpenAgent?: (agentId: string) => void;
  onClose: () => void;
}

// Shows the ticket's mockup file, its open notes, and the Preview, Approve and feedback actions.
export function MockupCardInspector({
  styles,
  theme,
  ticket,
  onOpenPreview,
  onOpenAgent,
  onClose,
}: MockupCardInspectorProps) {
  const { approveMockup, sendMockupFeedback } = useBoardActions();
  const specColor = resolveSpecColorIdentity(ticket);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const mockupState = ticket.mockup;
  // Approval failures carry git guidance, such as which files still need committing, so they must stay visible.
  const reviewErrorMessage =
    describeRpcError(approveMockup.error) ?? describeRpcError(sendMockupFeedback.error);
  if (!mockupState) return null;
  const isApproved = mockupState.status === "approved";

  const handleSendFeedback = () => {
    sendMockupFeedback.mutate(
      {
        repoPath: ticket.repoPath,
        ticketId: ticket.ticketKey,
        feedback: feedbackDraft.trim(),
        // The server replaces the open notes, so quick feedback must resend the element comments still awaiting work.
        elementComments: mockupState.elementComments,
      },
      {
        onSuccess: (feedbackOutcome) => {
          setFeedbackDraft("");
          onOpenAgent?.(feedbackOutcome.productAgentId);
        },
      },
    );
  };

  return (
    <View
      style={[
        styles.card,
        {
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          borderWidth: 2,
          borderLeftWidth: 6,
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          gap: 10,
        },
      ]}
    >
      <View style={[styles.row, { justifyContent: "space-between", alignItems: "center", flexShrink: 0 }]}>
        <InspectorTagBadge
          label={`MOCKUP · ${ticket.ticketKey}`}
          borderColor={specColor.borderColor}
          backgroundColor={specColor.badgeBackground}
          textColor={specColor.badgeTextColor}
        />
        <ActionButton
          styles={styles}
          label="Close"
          accessibilityLabel={`Close Mockup inspector for ${ticket.ticketKey}`}
          onPress={onClose}
        />
      </View>

      {/* Scrollable details in the middle so the header and bottom actions stay fixed */}
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 6 }}>
        <Text style={[styles.bodyText, { fontWeight: "700" }]}>{ticket.title}</Text>
        <Text style={[styles.mutedText, { fontFamily: "monospace" }]}>{mockupState.file}</Text>
        <Text
          style={{
            fontSize: 11,
            fontWeight: "700",
            color: isApproved ? theme.colors.statusSuccess : theme.colors.statusWarning,
          }}
        >
          {isApproved
            ? `Approved${mockupState.approvedCommit ? ` at ${mockupState.approvedCommit.slice(0, 8)}` : ""}`
            : "Draft"}
        </Text>
        {mockupState.summary ? <Text style={styles.bodyText}>{mockupState.summary}</Text> : null}
        {mockupState.feedback ? <Text style={styles.bodyText}>{mockupState.feedback}</Text> : null}
        {mockupState.elementComments.map((elementComment) => (
          <Text key={elementComment.id} style={styles.mutedText} numberOfLines={1}>
            [{elementComment.tagName}] {elementComment.comment}
          </Text>
        ))}
      </ScrollView>

      <View style={[styles.row, { gap: 6, flexShrink: 0 }]}>
        <ActionButton
          styles={styles}
          label="Preview"
          accessibilityLabel={`Open preview for ${ticket.title}`}
          onPress={() => onOpenPreview(ticket)}
        />
        <ActionButton
          styles={styles}
          tone="primary"
          label={isApproved ? "Approved" : "Approve"}
          accessibilityLabel={`Approve mockup of ${ticket.ticketKey} at the current commit`}
          disabled={approveMockup.isPending || isApproved}
          onPress={() => approveMockup.mutate({ repoPath: ticket.repoPath, ticketId: ticket.ticketKey })}
        />
      </View>

      <View style={[styles.row, { alignItems: "center", gap: 6, flexShrink: 0 }]}>
        <TextInput
          style={[styles.input, { flex: 1, minHeight: 36 }]}
          value={feedbackDraft}
          onChangeText={setFeedbackDraft}
          placeholder="Feedback..."
          placeholderTextColor={theme.colors.foregroundMuted}
        />
        <ActionButton
          styles={styles}
          label="Send"
          accessibilityLabel="Send feedback to the Product Agent"
          disabled={sendMockupFeedback.isPending || !feedbackDraft.trim()}
          onPress={handleSendFeedback}
        />
      </View>

      {reviewErrorMessage ? <Text style={styles.dangerText}>{reviewErrorMessage}</Text> : null}
    </View>
  );
}
