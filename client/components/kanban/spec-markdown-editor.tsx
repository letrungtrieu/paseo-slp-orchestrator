// Full-height Spec Requirements component supporting instant switching between raw Markdown text editing and rich Markdown preview.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { UiStyles } from "../../styles";
import { parseMarkdownBlocks, renderInlineMarkdownSpans } from "./markdown-parser";

export type SpecEditorMode = "edit" | "preview";

export interface SpecMarkdownEditorProps {
  styles: UiStyles;
  theme: PluginTheme;
  label?: string;
  markdownContent: string;
  onChangeMarkdownContent: (nextMarkdownContent: string) => void;
  placeholder?: string;
  initialMode?: SpecEditorMode;
  minHeight?: number;
}

// Renders the parsed Markdown blocks inside a scrollable full-height surface matching the Paseo theme.
function MarkdownPreviewPane({
  styles,
  theme,
  markdownContent,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  markdownContent: string;
}) {
  const trimmedMarkdown = markdownContent.trim();
  if (!trimmedMarkdown) {
    return (
      <View
        style={[
          styles.input,
          {
            flex: 1,
            minHeight: 0,
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: theme.colors.surface0,
          },
        ]}
      >
        <Text style={styles.mutedText}>
          Nothing to preview yet. Switch to Edit to write Spec requirements.
        </Text>
      </View>
    );
  }

  const markdownBlocks = parseMarkdownBlocks(trimmedMarkdown);

  return (
    // Constrain the preview ScrollView with minHeight: 0 so only the Spec Markdown content scrolls while header/footer stay fixed.
    <ScrollView
      style={[
        styles.input,
        {
          flex: 1,
          minHeight: 0,
          backgroundColor: theme.colors.surface0,
        },
      ]}
      contentContainerStyle={{ gap: 10, paddingVertical: 4 }}
      showsVerticalScrollIndicator
    >
      {markdownBlocks.map((blockNode, blockIndex) => {
        const blockKey = `md-block-${blockIndex}`;

        if (blockNode.kind === "divider") {
          return (
            <View
              key={blockKey}
              style={{
                height: 1,
                backgroundColor: theme.colors.border,
                marginVertical: 4,
              }}
            />
          );
        }

        if (blockNode.kind === "heading") {
          const level = blockNode.headingLevel ?? 2;
          // Scale heading font size and weight according to Markdown heading depth.
          const headingFontSize = level === 1 ? 17 : level === 2 ? 15 : level === 3 ? 14 : 13;
          return (
            <View
              key={blockKey}
              style={
                level <= 2
                  ? {
                      borderBottomWidth: 1,
                      borderBottomColor: theme.colors.border,
                      paddingBottom: 4,
                      marginTop: blockIndex > 0 ? 4 : 0,
                    }
                  : { marginTop: blockIndex > 0 ? 2 : 0 }
              }
            >
              <Text
                style={{
                  fontSize: headingFontSize,
                  fontWeight: "700",
                  color: theme.colors.foreground,
                }}
              >
                {renderInlineMarkdownSpans(blockNode.textContent ?? "", theme, blockKey)}
              </Text>
            </View>
          );
        }

        if (blockNode.kind === "code_block") {
          return (
            <View
              key={blockKey}
              style={{
                backgroundColor: theme.colors.surface2,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                padding: 8,
                gap: 4,
              }}
            >
              {blockNode.codeLanguage ? (
                <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
                  {blockNode.codeLanguage.toUpperCase()}
                </Text>
              ) : null}
              <Text
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  color: theme.colors.foreground,
                  lineHeight: 17,
                }}
              >
                {blockNode.textContent ?? ""}
              </Text>
            </View>
          );
        }

        if (blockNode.kind === "blockquote") {
          return (
            <View
              key={blockKey}
              style={{
                borderLeftWidth: 3,
                borderLeftColor: theme.colors.accent,
                backgroundColor: theme.colors.surface1,
                paddingVertical: 6,
                paddingHorizontal: 10,
                borderRadius: 4,
              }}
            >
              <Text style={[styles.bodyText, { fontStyle: "italic" }]}>
                {renderInlineMarkdownSpans(blockNode.textContent ?? "", theme, blockKey)}
              </Text>
            </View>
          );
        }

        if (blockNode.kind === "unordered_list" || blockNode.kind === "ordered_list") {
          return (
            <View key={blockKey} style={{ gap: 5, paddingLeft: 4 }}>
              {(blockNode.listItems ?? []).map((listItem, itemIndex) => {
                const itemKey = `${blockKey}-item-${itemIndex}`;
                return (
                  <View
                    key={itemKey}
                    style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: "700",
                        color:
                          listItem.isChecked === true
                            ? theme.colors.statusSuccess
                            : theme.colors.accent,
                        minWidth: 16,
                      }}
                    >
                      {listItem.markerLabel}
                    </Text>
                    <Text style={[styles.bodyText, { flex: 1, lineHeight: 19 }]}>
                      {renderInlineMarkdownSpans(listItem.itemText, theme, itemKey)}
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        }

        if (blockNode.kind === "table" && blockNode.tableRows && blockNode.tableRows.length > 0) {
          const [headerRow, ...bodyRows] = blockNode.tableRows;
          return (
            <View
              key={blockKey}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  backgroundColor: theme.colors.surface2,
                  borderBottomWidth: bodyRows.length > 0 ? 1 : 0,
                  borderBottomColor: theme.colors.border,
                }}
              >
                {headerRow.map((headerCell, cellIndex) => (
                  <View key={`${blockKey}-th-${cellIndex}`} style={{ flex: 1, padding: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.foreground }}>
                      {renderInlineMarkdownSpans(headerCell, theme, `${blockKey}-th-${cellIndex}`)}
                    </Text>
                  </View>
                ))}
              </View>
              {bodyRows.map((bodyRow, rowIndex) => (
                <View
                  key={`${blockKey}-tr-${rowIndex}`}
                  style={{
                    flexDirection: "row",
                    borderBottomWidth: rowIndex < bodyRows.length - 1 ? 1 : 0,
                    borderBottomColor: theme.colors.border,
                  }}
                >
                  {bodyRow.map((bodyCell, cellIndex) => (
                    <View key={`${blockKey}-td-${rowIndex}-${cellIndex}`} style={{ flex: 1, padding: 6 }}>
                      <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
                        {renderInlineMarkdownSpans(
                          bodyCell,
                          theme,
                          `${blockKey}-td-${rowIndex}-${cellIndex}`,
                        )}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          );
        }

        return (
          <Text key={blockKey} style={[styles.bodyText, { lineHeight: 20 }]}>
            {renderInlineMarkdownSpans(blockNode.textContent ?? "", theme, blockKey)}
          </Text>
        );
      })}
    </ScrollView>
  );
}

// Reusable Spec Requirements field with a fixed Edit / Preview header and an internally scrollable Spec content body.
export function SpecMarkdownEditor({
  styles,
  theme,
  label = "Spec Requirements (Shared with Supervisor)",
  markdownContent,
  onChangeMarkdownContent,
  placeholder = "Write the full feature specification in Markdown...",
  initialMode = "edit",
}: SpecMarkdownEditorProps) {
  const [editorMode, setEditorMode] = useState<SpecEditorMode>(initialMode);

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: "hidden", gap: 6 }}>
      {/* Header row pairs the field label with the segmented Edit / Preview switcher and stays fixed above the scrollable content. */}
      <View
        style={[
          styles.row,
          { justifyContent: "space-between", alignItems: "center", flexShrink: 0 },
        ]}
      >
        <Text style={styles.fieldLabel}>{label}</Text>
        <View
          style={{
            flexDirection: "row",
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            overflow: "hidden",
          }}
        >
          <Pressable
            onPress={() => setEditorMode("edit")}
            accessibilityRole="button"
            accessibilityLabel="Switch Spec editor to raw text edit mode"
            style={{
              paddingHorizontal: 10,
              paddingVertical: 4,
              backgroundColor: editorMode === "edit" ? theme.colors.accent : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color:
                  editorMode === "edit"
                    ? theme.colors.accentForeground
                    : theme.colors.foregroundMuted,
              }}
            >
              Edit
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setEditorMode("preview")}
            accessibilityRole="button"
            accessibilityLabel="Switch Spec editor to Markdown preview mode"
            style={{
              paddingHorizontal: 10,
              paddingVertical: 4,
              backgroundColor: editorMode === "preview" ? theme.colors.accent : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color:
                  editorMode === "preview"
                    ? theme.colors.accentForeground
                    : theme.colors.foregroundMuted,
              }}
            >
              Preview
            </Text>
          </Pressable>
        </View>
      </View>

      {editorMode === "edit" ? (
        <TextInput
          style={[styles.input, { flex: 1, minHeight: 0, textAlignVertical: "top" }]}
          value={markdownContent}
          onChangeText={onChangeMarkdownContent}
          multiline
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
        />
      ) : (
        <MarkdownPreviewPane
          styles={styles}
          theme={theme}
          markdownContent={markdownContent}
        />
      )}
    </View>
  );
}
