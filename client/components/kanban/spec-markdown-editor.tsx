// Full-height Spec Requirements component supporting instant switching between raw Markdown text editing and rich Markdown preview.
import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { UiStyles } from "../../styles";

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

interface ParsedMarkdownBlock {
  kind:
    | "heading"
    | "code_block"
    | "blockquote"
    | "unordered_list"
    | "ordered_list"
    | "table"
    | "divider"
    | "paragraph";
  headingLevel?: number;
  codeLanguage?: string;
  textContent?: string;
  listItems?: Array<{ markerLabel: string; itemText: string; isChecked?: boolean | null }>;
  tableRows?: string[][];
}

// Splits a single line of Markdown text into styled inline spans (inline code, bold, italic, and links).
function renderInlineMarkdownSpans(
  rawLineText: string,
  theme: PluginTheme,
  keyPrefix: string,
): ReactNode[] {
  // Match inline code (`...`), bold (**...**), links ([...](...)), or italic (*...*) in priority order.
  const inlineTokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*)/g;
  const renderedSpans: ReactNode[] = [];
  let lastMatchedIndex = 0;
  let tokenIndex = 0;

  for (const regexMatch of rawLineText.matchAll(inlineTokenPattern)) {
    const matchStartIndex = regexMatch.index ?? 0;
    if (matchStartIndex > lastMatchedIndex) {
      renderedSpans.push(rawLineText.slice(lastMatchedIndex, matchStartIndex));
    }
    const matchedToken = regexMatch[0];
    const spanKey = `${keyPrefix}-span-${tokenIndex++}`;

    if (matchedToken.startsWith("`") && matchedToken.endsWith("`")) {
      // Render inline code tokens with monospace font and a subtle surface pill background.
      renderedSpans.push(
        <Text
          key={spanKey}
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            backgroundColor: theme.colors.surface2,
            color: theme.colors.accent,
            paddingHorizontal: 4,
            borderRadius: 4,
          }}
        >
          {matchedToken.slice(1, -1)}
        </Text>,
      );
    } else if (matchedToken.startsWith("**") && matchedToken.endsWith("**")) {
      renderedSpans.push(
        <Text key={spanKey} style={{ fontWeight: "700", color: theme.colors.foreground }}>
          {matchedToken.slice(2, -2)}
        </Text>,
      );
    } else if (matchedToken.startsWith("[") && matchedToken.includes("](") && matchedToken.endsWith(")")) {
      const labelEndIndex = matchedToken.indexOf("](");
      const linkLabel = matchedToken.slice(1, labelEndIndex);
      renderedSpans.push(
        <Text
          key={spanKey}
          style={{
            color: theme.colors.accent,
            textDecorationLine: "underline",
            fontWeight: "600",
          }}
        >
          {linkLabel}
        </Text>,
      );
    } else if (matchedToken.startsWith("*") && matchedToken.endsWith("*")) {
      renderedSpans.push(
        <Text key={spanKey} style={{ fontStyle: "italic" }}>
          {matchedToken.slice(1, -1)}
        </Text>,
      );
    } else {
      renderedSpans.push(matchedToken);
    }
    lastMatchedIndex = matchStartIndex + matchedToken.length;
  }

  if (lastMatchedIndex < rawLineText.length) {
    renderedSpans.push(rawLineText.slice(lastMatchedIndex));
  }
  return renderedSpans;
}

