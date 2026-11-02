// Minimalist modal dialog for Point Comment (%x, %y) and Rectangle Selection Markup (%x, %y, %w, %h) on a mockup image.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PickedMockupHtmlElement } from "../../web";
import {
  formatAnnotationCoordinateHeader,
  formatImageAnnotationsToCommentText,
  MARKUP_INK_PALETTE,
  parseCommentTextToImageAnnotations,
  renderInteractiveImageMarkupStage,
  type DesignImageAnnotationItem,
  type ImageMarkupToolMode,
} from "./mockup-image-markup-stage";

export interface MockupImageMarkupDialogProps {
  theme: PluginTheme;
  targetImage: PickedMockupHtmlElement | null;
  initialCommentText?: string;
  onCloseDialog: () => void;
  onSaveAnnotatedComment: (targetImage: PickedMockupHtmlElement, compiledCommentText: string) => void;
}

export function MockupImageMarkupDialog({
  theme,
  targetImage,
  initialCommentText,
  onCloseDialog,
  onSaveAnnotatedComment,
}: MockupImageMarkupDialogProps) {
  const [toolMode, setToolMode] = useState<ImageMarkupToolMode>("point");
  const [activeInkColor, setActiveInkColor] = useState<string>(MARKUP_INK_PALETTE[0].color);
  const [annotations, setAnnotations] = useState<DesignImageAnnotationItem[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [generalImageNote, setGeneralImageNote] = useState<string>("");

  // Why: re-hydrate saved '#1 (x:... y:...)' markers whenever the user opens or switches the target image.
  useEffect(() => {
    if (!targetImage) return;
    const parsedState = parseCommentTextToImageAnnotations(
      initialCommentText ?? "",
      MARKUP_INK_PALETTE[0].color,
    );
    setAnnotations(parsedState.annotations);
    setSelectedAnnotationId(parsedState.annotations[0]?.id ?? null);
    setGeneralImageNote(parsedState.generalNote);
  }, [targetImage?.selector, targetImage?.assetPath, initialCommentText]);

  if (!targetImage || !targetImage.imagePreviewUri) {
    return null;
  }

  const shortImageFilename =
    (targetImage.assetPath || targetImage.elementText || targetImage.tagName).split("/").pop() ??
    "image";

  // Why: newly placed points or drawn rectangles immediately become the active selection for typing a comment.
  const handleCreateAnnotation = (createdAnnotation: DesignImageAnnotationItem) => {
    setAnnotations((prev) => [...prev, createdAnnotation]);
    setSelectedAnnotationId(createdAnnotation.id);
  };

  const handleUpdateAnnotationComment = (annotationId: string, updatedCommentText: string) => {
    setAnnotations((prev) =>
      prev.map((item) =>
        item.id === annotationId ? { ...item, comment: updatedCommentText } : item,
      ),
    );
  };

  // Why: deleting the active marker shifts focus to the last remaining marker so keyboard editing stays fluid.
  const handleDeleteAnnotation = (annotationId: string) => {
    setAnnotations((prev) => {
      const remainingAnnotations = prev.filter((item) => item.id !== annotationId);
      if (selectedAnnotationId === annotationId) {
        setSelectedAnnotationId(remainingAnnotations[remainingAnnotations.length - 1]?.id ?? null);
      }
      return remainingAnnotations;
    });
  };

  // Why: clicking an ink swatch updates both future strokes and the currently focused marker's color.
  const handleSelectInkColor = (nextInkColor: string) => {
    setActiveInkColor(nextInkColor);
    if (selectedAnnotationId) {
      setAnnotations((prev) =>
        prev.map((item) =>
          item.id === selectedAnnotationId ? { ...item, inkColor: nextInkColor } : item,
        ),
      );
    }
  };

  const compiledCommentOutput = formatImageAnnotationsToCommentText(annotations, generalImageNote);
  const canSaveComment = annotations.length > 0 || Boolean(generalImageNote.trim());

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        backgroundColor: "rgba(2, 6, 23, 0.82)",
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
      }}
    >
      <View
        style={{
          width: "96%",
          maxWidth: 1120,
          maxHeight: "94%",
          minHeight: 520,
          backgroundColor: theme.colors.surface1,
          borderRadius: 12,
          borderWidth: 1.5,
          borderColor: "#ec4899",
          padding: 12,
          gap: 10,
        }}
      >
        {/* Minimalist Top Bar: Mode buttons (2 words), Ink Swatches, Clear, Close */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Pressable
              onPress={() => setToolMode("point")}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                borderWidth: 1.5,
                borderColor: toolMode === "point" ? "#ec4899" : theme.colors.border,
                backgroundColor: toolMode === "point" ? theme.colors.surface2 : theme.colors.surface0,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  color: toolMode === "point" ? "#ec4899" : theme.colors.foreground,
                }}
              >
                Chấm điểm
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setToolMode("rect")}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                borderWidth: 1.5,
                borderColor: toolMode === "rect" ? "#ec4899" : theme.colors.border,
                backgroundColor: toolMode === "rect" ? theme.colors.surface2 : theme.colors.surface0,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  color: toolMode === "rect" ? "#ec4899" : theme.colors.foreground,
                }}
              >
                Khoanh vùng
              </Text>
            </Pressable>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 4 }}>
              {MARKUP_INK_PALETTE.map((swatch) => {
                const isSelectedColor = activeInkColor === swatch.color;
                return (
                  <Pressable
                    key={swatch.color}
                    onPress={() => handleSelectInkColor(swatch.color)}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 999,
                      backgroundColor: swatch.color,
                      borderWidth: isSelectedColor ? 2.5 : 1,
                      borderColor: isSelectedColor ? "#ffffff" : "rgba(0,0,0,0.4)",
                    }}
                  />
                );
              })}
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {annotations.length > 0 ? (
              <Pressable
                onPress={() => {
                  setAnnotations([]);
                  setSelectedAnnotationId(null);
                }}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text style={{ fontSize: 11, color: theme.colors.statusDanger }}>Xóa hết</Text>
              </Pressable>
            ) : null}

            <Pressable
              onPress={onCloseDialog}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.foreground }}>
                Đóng
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Main Split View: Interactive Canvas Stage on Left + Editable Inputs on Right */}
        <View style={{ flex: 1, flexDirection: "row", gap: 10, minHeight: 420 }}>
          <View style={{ flex: 1.4 }}>
            {renderInteractiveImageMarkupStage({
              imageUri: targetImage.imagePreviewUri,
              altText: shortImageFilename,
              toolMode,
              activeInkColor,
              annotations,
              selectedAnnotationId,
              onSelectAnnotation: setSelectedAnnotationId,
              onCreateAnnotation: handleCreateAnnotation,
            })}
          </View>

          <View
            style={{
              width: 360,
              backgroundColor: theme.colors.surface0,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: 10,
              gap: 8,
            }}
          >
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6 }}>
              {annotations.map((annotationItem, index) => {
                const badgeNumber = index + 1;
                const isFocused = annotationItem.id === selectedAnnotationId;
                return (
                  <Pressable
                    key={annotationItem.id}
                    onPress={() => setSelectedAnnotationId(annotationItem.id)}
                    style={{
                      backgroundColor: theme.colors.surface1,
                      borderRadius: 8,
                      borderWidth: isFocused ? 1.5 : 1,
                      borderColor: isFocused ? annotationItem.inkColor : theme.colors.border,
                      padding: 8,
                      gap: 6,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                        <View
                          style={{
                            backgroundColor: annotationItem.inkColor,
                            paddingHorizontal: 6,
                            paddingVertical: 2,
                            borderRadius: 4,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 10,
                              fontWeight: "800",
                              color: "#ffffff",
                              fontFamily: "monospace",
                            }}
                          >
                            #{badgeNumber}
                          </Text>
                        </View>
                        <Text
                          style={{
                            fontSize: 10,
                            fontWeight: "600",
                            color: theme.colors.foregroundMuted,
                            fontFamily: "monospace",
                            flex: 1,
                          }}
                          numberOfLines={1}
                        >
                          {formatAnnotationCoordinateHeader(annotationItem)}
                        </Text>
                      </View>
                      <Pressable onPress={() => handleDeleteAnnotation(annotationItem.id)}>
                        <Text style={{ fontSize: 11, color: theme.colors.statusDanger }}>Xóa</Text>
                      </Pressable>
                    </View>

                    <TextInput
                      value={annotationItem.comment}
                      onChangeText={(nextText) =>
                        handleUpdateAnnotationComment(annotationItem.id, nextText)
                      }
                      onFocus={() => setSelectedAnnotationId(annotationItem.id)}
                      placeholder={`Comment #${badgeNumber}...`}
                      placeholderTextColor={theme.colors.foregroundMuted}
                      style={{
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: 6,
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        fontSize: 12,
                        color: theme.colors.foreground,
                        backgroundColor: theme.colors.surface0,
                      }}
                    />
                  </Pressable>
                );
              })}
            </ScrollView>

            <TextInput
              value={generalImageNote}
              onChangeText={setGeneralImageNote}
              placeholder="Ghi chú thêm..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 6,
                paddingHorizontal: 8,
                paddingVertical: 6,
                fontSize: 11,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface1,
              }}
            />

            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
              <Pressable
                onPress={onCloseDialog}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text style={{ fontSize: 11, color: theme.colors.foreground }}>Hủy</Text>
              </Pressable>
              <Pressable
                disabled={!canSaveComment}
                onPress={() => onSaveAnnotatedComment(targetImage, compiledCommentOutput)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 6,
                  backgroundColor: "#ec4899",
                  opacity: canSaveComment ? 1 : 0.45,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#ffffff" }}>
                  Lưu ({annotations.length})
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
