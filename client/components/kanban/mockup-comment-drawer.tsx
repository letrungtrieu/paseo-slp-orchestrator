// Minimalist right-hand comment drawer for the Mockup Preview Studio.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRef } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { MockupElementCommentInput } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import {
  renderInlineImagePreview,
  type MockupInspectMode,
  type PickedMockupHtmlElement,
} from "../../web";
import { ActionButton } from "../action-button";

type CommentTargetFields = Pick<MockupElementCommentInput, "selector" | "tagName" | "targets">;

// Every selector a note points at: the group of a drag-select, or the single element of a plain click.
export function selectorsOfComment(commentItem: CommentTargetFields): string[] {
  return commentItem.targets && commentItem.targets.length > 0
    ? commentItem.targets.map((target) => target.selector)
    : [commentItem.selector];
}

// One-line label for a note or a fresh selection, collapsing a group into a count instead of a long selector.
export function describeCommentTarget(commentItem: CommentTargetFields): string {
  return commentItem.targets && commentItem.targets.length > 1
    ? `${commentItem.targets.length} elements: ${commentItem.targets.map((target) => target.tagName).join(", ")}`
    : `[${commentItem.tagName}] ${commentItem.selector}`;
}

export interface MockupCommentDrawerProps {
  styles: UiStyles;
  theme: PluginTheme;
  inspectMode: MockupInspectMode;
  pickedHtmlElements: readonly PickedMockupHtmlElement[];
  elementCommentDraft: string;
  onChangeElementCommentDraft: (nextText: string) => void;
  onAddElementComment: () => void;
  onCancelPickedElements: () => void;
  onOpenImageMarkupDialog: (
    targetImage: PickedMockupHtmlElement,
    existingCommentText?: string,
  ) => void;
  pendingElementComments: readonly MockupElementCommentInput[];
  onHighlightSelectors: (selectors: string[]) => void;
  onRemoveElementComment: (commentIndex: number) => void;
  overallFeedbackDraft: string;
  onChangeOverallFeedbackDraft: (nextText: string) => void;
  isSendPending: boolean;
  isApprovePending: boolean;
  isApproved: boolean;
  onSendNotesToAgent: () => void;
  onApproveMockup: () => void;
}