// Parses raw Markdown text into structured block nodes so the preview renders headings, lists, tables, and code fences cleanly.
function parseMarkdownBlocks(markdownSource: string): ParsedMarkdownBlock[] {
  const sourceLines = markdownSource.replace(/\r\n/g, "\n").split("\n");
  const parsedBlocks: ParsedMarkdownBlock[] = [];
  let lineIndex = 0;

  while (lineIndex < sourceLines.length) {
    const currentLine = sourceLines[lineIndex];
    const trimmedLine = currentLine.trim();

    // Skip blank lines between block-level Markdown elements.
    if (!trimmedLine) {
      lineIndex += 1;
      continue;
    }

    // Parse fenced code blocks (```lang ... ```) as a single preformatted block.
    if (trimmedLine.startsWith("```")) {
      const codeLanguage = trimmedLine.slice(3).trim();
      const codeBodyLines: string[] = [];
      lineIndex += 1;
      while (lineIndex < sourceLines.length && !sourceLines[lineIndex].trim().startsWith("```")) {
        codeBodyLines.push(sourceLines[lineIndex]);
        lineIndex += 1;
      }
      if (lineIndex < sourceLines.length) {
        lineIndex += 1;
      }
      parsedBlocks.push({
        kind: "code_block",
        codeLanguage,
        textContent: codeBodyLines.join("\n"),
      });
      continue;
    }

    // Parse horizontal rules (---, ***, ___).
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmedLine)) {
      parsedBlocks.push({ kind: "divider" });
      lineIndex += 1;
      continue;
    }

    // Parse ATX headings (# H1 through ###### H6).
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmedLine);
    if (headingMatch) {
      parsedBlocks.push({
        kind: "heading",
        headingLevel: headingMatch[1].length,
        textContent: headingMatch[2].trim(),
      });
      lineIndex += 1;
      continue;
    }

    // Parse contiguous blockquote lines (> ...).
    if (trimmedLine.startsWith(">")) {
      const quoteLines: string[] = [];
      while (lineIndex < sourceLines.length && sourceLines[lineIndex].trim().startsWith(">")) {
        quoteLines.push(sourceLines[lineIndex].trim().replace(/^>\s?/, ""));
        lineIndex += 1;
      }
      parsedBlocks.push({
        kind: "blockquote",
        textContent: quoteLines.join("\n"),
      });
      continue;
    }

    // Parse pipe tables (| Col A | Col B |) and filter out separator rows (|---|---|).
    if (trimmedLine.startsWith("|") && trimmedLine.endsWith("|") && trimmedLine.length > 2) {
      const parsedTableRows: string[][] = [];
      while (
        lineIndex < sourceLines.length &&
        sourceLines[lineIndex].trim().startsWith("|") &&
        sourceLines[lineIndex].trim().endsWith("|")
      ) {
        const rowCells = sourceLines[lineIndex]
          .trim()
          .slice(1, -1)
          .split("|")
          .map((rawCell) => rawCell.trim());
        const isSeparatorRow = rowCells.every((cellText) => /^:?-{2,}:?$/.test(cellText));
        if (!isSeparatorRow) {
          parsedTableRows.push(rowCells);
        }
        lineIndex += 1;
      }
      if (parsedTableRows.length > 0) {
        parsedBlocks.push({
          kind: "table",
          tableRows: parsedTableRows,
        });
      }
      continue;
    }

    // Parse unordered lists (- item, * item, + item) including GFM task checkboxes (- [x] item).
    if (/^[-*+]\s+/.test(trimmedLine)) {
      const unorderedItems: Array<{ markerLabel: string; itemText: string; isChecked?: boolean | null }> = [];
      while (lineIndex < sourceLines.length && /^[-*+]\s+/.test(sourceLines[lineIndex].trim())) {
        const rawItemBody = sourceLines[lineIndex].trim().replace(/^[-*+]\s+/, "");
        const checkboxMatch = /^\[([ xX])\]\s+(.*)$/.exec(rawItemBody);
        if (checkboxMatch) {
          const isChecked = checkboxMatch[1].toLowerCase() === "x";
          unorderedItems.push({
            markerLabel: isChecked ? "☑" : "☐",
            itemText: checkboxMatch[2],
            isChecked,
          });
        } else {
          unorderedItems.push({
            markerLabel: "•",
            itemText: rawItemBody,
            isChecked: null,
          });
        }
        lineIndex += 1;
      }
      parsedBlocks.push({
        kind: "unordered_list",
        listItems: unorderedItems,
      });
      continue;
    }

    // Parse ordered lists (1. item, 2) item).
    if (/^\d+[.)]\s+/.test(trimmedLine)) {
      const orderedItems: Array<{ markerLabel: string; itemText: string }> = [];
      while (lineIndex < sourceLines.length && /^\d+[.)]\s+/.test(sourceLines[lineIndex].trim())) {
        const orderedMatch = /^(\d+[.)])\s+(.*)$/.exec(sourceLines[lineIndex].trim());
        if (orderedMatch) {
          orderedItems.push({
            markerLabel: orderedMatch[1],
            itemText: orderedMatch[2],
          });
        }
        lineIndex += 1;
      }
      parsedBlocks.push({
        kind: "ordered_list",
        listItems: orderedItems,
      });
      continue;
    }

    // Group consecutive regular lines into a single paragraph block.
    const paragraphLines: string[] = [];
    while (
      lineIndex < sourceLines.length &&
      sourceLines[lineIndex].trim().length > 0 &&
      !sourceLines[lineIndex].trim().startsWith("```") &&
      !sourceLines[lineIndex].trim().startsWith(">") &&
      !/^(#{1,6})\s+/.test(sourceLines[lineIndex].trim()) &&
      !/^[-*+]\s+/.test(sourceLines[lineIndex].trim()) &&
      !/^\d+[.)]\s+/.test(sourceLines[lineIndex].trim()) &&
      !/^(?:-{3,}|\*{3,}|_{3,})$/.test(sourceLines[lineIndex].trim())
    ) {
      paragraphLines.push(sourceLines[lineIndex].trim());
      lineIndex += 1;
    }
    parsedBlocks.push({
      kind: "paragraph",
      textContent: paragraphLines.join(" "),
    });
  }

  return parsedBlocks;
}

// Renders the parsed Markdown blocks inside a scrollable full-height surface matching the Paseo theme.
function MarkdownPreviewPane({
  styles,
  theme,
  markdownContent,
  minHeight,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  markdownContent: string;
  minHeight: number;
}) {
  const trimmedMarkdown = markdownContent.trim();
  if (!trimmedMarkdown) {
    return (
      <View
        style={[
          styles.input,
          {
            flex: 1,
            minHeight,
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
    <ScrollView
      style={[
        styles.input,
        {
          flex: 1,
          minHeight,
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

// Reusable Spec Requirements field with a segmented Edit / Markdown Preview toggle bar.
export function SpecMarkdownEditor({
  styles,
  theme,
  label = "Spec Requirements (Shared with Supervisor)",
  markdownContent,
  onChangeMarkdownContent,
  placeholder = "Write the full feature specification in Markdown...",
  initialMode = "edit",
  minHeight = 250,
}: SpecMarkdownEditorProps) {
  const [editorMode, setEditorMode] = useState<SpecEditorMode>(initialMode);

  return (
    <View style={{ flex: 1, gap: 6 }}>
      {/* Header row pairs the field label with the segmented Edit / Preview switcher. */}
      <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
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
              backgroundColor:
                editorMode === "edit" ? theme.colors.accent : "transparent",
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
              backgroundColor:
                editorMode === "preview" ? theme.colors.accent : "transparent",
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
          style={[styles.input, { flex: 1, minHeight, textAlignVertical: "top" }]}
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
          minHeight={minHeight}
        />
      )}
    </View>
  );
}
