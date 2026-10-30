// Lightweight Markdown block and inline span parser for rendering rich Spec previews inside the Paseo theme.
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Text } from "react-native";

export interface ParsedMarkdownBlock {
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
export function renderInlineMarkdownSpans(
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
    } else if (
      matchedToken.startsWith("[") &&
      matchedToken.includes("](") &&
      matchedToken.endsWith(")")
    ) {
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
export function parseMarkdownBlocks(markdownSource: string): ParsedMarkdownBlock[] {
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
      const unorderedItems: Array<{
        markerLabel: string;
        itemText: string;
        isChecked?: boolean | null;
      }> = [];
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
