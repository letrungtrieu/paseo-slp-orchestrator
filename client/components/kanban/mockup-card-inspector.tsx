// Sidebar inspector for a selected Mockup card in Column 2 (MOCKUP), listing versions with concise 1-2 word controls.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { BoardTicket, MockupRevision } from "../../../shared/board";
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
  selectedRunId: string | null;
  onOpenPreviewVersion: (ticket: BoardTicket, versionNumber: number) => void;
  onClose: () => void;
}

// Resolve a short 1-word status label and semantic color for each mockup version row in the sidebar.
function resolveVersionStatusBadge(
  theme: PluginTheme,
  revision: MockupRevision,
): { label: string; color: string } {
  if (revision.status === "approved") {
    return { label: "Approved", color: theme.colors.statusSuccess };
  }
  if (revision.status === "rework_requested") {
    return { label: "Rework", color: theme.colors.statusDanger };
  }
  if (revision.status === "superseded") {
    return { label: "Old", color: theme.colors.foregroundMuted };
  }
  return { label: "Pending", color: theme.colors.statusWarning };
}

// Renders `title (vN) [ → ]` version rows and concise review actions inside the Kanban sidebar.
export function MockupCardInspector({
  styles,
  theme,
  ticket,
  selectedRunId,
  onOpenPreviewVersion,
  onClose,
}: MockupCardInspectorProps) {
  const { reviewBoardMockup } = useBoardActions();
  const specColor = resolveSpecColorIdentity(ticket);
  // Order versions from newest to oldest so the active version sits at the top of the sidebar.
  const orderedRevisions = [...ticket.mockupRevisions].sort(
    (firstRev, secondRev) => secondRev.version - firstRev.version,
  );
  const [reworkFeedbackDraft, setReworkFeedbackDraft] = useState("");
  const reviewErrorMessage = describeRpcError(reviewBoardMockup.error);

  const handleApproveVersion = (versionNumber: number) => {
    reviewBoardMockup.mutate({
      repoPath: ticket.repoPath,
      runId: selectedRunId ?? ticket.activeRunId ?? undefined,
      ticketId: ticket.ticketKey,
      decision: "approve",
      version: versionNumber,
      feedback: reworkFeedbackDraft.trim() || undefined,
    });
  };

  const handleRequestNewVersion = (baseVersionNumber?: number) => {
    if (!reworkFeedbackDraft.trim()) return;
    reviewBoardMockup.mutate(
      {
        repoPath: ticket.repoPath,
        runId: selectedRunId ?? ticket.activeRunId ?? undefined,
        ticketId: ticket.ticketKey,
        decision: "rework",
        version: baseVersionNumber ?? ticket.currentMockupRev,
        baseVersion: baseVersionNumber,
        feedback: reworkFeedbackDraft.trim(),
      },
      {
        onSuccess: () => {
          setReworkFeedbackDraft("");
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
      {/* Compact header with ticket badge, version badge, and Close button fixed at the top */}
      <View
        style={[
          styles.row,
          { justifyContent: "space-between", alignItems: "center", flexShrink: 0 },
        ]}
      >
        <View style={[styles.row, { gap: 6 }]}>
          <InspectorTagBadge
            label={`MOCKUP · ${ticket.ticketKey}`}
            borderColor={specColor.borderColor}
            backgroundColor={specColor.badgeBackground}
            textColor={specColor.badgeTextColor}
          />
          <InspectorTagBadge
            label={`v${ticket.currentMockupRev}`}
            borderColor={specColor.borderColor}
            backgroundColor={theme.colors.surface2}
            textColor={theme.colors.foreground}
          />
        </View>
        <ActionButton
          styles={styles}
          label="Close"
          accessibilityLabel={`Close Mockup inspector for ${ticket.ticketKey}`}
          onPress={onClose}
        />
      </View>

      {/* Scrollable version list in the middle so header and bottom rework input stay fixed */}
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: 6 }}
        showsVerticalScrollIndicator
      >
        {orderedRevisions.map((mockupRev) => {
          const statusBadge = resolveVersionStatusBadge(theme, mockupRev);
          const elementCommentCount = mockupRev.elementComments?.length ?? 0;

          return (
            <View
              key={`inspector-mockup-v${mockupRev.version}`}
              style={[
                styles.card,
                {
                  padding: 8,
                  backgroundColor: theme.colors.surface2,
                  borderColor:
                    mockupRev.status === "approved"
                      ? theme.colors.statusSuccess
                      : specColor.borderColor,
                  gap: 6,
                },
              ]}
            >
              <View style={[styles.row, { justifyContent: "space-between", alignItems: "center", gap: 6 }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open preview for ${mockupRev.title} (v${mockupRev.version})`}
                  onPress={() => onOpenPreviewVersion(ticket, mockupRev.version)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flex: 1,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: theme.colors.foreground,
                        fontWeight: "700",
                        fontSize: 12,
                      }}
                    >
                      {mockupRev.title} (v{mockupRev.version})
                    </Text>
                    <View style={[styles.row, { gap: 6 }]}>
                      <Text style={{ fontSize: 10, fontWeight: "700", color: statusBadge.color }}>
                        {statusBadge.label}
                      </Text>
                      {elementCommentCount > 0 ? (
                        <Text style={{ fontSize: 10, fontWeight: "600", color: theme.colors.accent }}>
                          {elementCommentCount} {elementCommentCount === 1 ? "note" : "notes"}
                        </Text>
                      ) : null}
                    </View>
                  </View>

                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 5,
                      backgroundColor: specColor.badgeBackground,
                      borderWidth: 1,
                      borderColor: specColor.borderColor,
                    }}
                  >
                    <Text style={{ color: specColor.badgeTextColor, fontWeight: "800", fontSize: 12 }}>
                      →
                    </Text>
                  </View>
                </Pressable>

                <ActionButton
                  styles={styles}
                  tone="primary"
                  label={mockupRev.status === "approved" ? "Approved" : "Approve"}
                  accessibilityLabel={`Approve mockup v${mockupRev.version}`}
                  disabled={reviewBoardMockup.isPending || mockupRev.status === "approved"}
                  onPress={() => handleApproveVersion(mockupRev.version)}
                />
              </View>

              {elementCommentCount > 0 ? (
                <View style={{ gap: 2 }}>
                  {mockupRev.elementComments.map((elementComment) => (
                    <Text key={elementComment.id} style={styles.mutedText} numberOfLines={1}>
                      [{elementComment.tagName}] {elementComment.comment}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      {/* Fixed bottom rework input with short 2-word submit button */}
      {orderedRevisions.length > 0 ? (
        <View style={[styles.row, { alignItems: "center", gap: 6, flexShrink: 0 }]}>
          <TextInput
            style={[styles.input, { flex: 1, minHeight: 36 }]}
            value={reworkFeedbackDraft}
            onChangeText={setReworkFeedbackDraft}
            placeholder="Feedback..."
            placeholderTextColor={theme.colors.foregroundMuted}
          />
          <ActionButton
            styles={styles}
            label={`Rework v${ticket.currentMockupRev + 1}`}
            accessibilityLabel="Request mockup rework to create next version"
            disabled={reviewBoardMockup.isPending || !reworkFeedbackDraft.trim()}
            onPress={() => handleRequestNewVersion(ticket.currentMockupRev)}
          />
        </View>
      ) : null}

      {reviewErrorMessage ? <Text style={styles.dangerText}>{reviewErrorMessage}</Text> : null}
    </View>
  );
}