export function MockupCommentDrawer({
  styles,
  theme,
  pickedHtmlElements,
  elementCommentDraft,
  onChangeElementCommentDraft,
  onAddElementComment,
  onCancelPickedElements,
  onOpenImageMarkupDialog,
  pendingElementComments,
  onHighlightSelectors,
  onRemoveElementComment,
  overallFeedbackDraft,
  onChangeOverallFeedbackDraft,
  isSendPending,
  isApprovePending,
  isApproved,
  onSendNotesToAgent,
  onApproveMockup,
}: MockupCommentDrawerProps) {
  const primaryPicked = pickedHtmlElements[0];
  const lastImagePressRef = useRef<{ selector: string; timestampMs: number } | null>(null);

  // Why: require a double-click (two presses within 380ms) on an image preview before opening the Markup dialog.
  const handleImagePressForDoubleClick = (
    targetImage: PickedMockupHtmlElement,
    commentText?: string,
  ) => {
    const nowMs = Date.now();
    const prevPress = lastImagePressRef.current;
    if (
      prevPress &&
      prevPress.selector === targetImage.selector &&
      nowMs - prevPress.timestampMs <= 380
    ) {
      lastImagePressRef.current = null;
      onOpenImageMarkupDialog(targetImage, commentText);
      return;
    }
    lastImagePressRef.current = { selector: targetImage.selector, timestampMs: nowMs };
  };

  return (
    <View
      style={[
        styles.card,
        {
          width: 300,
          backgroundColor: theme.colors.surface1,
          padding: 8,
          gap: 8,
        },
      ]}
    >
      {/* Scrollable interactive list of Element & Design Image Comments */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6 }}>
        {pendingElementComments.map((commentItem, commentIndex) => {
          const isImageComment = Boolean(commentItem.assetPath || commentItem.imagePreviewUri);
          const shortTargetLabel = commentItem.assetPath
            ? (commentItem.assetPath.split("/").pop() ?? commentItem.assetPath)
            : describeCommentTarget(commentItem);

          return (
            <Pressable
              key={commentItem.id ?? `cmt-${commentIndex}`}
              onPress={() => {
                onHighlightSelectors(selectorsOfComment(commentItem));
                if (commentItem.imagePreviewUri) {
                  handleImagePressForDoubleClick(
                    {
                      selector: commentItem.selector,
                      tagName: commentItem.tagName ?? "img",
                      elementText: commentItem.elementText ?? "",
                      assetPath: commentItem.assetPath,
                      imagePreviewUri: commentItem.imagePreviewUri,
                      imageDimensions: commentItem.imageDimensions,
                    },
                    commentItem.comment,
                  );
                }
              }}
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.surface2,
                  borderColor: isImageComment ? "#ec4899" : theme.colors.border,
                  padding: 8,
                  gap: 5,
                },
              ]}
            >
              <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: "700",
                    color: isImageComment ? "#ec4899" : theme.colors.accent,
                    fontFamily: "monospace",
                    flex: 1,
                  }}
                  numberOfLines={1}
                >
                  {shortTargetLabel}
                </Text>
                <Pressable onPress={() => onRemoveElementComment(commentIndex)}>
                  <Text style={{ fontSize: 11, color: theme.colors.statusDanger }}>Xóa</Text>
                </Pressable>
              </View>
              {commentItem.imagePreviewUri
                ? renderInlineImagePreview({
                    imageUri: commentItem.imagePreviewUri,
                    altText: shortTargetLabel,
                    maxHeightPx: 60,
                    onDoubleClick: () =>
                      onOpenImageMarkupDialog(
                        {
                          selector: commentItem.selector,
                          tagName: commentItem.tagName ?? "img",
                          elementText: commentItem.elementText ?? "",
                          assetPath: commentItem.assetPath,
                          imagePreviewUri: commentItem.imagePreviewUri,
                          imageDimensions: commentItem.imageDimensions,
                        },
                        commentItem.comment,
                      ),
                  })
                : null}
              <Text style={styles.bodyText}>{commentItem.comment}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Bottom-pinned Comment Composer */}
      <View style={{ gap: 6 }}>
        {primaryPicked ? (
          <View
            style={[
              styles.card,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: primaryPicked.imagePreviewUri ? "#ec4899" : theme.colors.statusWarning,
                padding: 8,
                gap: 6,
              },
            ]}
          >
            {primaryPicked.imagePreviewUri ? (
              <Pressable
                onPress={() => handleImagePressForDoubleClick(primaryPicked, elementCommentDraft)}
              >
                {renderInlineImagePreview({
                  imageUri: primaryPicked.imagePreviewUri,
                  altText: primaryPicked.assetPath ?? primaryPicked.selector,
                  maxHeightPx: 84,
                  onDoubleClick: () => onOpenImageMarkupDialog(primaryPicked, elementCommentDraft),
                })}
              </Pressable>
            ) : null}
            <TextInput
              style={[styles.input, { minHeight: 48, textAlignVertical: "top" }]}
              multiline
              value={elementCommentDraft}
              onChangeText={onChangeElementCommentDraft}
              placeholder="Comment..."
              placeholderTextColor={theme.colors.foregroundMuted}
            />
            <View style={styles.row}>
              <ActionButton
                styles={styles}
                tone="primary"
                label="Thêm"
                accessibilityLabel="Thêm comment"
                disabled={!elementCommentDraft.trim()}
                onPress={onAddElementComment}
              />
              <ActionButton
                styles={styles}
                label="Hủy"
                accessibilityLabel="Hủy chọn"
                onPress={onCancelPickedElements}
              />
            </View>
          </View>
        ) : null}

        <TextInput
          style={[styles.input, { minHeight: 56, textAlignVertical: "top" }]}
          multiline
          value={overallFeedbackDraft}
          onChangeText={onChangeOverallFeedbackDraft}
          placeholder="Ghi chú chung..."
          placeholderTextColor={theme.colors.foregroundMuted}
        />

        <View style={styles.row}>
          <ActionButton
            styles={styles}
            label="Gửi Agent"
            accessibilityLabel="Send mockup comments to the Product Agent"
            disabled={
              isSendPending ||
              isApprovePending ||
              (!overallFeedbackDraft.trim() && pendingElementComments.length === 0)
            }
            onPress={onSendNotesToAgent}
          />
          <ActionButton
            styles={styles}
            tone="primary"
            label={isApproved ? "Đã duyệt" : "Duyệt"}
            accessibilityLabel="Approve this mockup"
            disabled={isSendPending || isApprovePending || isApproved}
            onPress={onApproveMockup}
          />
        </View>
      </View>
    </View>
  );
}
