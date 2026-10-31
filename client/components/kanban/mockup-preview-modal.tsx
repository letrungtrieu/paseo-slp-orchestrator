// Full-workspace interactive HTML/CSS/JS Mockup Preview & Element-Comment Studio with concise 1-3 word controls.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { BoardTicket, MockupElementCommentInput } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions } from "../../use-board";
import { describeRpcError } from "../../use-run";
import { renderMockupPreviewIframe, type PickedMockupHtmlElement } from "../../web";
import { ActionButton } from "../action-button";
import { resolveSpecColorIdentity } from "./kanban-palette";

const VIEWPORT_PRESETS: ReadonlyArray<{ label: string; widthPx: number | null }> = [
  { label: "Desktop", widthPx: null },
  { label: "Tablet", widthPx: 768 },
  { label: "Mobile", widthPx: 390 },
];

export interface MockupPreviewModalProps {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  onOpenAgent?: (agentId: string) => void;
  onClose: () => void;
}

// Renders the interactive HTML/CSS/JS mockup iframe on the left and the compact HTML Element Comment panel on the right.
export function MockupPreviewModal({
  styles,
  theme,
  ticket,
  onOpenAgent,
  onClose,
}: MockupPreviewModalProps) {
  const { approveMockup, readMockupPreview, sendMockupFeedback } = useBoardActions();
  const specColor = resolveSpecColorIdentity(ticket);
  const [bundledHtmlContent, setBundledHtmlContent] = useState<string>("");
  const [iframeReloadNonce, setIframeReloadNonce] = useState<number>(0);
  const [viewportWidthPx, setViewportWidthPx] = useState<number | null>(null);

  // When true, clicking inside the mockup iframe selects the clicked HTML element (`selector`, `tagName`, `elementText`) for commenting.
  const [inspectModeEnabled, setInspectModeEnabled] = useState<boolean>(false);
  const [pickedHtmlElement, setPickedHtmlElement] = useState<PickedMockupHtmlElement | null>(null);
  const [highlightedSelector, setHighlightedSelector] = useState<string | null>(null);
  const [elementCommentDraft, setElementCommentDraft] = useState<string>("");
  const [pendingElementComments, setPendingElementComments] = useState<MockupElementCommentInput[]>([]);
  const [overallFeedbackDraft, setOverallFeedbackDraft] = useState<string>("");

  const mockupState = ticket.mockup;
  const isApproved = mockupState?.status === "approved";

  // Seed the draft from the ticket's open notes once per card; agent saves must not wipe what the human is still typing.
  useEffect(() => {
    setPendingElementComments(mockupState?.elementComments ?? []);
    setOverallFeedbackDraft(mockupState?.feedback ?? "");
    setPickedHtmlElement(null);
    setHighlightedSelector(null);
  }, [ticket.id]);

  // The file has no versions to pick, so re-read it whenever the agent saves or the human presses Reload.
  useEffect(() => {
    readMockupPreview.mutate(
      {
        repoPath: ticket.repoPath,
        ticketId: ticket.ticketKey,
      },
      {
        onSuccess: (previewPayload) => {
          setBundledHtmlContent(previewPayload.bundledHtml);
        },
      },
    );
  }, [ticket.id, ticket.repoPath, ticket.ticketKey, mockupState?.updatedAt, iframeReloadNonce]);

  const handleAddElementComment = () => {
    if (!pickedHtmlElement || !elementCommentDraft.trim()) return;
    const newCommentEntry: MockupElementCommentInput = {
      id: `el-cmt-${Date.now()}`,
      selector: pickedHtmlElement.selector,
      tagName: pickedHtmlElement.tagName,
      elementText: pickedHtmlElement.elementText,
      comment: elementCommentDraft.trim(),
    };
    setPendingElementComments((previousComments) => [...previousComments, newCommentEntry]);
    setElementCommentDraft("");
    setPickedHtmlElement(null);
  };

  const handleRemoveElementComment = (targetIndex: number) => {
    setPendingElementComments((previousComments) =>
      previousComments.filter((_commentItem, commentIndex) => commentIndex !== targetIndex),
    );
  };

  const handleSendNotesToAgent = () => {
    sendMockupFeedback.mutate(
      {
        repoPath: ticket.repoPath,
        ticketId: ticket.ticketKey,
        feedback: overallFeedbackDraft.trim() || undefined,
        elementComments: pendingElementComments,
      },
      {
        onSuccess: (feedbackOutcome) => {
          onOpenAgent?.(feedbackOutcome.productAgentId);
          onClose();
        },
      },
    );
  };

  const errorMessage =
    describeRpcError(readMockupPreview.error) ??
    describeRpcError(sendMockupFeedback.error) ??
    describeRpcError(approveMockup.error);

  const iframeNode = bundledHtmlContent
    ? renderMockupPreviewIframe({
        bundledHtml: bundledHtmlContent,
        title: ticket.title,
        reloadNonce: iframeReloadNonce,
        maxWidthPx: viewportWidthPx,
        inspectModeEnabled,
        highlightedSelector,
        onElementPicked: (pickedElement) => {
          setPickedHtmlElement(pickedElement);
        },
      })
    : null;

  return (
    <View
      style={[
        styles.card,
        {
          flex: 1,
          minHeight: 640,
          borderWidth: 2,
          borderColor: specColor.borderColor,
          backgroundColor: theme.colors.surface0,
          gap: 10,
        },
      ]}
    >
      {/* Compact Toolbar: Title, Pick HTML Toggle, Viewport Pills, Reload, Close */}
      <View
        style={[
          styles.row,
          {
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Text style={[styles.sectionTitle, { color: specColor.badgeTextColor }]}>
          {ticket.ticketKey} · {ticket.title}
        </Text>

        <View style={[styles.row, { gap: 6 }]}>
          {/* Concise 2-word toggle between running UI/JS vs clicking HTML tags to comment */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle HTML element comment picker"
            onPress={() => setInspectModeEnabled((previousMode) => !previousMode)}
            style={[
              styles.chip,
              {
                borderWidth: 1.5,
                borderColor: inspectModeEnabled ? theme.colors.statusWarning : theme.colors.accent,
                backgroundColor: inspectModeEnabled
                  ? theme.colors.surface2
                  : theme.colors.surface1,
              },
            ]}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color: inspectModeEnabled ? theme.colors.statusWarning : theme.colors.accent,
              }}
            >
              {inspectModeEnabled ? "Pick HTML: ON" : "Pick HTML"}
            </Text>
          </Pressable>

          {VIEWPORT_PRESETS.map((preset) => {
            const isSelectedViewport = viewportWidthPx === preset.widthPx;
            return (
              <Pressable
                key={preset.label}
                accessibilityRole="button"
                accessibilityLabel={preset.label}
                onPress={() => setViewportWidthPx(preset.widthPx)}
                style={[
                  styles.chip,
                  {
                    borderColor: isSelectedViewport ? theme.colors.accent : theme.colors.border,
                  },
                ]}
              >
                <Text style={styles.chipText}>{preset.label}</Text>
              </Pressable>
            );
          })}

          <ActionButton
            styles={styles}
            label="Reload"
            accessibilityLabel="Reload HTML and JavaScript inside mockup preview"
            onPress={() => setIframeReloadNonce((previousNonce) => previousNonce + 1)}
          />
          <ActionButton
            styles={styles}
            label="Close"
            accessibilityLabel="Close Mockup Preview Studio"
            onPress={onClose}
          />
        </View>
      </View>

      {errorMessage ? <Text style={styles.dangerText}>{errorMessage}</Text> : null}

      {/* Main Split View: Left = Live HTML/CSS/JS Iframe, Right = Compact Element Comment Drawer */}
      <View style={{ flex: 1, flexDirection: "row", gap: 12, minHeight: 540 }}>
        <View
          style={{
            flex: 1,
            backgroundColor: "#0f172a",
            borderRadius: 8,
            padding: 8,
            borderWidth: 1,
            borderColor: inspectModeEnabled ? theme.colors.statusWarning : theme.colors.border,
          }}
        >
          {readMockupPreview.isPending ? (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Text style={styles.mutedText}>Loading...</Text>
            </View>
          ) : (
            iframeNode ?? (
              <ScrollView style={{ flex: 1, padding: 12 }}>
                <Text selectable style={{ color: "#e2e8f0", fontFamily: "monospace", fontSize: 12 }}>
                  {bundledHtmlContent}
                </Text>
              </ScrollView>
            )
          )}
        </View>

        {/* Compact Right Review & HTML Element Comment Drawer */}
        <View
          style={[
            styles.card,
            {
              width: 320,
              backgroundColor: theme.colors.surface1,
              gap: 8,
            },
          ]}
        >
          <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
            <Text style={styles.sectionTitle}>
              Comments ({pendingElementComments.length})
            </Text>
            <Text
              style={{
                fontSize: 11,
                fontWeight: "600",
                color: inspectModeEnabled ? theme.colors.statusWarning : theme.colors.foregroundMuted,
              }}
            >
              {inspectModeEnabled ? "Pick HTML" : "Run UI"}
            </Text>
          </View>

          {/* Scrollable list of Element Comments attached to specific HTML tags */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6 }}>
            {pendingElementComments.map((commentItem, commentIndex) => (
              <Pressable
                key={commentItem.id ?? `cmt-${commentIndex}`}
                onPress={() => setHighlightedSelector(commentItem.selector)}
                style={[
                  styles.card,
                  {
                    backgroundColor: theme.colors.surface2,
                    padding: 8,
                    gap: 4,
                  },
                ]}
              >
                <View style={[styles.row, { justifyContent: "space-between" }]}>
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "700",
                      color: theme.colors.accent,
                      fontFamily: "monospace",
                      flex: 1,
                    }}
                    numberOfLines={1}
                  >
                    [{commentItem.tagName}] {commentItem.selector}
                  </Text>
                  <Pressable onPress={() => handleRemoveElementComment(commentIndex)}>
                    <Text style={{ fontSize: 11, color: theme.colors.statusDanger }}>Delete</Text>
                  </Pressable>
                </View>
                <Text style={styles.bodyText}>{commentItem.comment}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Bottom-pinned Comment Composer (Element Note when an HTML tag is picked, plus General Note) */}
          <View style={{ gap: 6 }}>
            {pickedHtmlElement ? (
              <View
                style={[
                  styles.card,
                  {
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.statusWarning,
                    gap: 6,
                  },
                ]}
              >
                <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.statusWarning }}>
                  [{pickedHtmlElement.tagName}] {pickedHtmlElement.selector}
                </Text>
                <TextInput
                  style={[styles.input, { minHeight: 54, textAlignVertical: "top" }]}
                  multiline
                  value={elementCommentDraft}
                  onChangeText={setElementCommentDraft}
                  placeholder="Element note..."
                  placeholderTextColor={theme.colors.foregroundMuted}
                />
                <View style={styles.row}>
                  <ActionButton
                    styles={styles}
                    tone="primary"
                    label="Add"
                    accessibilityLabel="Add comment for selected HTML element"
                    disabled={!elementCommentDraft.trim()}
                    onPress={handleAddElementComment}
                  />
                  <ActionButton
                    styles={styles}
                    label="Cancel"
                    accessibilityLabel="Cancel selected HTML element"
                    onPress={() => setPickedHtmlElement(null)}
                  />
                </View>
              </View>
            ) : null}

            <TextInput
              style={[styles.input, { minHeight: 68, textAlignVertical: "top" }]}
              multiline
              value={overallFeedbackDraft}
              onChangeText={setOverallFeedbackDraft}
              placeholder="General note..."
              placeholderTextColor={theme.colors.foregroundMuted}
            />
          </View>

          {/* Send the notes to the Product Agent, or approve the mockup at the current commit. */}
          <View style={[styles.row, { justifyContent: "flex-end", paddingTop: 6, borderTopWidth: 1, borderColor: theme.colors.border }]}>
            <ActionButton
              styles={styles}
              label={isApproved ? "Approved" : "Approve"}
              accessibilityLabel={`Approve mockup of ${ticket.ticketKey} at the current commit`}
              disabled={approveMockup.isPending || isApproved}
              onPress={() => approveMockup.mutate({ repoPath: ticket.repoPath, ticketId: ticket.ticketKey })}
            />
            <ActionButton
              styles={styles}
              tone="primary"
              label="Send to Agent"
              accessibilityLabel="Send HTML element comments and notes to the Product Agent"
              disabled={
                sendMockupFeedback.isPending ||
                (pendingElementComments.length === 0 && !overallFeedbackDraft.trim())
              }
              onPress={handleSendNotesToAgent}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
