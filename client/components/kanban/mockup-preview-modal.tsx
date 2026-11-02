// Minimalist full-workspace interactive HTML/CSS/JS Mockup Preview & Design-Image Comment/Markup Studio.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { BoardTicket, MockupElementCommentInput } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions } from "../../use-board";
import { describeRpcError } from "../../use-run";
import {
  renderMockupPreviewIframe,
  type MockupInspectMode,
  type PickedMockupHtmlElement,
  type VisibleMockupScreenImage,
} from "../../web";
import { ActionButton } from "../action-button";
import { resolveSpecColorIdentity } from "./kanban-palette";
import { MockupCommentDrawer } from "./mockup-comment-drawer";
import { MockupImageExplorerPanel } from "./mockup-image-explorer-panel";
import { MockupImageMarkupDialog } from "./mockup-image-markup-dialog";

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

// Renders the interactive HTML/CSS/JS mockup iframe, Image Explorer sidepanel, and Comment Drawer.
export function MockupPreviewModal({
  styles,
  theme,
  ticket,
  onOpenAgent,
  onClose,
}: MockupPreviewModalProps) {
  const { approveMockup, readMockupPreview, sendMockupFeedback } = useBoardActions();
  const specColor = resolveSpecColorIdentity(ticket);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [bundledHtmlContent, setBundledHtmlContent] = useState<string>("");
  const [useInlinedFallback, setUseInlinedFallback] = useState<boolean>(false);
  const [iframeReloadNonce, setIframeReloadNonce] = useState<number>(0);
  const [scanImagesNonce, setScanImagesNonce] = useState<number>(0);
  const [viewportWidthPx, setViewportWidthPx] = useState<number | null>(null);

  const [inspectMode, setInspectMode] = useState<MockupInspectMode>("run");
  const [pickedHtmlElements, setPickedHtmlElements] = useState<PickedMockupHtmlElement[]>([]);
  const [visibleScreenImages, setVisibleScreenImages] = useState<VisibleMockupScreenImage[]>([]);
  const [highlightedSelectors, setHighlightedSelectors] = useState<string[] | null>(null);
  const [elementCommentDraft, setElementCommentDraft] = useState<string>("");
  const [pendingElementComments, setPendingElementComments] = useState<MockupElementCommentInput[]>([]);
  const [overallFeedbackDraft, setOverallFeedbackDraft] = useState<string>("");
  const [activeMarkupModalState, setActiveMarkupModalState] = useState<{
    targetImage: PickedMockupHtmlElement;
    initialCommentText?: string;
  } | null>(null);
  const lastCanvasPickRef = useRef<{ selector: string; timestampMs: number } | null>(null);

  const mockupState = ticket.mockup;
  const isApproved = mockupState?.status === "approved";

  // Seed the draft from the ticket's open notes once per card; agent saves must not wipe what the human is still typing.
  useEffect(() => {
    setPendingElementComments(mockupState?.elementComments ?? []);
    setOverallFeedbackDraft(mockupState?.feedback ?? "");
    setPickedHtmlElements([]);
    setHighlightedSelectors(null);
    setActiveMarkupModalState(null);
  }, [ticket.id]);

  // Re-read the preview whenever the agent saves or the human presses Reload.
  useEffect(() => {
    readMockupPreview.mutate(
      {
        repoPath: ticket.repoPath,
        ticketId: ticket.ticketKey,
        inline: useInlinedFallback,
      },
      {
        onSuccess: (previewPayload) => {
          setPreviewUrl(previewPayload.previewUrl);
          setBundledHtmlContent(previewPayload.bundledHtml ?? "");
        },
      },
    );
  }, [ticket.id, ticket.repoPath, ticket.ticketKey, mockupState?.updatedAt, iframeReloadNonce, useInlinedFallback]);

  const handleAddElementComment = () => {
    const [primaryPickedElement] = pickedHtmlElements;
    if (!primaryPickedElement || !elementCommentDraft.trim()) return;
    const newCommentEntry: MockupElementCommentInput = {
      id: `el-cmt-${Date.now()}`,
      selector: primaryPickedElement.selector,
      tagName: primaryPickedElement.tagName,
      elementText: primaryPickedElement.elementText,
      assetPath: primaryPickedElement.assetPath,
      imagePreviewUri: primaryPickedElement.imagePreviewUri,
      imageDimensions: primaryPickedElement.imageDimensions,
      ...(pickedHtmlElements.length > 1 ? { targets: pickedHtmlElements } : {}),
      comment: elementCommentDraft.trim(),
    };
    setPendingElementComments((previousComments) => [...previousComments, newCommentEntry]);
    setElementCommentDraft("");
    setPickedHtmlElements([]);
  };

  // Why: opening the image markup modal restores any existing saved comment for that selector/asset so point/rectangle markers remain editable.
  const openImageMarkupDialog = (
    targetImage: PickedMockupHtmlElement,
    explicitCommentText?: string,
  ) => {
    const existingSavedComment = pendingElementComments.find(
      (item) =>
        item.selector === targetImage.selector ||
        (Boolean(targetImage.assetPath) && item.assetPath === targetImage.assetPath),
    );
    setActiveMarkupModalState({
      targetImage,
      initialCommentText:
        explicitCommentText ?? existingSavedComment?.comment ?? elementCommentDraft,
    });
  };

  // Why: saving from the markup dialog updates an existing comment for the same image or appends a new structured comment entry.
  const handleSaveImageMarkupComment = (
    targetImage: PickedMockupHtmlElement,
    compiledCommentText: string,
  ) => {
    setPendingElementComments((prev) => {
      const existingIndex = prev.findIndex(
        (item) =>
          item.selector === targetImage.selector ||
          (Boolean(targetImage.assetPath) && item.assetPath === targetImage.assetPath),
      );
      const updatedEntry: MockupElementCommentInput = {
        id: existingIndex >= 0 ? prev[existingIndex].id : `el-cmt-${Date.now()}`,
        selector: targetImage.selector,
        tagName: targetImage.tagName,
        elementText: targetImage.elementText,
        assetPath: targetImage.assetPath,
        imagePreviewUri: targetImage.imagePreviewUri,
        imageDimensions: targetImage.imageDimensions,
        comment: compiledCommentText.trim(),
      };
      if (existingIndex >= 0) {
        return prev.map((item, idx) => (idx === existingIndex ? updatedEntry : item));
      }
      return [...prev, updatedEntry];
    });
    if (pickedHtmlElements[0]?.selector === targetImage.selector) {
      setElementCommentDraft("");
    }
    setActiveMarkupModalState(null);
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

  const handleApproveMockup = () => {
    approveMockup.mutate(
      { repoPath: ticket.repoPath, ticketId: ticket.ticketKey },
      { onSuccess: onClose },
    );
  };

  const errorMessage =
    describeRpcError(readMockupPreview.error) ??
    describeRpcError(sendMockupFeedback.error) ??
    describeRpcError(approveMockup.error);

  // Why: when `useInlinedFallback` is active, omit `previewUrl` so the iframe renders `srcDoc` with its `<base>` tag.
  const cacheBustedPreviewUrl =
    !useInlinedFallback && previewUrl
      ? `${previewUrl}?v=${encodeURIComponent(`${mockupState?.updatedAt ?? ""}-${iframeReloadNonce}`)}`
      : null;

  const iframeNode =
    cacheBustedPreviewUrl || bundledHtmlContent
      ? renderMockupPreviewIframe({
          previewUrl: cacheBustedPreviewUrl,
          bundledHtml: bundledHtmlContent || null,
          title: ticket.title,
          reloadNonce: iframeReloadNonce,
          scanImagesNonce,
          maxWidthPx: viewportWidthPx,
          inspectMode,
          highlightedSelectors,
          onElementsPicked: (nextPickedElements) => {
            setPickedHtmlElements(nextPickedElements);
            // Why: require a double-click (two picks of the same image within 380ms) on the canvas to open the Markup dialog.
            if (
              inspectMode === "design" &&
              nextPickedElements.length === 1 &&
              nextPickedElements[0].imagePreviewUri
            ) {
              const pickedImage = nextPickedElements[0];
              const nowMs = Date.now();
              const prevPick = lastCanvasPickRef.current;
              if (
                prevPick &&
                prevPick.selector === pickedImage.selector &&
                nowMs - prevPick.timestampMs <= 380
              ) {
                lastCanvasPickRef.current = null;
                openImageMarkupDialog(pickedImage);
                return;
              }
              lastCanvasPickRef.current = { selector: pickedImage.selector, timestampMs: nowMs };
            }
          },
          onScreenImagesUpdated: setVisibleScreenImages,
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
          gap: 8,
        },
      ]}
    >
      {/* Minimalist Interactive Toolbar: Pick HTML, Design, Viewports, URL/Inline, Tải lại, Đóng */}
      <View
        style={[
          styles.row,
          {
            justifyContent: "flex-end",
            alignItems: "center",
            paddingBottom: 6,
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
            gap: 6,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pick HTML"
          onPress={() => setInspectMode((prev) => (prev === "html" ? "run" : "html"))}
          style={[
            styles.chip,
            {
              borderWidth: 1.5,
              borderColor: inspectMode === "html" ? theme.colors.statusWarning : theme.colors.accent,
              backgroundColor: inspectMode === "html" ? theme.colors.surface2 : theme.colors.surface1,
            },
          ]}
        >
          <Text
            style={{
              fontSize: 11,
              fontWeight: "700",
              color: inspectMode === "html" ? theme.colors.statusWarning : theme.colors.accent,
            }}
          >
            Pick HTML
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Design"
          onPress={() => setInspectMode((prev) => (prev === "design" ? "run" : "design"))}
          style={[
            styles.chip,
            {
              borderWidth: 1.5,
              borderColor: inspectMode === "design" ? "#ec4899" : theme.colors.border,
              backgroundColor: inspectMode === "design" ? theme.colors.surface2 : theme.colors.surface1,
            },
          ]}
        >
          <Text
            style={{
              fontSize: 11,
              fontWeight: "700",
              color: inspectMode === "design" ? "#ec4899" : theme.colors.foreground,
            }}
          >
            Design
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
          label={useInlinedFallback ? "URL" : "Inline"}
          accessibilityLabel="Switch URL / Inline"
          onPress={() => setUseInlinedFallback((previousMode) => !previousMode)}
        />
        <ActionButton
          styles={styles}
          label="Tải lại"
          accessibilityLabel="Tải lại"
          onPress={() => setIframeReloadNonce((previousNonce) => previousNonce + 1)}
        />
        <ActionButton
          styles={styles}
          label="Đóng"
          accessibilityLabel="Đóng"
          onPress={onClose}
        />
      </View>

      {errorMessage ? <Text style={styles.dangerText}>{errorMessage}</Text> : null}

      {/* Main Split View: Live Iframe + Image Explorer Sidepanel + Comment Drawer */}
      <View style={{ flex: 1, flexDirection: "row", gap: 10, minHeight: 540 }}>
        <View
          style={{
            flex: 1,
            backgroundColor: "#0f172a",
            borderRadius: 8,
            padding: 8,
            borderWidth: 1,
            borderColor:
              inspectMode === "design"
                ? "#ec4899"
                : inspectMode === "html"
                  ? theme.colors.statusWarning
                  : theme.colors.border,
          }}
        >
          {readMockupPreview.isPending ? null : (
            iframeNode ?? (
              <ScrollView style={{ flex: 1, padding: 12 }}>
                <Text selectable style={{ color: "#e2e8f0", fontFamily: "monospace", fontSize: 12 }}>
                  {bundledHtmlContent}
                </Text>
              </ScrollView>
            )
          )}
        </View>

        <MockupImageExplorerPanel
          theme={theme}
          visibleScreenImages={visibleScreenImages}
          selectedImageSelector={pickedHtmlElements[0]?.selector ?? null}
          onSelectScreenImage={(screenImg) => {
            setPickedHtmlElements([screenImg]);
            setHighlightedSelectors([screenImg.selector]);
          }}
          onOpenImageMarkupDialog={(screenImg) => openImageMarkupDialog(screenImg)}
          onRescanScreenImages={() => setScanImagesNonce((prev) => prev + 1)}
        />

        <MockupCommentDrawer
          styles={styles}
          theme={theme}
          inspectMode={inspectMode}
          pickedHtmlElements={pickedHtmlElements}
          elementCommentDraft={elementCommentDraft}
          onChangeElementCommentDraft={setElementCommentDraft}
          onAddElementComment={handleAddElementComment}
          onCancelPickedElements={() => setPickedHtmlElements([])}
          onOpenImageMarkupDialog={openImageMarkupDialog}
          pendingElementComments={pendingElementComments}
          onHighlightSelectors={setHighlightedSelectors}
          onRemoveElementComment={handleRemoveElementComment}
          overallFeedbackDraft={overallFeedbackDraft}
          onChangeOverallFeedbackDraft={setOverallFeedbackDraft}
          isSendPending={sendMockupFeedback.isPending}
          isApprovePending={approveMockup.isPending}
          isApproved={isApproved}
          onSendNotesToAgent={handleSendNotesToAgent}
          onApproveMockup={handleApproveMockup}
        />
      </View>

      <MockupImageMarkupDialog
        theme={theme}
        targetImage={activeMarkupModalState?.targetImage ?? null}
        initialCommentText={activeMarkupModalState?.initialCommentText}
        onCloseDialog={() => setActiveMarkupModalState(null)}
        onSaveAnnotatedComment={handleSaveImageMarkupComment}
      />
    </View>
  );
}
