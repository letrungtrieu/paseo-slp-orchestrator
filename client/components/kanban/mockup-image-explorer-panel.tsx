// Minimalist vertical sidepanel (left of the Comments drawer) for exploring all images, CSS sprites, and Canvas sprites.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { renderInlineImagePreview, type VisibleMockupScreenImage } from "../../web";

type ImageAssetCategory = "all" | "sprite" | "canvas" | "img";

const CATEGORY_FILTER_OPTIONS: ReadonlyArray<{ id: ImageAssetCategory; label: string }> = [
  { id: "all", label: "Tất cả" },
  { id: "sprite", label: "Sprite" },
  { id: "canvas", label: "Canvas" },
  { id: "img", label: "IMG" },
];

// Why: classify each discovered screen image by how it is rendered in the DOM so designers can filter CSS sprites vs Canvas vs <img>.
function classifyScreenImageCategory(screenImage: VisibleMockupScreenImage): ImageAssetCategory {
  const normalizedTag = screenImage.tagName.toLowerCase();
  if (normalizedTag === "canvas" || normalizedTag === "canvas-img") {
    return "canvas";
  }
  if (normalizedTag === "img" || normalizedTag === "svg") {
    return "img";
  }
  return "sprite";
}

export interface MockupImageExplorerPanelProps {
  theme: PluginTheme;
  visibleScreenImages: readonly VisibleMockupScreenImage[];
  selectedImageSelector: string | null;
  onSelectScreenImage: (screenImage: VisibleMockupScreenImage) => void;
  onOpenImageMarkupDialog: (screenImage: VisibleMockupScreenImage) => void;
  onRescanScreenImages: () => void;
}

const DOUBLE_CLICK_WINDOW_MS = 380;

export function MockupImageExplorerPanel({
  theme,
  visibleScreenImages,
  selectedImageSelector,
  onSelectScreenImage,
  onOpenImageMarkupDialog,
  onRescanScreenImages,
}: MockupImageExplorerPanelProps) {
  const [isPanelCollapsed, setIsPanelCollapsed] = useState<boolean>(false);
  const [searchFilterQuery, setSearchFilterQuery] = useState<string>("");
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<ImageAssetCategory>("all");
  const lastCardPressRef = useRef<{ selector: string; timestampMs: number } | null>(null);

  // Why: single click selects and highlights the image on screen; double click within 380ms opens the Markup dialog.
  const handlePressImageCard = (screenImage: VisibleMockupScreenImage) => {
    onSelectScreenImage(screenImage);
    const nowMs = Date.now();
    const previousPress = lastCardPressRef.current;
    if (
      previousPress &&
      previousPress.selector === screenImage.selector &&
      nowMs - previousPress.timestampMs <= DOUBLE_CLICK_WINDOW_MS
    ) {
      lastCardPressRef.current = null;
      onOpenImageMarkupDialog(screenImage);
      return;
    }
    lastCardPressRef.current = { selector: screenImage.selector, timestampMs: nowMs };
  };

  const normalizedQuery = searchFilterQuery.trim().toLowerCase();

  // Why: filter by both category pill and search substring across asset path, element label, and selector for fast asset lookup.
  const filteredScreenImages = visibleScreenImages.filter((screenImage) => {
    if (
      activeCategoryFilter !== "all" &&
      classifyScreenImageCategory(screenImage) !== activeCategoryFilter
    ) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    const searchableHaystack = [
      screenImage.assetPath,
      screenImage.elementText,
      screenImage.selector,
      screenImage.tagName,
    ]
      .join(" ")
      .toLowerCase();
    return searchableHaystack.includes(normalizedQuery);
  });

  if (isPanelCollapsed) {
    // Why: allow collapsing the explorer to a slim clickable rail when the user wants maximum horizontal space for the canvas.
    return (
      <Pressable
        onPress={() => setIsPanelCollapsed(false)}
        style={{
          width: 40,
          backgroundColor: theme.colors.surface1,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: "#ec4899",
          paddingVertical: 10,
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 6,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "700", color: "#ec4899" }}>‹</Text>
        <Text style={{ fontSize: 10, fontWeight: "700", color: "#ec4899" }}>Ảnh</Text>
        <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foreground }}>
          {visibleScreenImages.length}
        </Text>
      </Pressable>
    );
  }

  return (
    <View
      style={{
        width: 245,
        backgroundColor: theme.colors.surface1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#ec4899",
        padding: 8,
        gap: 6,
      }}
    >
      {/* Top interactive bar: category pills + Scan & Collapse buttons */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, flex: 1 }}>
          {CATEGORY_FILTER_OPTIONS.map((categoryOption) => {
            const isCategorySelected = activeCategoryFilter === categoryOption.id;
            return (
              <Pressable
                key={categoryOption.id}
                onPress={() => setActiveCategoryFilter(categoryOption.id)}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 3,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: isCategorySelected ? "#ec4899" : theme.colors.border,
                  backgroundColor: isCategorySelected ? theme.colors.surface2 : theme.colors.surface0,
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: isCategorySelected ? "700" : "500",
                    color: isCategorySelected ? "#ec4899" : theme.colors.foregroundMuted,
                  }}
                >
                  {categoryOption.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Pressable
            onPress={onRescanScreenImages}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderRadius: 5,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: "600", color: theme.colors.foreground }}>
              Quét
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setIsPanelCollapsed(true)}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderRadius: 5,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
              ›
            </Text>
          </Pressable>
        </View>
      </View>

      <TextInput
        value={searchFilterQuery}
        onChangeText={setSearchFilterQuery}
        placeholder="Tìm ảnh..."
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          paddingHorizontal: 8,
          paddingVertical: 5,
          fontSize: 11,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
        }}
      />

      {/* Scrollable 2-column grid of clickable image thumbnails */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6, paddingBottom: 4 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {filteredScreenImages.map((screenImg, imageIndex) => {
            const isSelectedImage = selectedImageSelector === screenImg.selector;
            const shortAssetFilename =
              (screenImg.assetPath || screenImg.elementText || screenImg.tagName)
                .split("/")
                .pop() ?? "image";

            return (
              <Pressable
                key={`${screenImg.selector}-${imageIndex}`}
                onPress={() => handlePressImageCard(screenImg)}
                style={{
                  width: "48%",
                  padding: 6,
                  gap: 4,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                  borderColor: isSelectedImage ? "#ec4899" : theme.colors.border,
                  borderWidth: isSelectedImage ? 2 : 1,
                }}
              >
                {renderInlineImagePreview({
                  imageUri: screenImg.imagePreviewUri,
                  altText: shortAssetFilename,
                  maxHeightPx: 64,
                  onDoubleClick: () => onOpenImageMarkupDialog(screenImg),
                })}
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: "700",
                    color: isSelectedImage ? "#ec4899" : theme.colors.foreground,
                    fontFamily: "monospace",
                  }}
                  numberOfLines={1}
                >
                  {shortAssetFilename}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
