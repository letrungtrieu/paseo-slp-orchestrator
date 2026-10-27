// Produces Git-style unified line diffs for Spec revisions and Brief bullet revisions without shelling out to git.
import type { BriefItem } from "../../shared/board";

// Renders a Brief revision as deterministic Markdown lines so line-by-line diffing highlights exact bullet changes.
export function serializeBriefForDiff(approach: string, items: readonly BriefItem[]): string {
  // Format in-scope bullets with their verification command so verification changes also surface in the Brief diff.
  const inScopeLines = items
    .filter((bulletItem) => bulletItem.scope === "in")
    .map((bulletItem) => `- [${bulletItem.id}] ${bulletItem.requirement} (verify: ${bulletItem.verification || "n/a"})`);
  // Keep out-of-scope exclusions in the serialized text so scope boundary shifts are tracked across revisions.
  const outOfScopeLines = items
    .filter((bulletItem) => bulletItem.scope === "out")
    .map((bulletItem) => `- [OUT:${bulletItem.id}] ${bulletItem.requirement}`);
  return [
    `Approach: ${approach.trim()}`,
    "In Scope:",
    ...(inScopeLines.length > 0 ? inScopeLines : ["- (none)"]),
    "Out of Scope:",
    ...(outOfScopeLines.length > 0 ? outOfScopeLines : ["- (none)"]),
  ].join("\n");
}

// Uses a longest-common-subsequence matrix over lines to produce a readable unified diff (+ / - / space).
export function computeUnifiedTextDiff(
  previousText: string,
  nextText: string,
  previousLabel = "rev-prev",
  nextLabel = "rev-next",
): string {
  // Normalize CRLF line endings so platform differences never produce noisy full-file diffs.
  const normalizedPrevious = previousText.replace(/\r\n/g, "\n").trim();
  const normalizedNext = nextText.replace(/\r\n/g, "\n").trim();
  if (normalizedPrevious === normalizedNext) {
    return "";
  }
  // When there is no prior text (rev 1), prefix every non-empty line with '+' so the initial contract is clear.
  if (!normalizedPrevious) {
    const initialLines = normalizedNext.split("\n").map((lineText) => `+ ${lineText}`);
    return [`--- ${previousLabel}`, `+++ ${nextLabel}`, ...initialLines].join("\n");
  }
  const previousLines = normalizedPrevious.split("\n");
  const nextLines = normalizedNext.split("\n");
  const previousCount = previousLines.length;
  const nextCount = nextLines.length;

  // Guard against huge documents by falling back to a compact set-based line comparison above 600 lines.
  if (previousCount * nextCount > 360_000) {
    return computeLargeDocumentFallbackDiff(previousLines, nextLines, previousLabel, nextLabel);
  }

  const lcsLengths: number[][] = Array.from({ length: previousCount + 1 }, () =>
    new Array<number>(nextCount + 1).fill(0),
  );
  // Build the LCS table bottom-up so backtracking preserves the natural document order of unchanged lines.
  for (let prevIndex = previousCount - 1; prevIndex >= 0; prevIndex -= 1) {
    for (let nextIndex = nextCount - 1; nextIndex >= 0; nextIndex -= 1) {
      if (previousLines[prevIndex] === nextLines[nextIndex]) {
        lcsLengths[prevIndex][nextIndex] = 1 + lcsLengths[prevIndex + 1][nextIndex + 1];
      } else {
        lcsLengths[prevIndex][nextIndex] = Math.max(
          lcsLengths[prevIndex + 1][nextIndex],
          lcsLengths[prevIndex][nextIndex + 1],
        );
      }
    }
  }

  // Emit unified headers first so agents and UI diff viewers can parse revision boundaries.
  const diffOutputLines: string[] = [`--- ${previousLabel}`, `+++ ${nextLabel}`];
  let prevCursor = 0;
  let nextCursor = 0;
  // Walk the LCS table greedily, emitting deletions ('-') before insertions ('+') at each divergence.
  while (prevCursor < previousCount && nextCursor < nextCount) {
    if (previousLines[prevCursor] === nextLines[nextCursor]) {
      diffOutputLines.push(`  ${previousLines[prevCursor]}`);
      prevCursor += 1;
      nextCursor += 1;
    } else if (lcsLengths[prevCursor + 1][nextCursor] >= lcsLengths[prevCursor][nextCursor + 1]) {
      diffOutputLines.push(`- ${previousLines[prevCursor]}`);
      prevCursor += 1;
    } else {
      diffOutputLines.push(`+ ${nextLines[nextCursor]}`);
      nextCursor += 1;
    }
  }
  // Flush any trailing lines removed from the end of the previous revision.
  while (prevCursor < previousCount) {
    diffOutputLines.push(`- ${previousLines[prevCursor]}`);
    prevCursor += 1;
  }
  // Flush any trailing lines appended at the end of the new revision.
  while (nextCursor < nextCount) {
    diffOutputLines.push(`+ ${nextLines[nextCursor]}`);
    nextCursor += 1;
  }
  return diffOutputLines.join("\n");
}

function computeLargeDocumentFallbackDiff(
  previousLines: readonly string[],
  nextLines: readonly string[],
  previousLabel: string,
  nextLabel: string,
): string {
  // Large specs still need deterministic +/- lines without quadratic memory allocation.
  const previousLineSet = new Set(previousLines);
  const nextLineSet = new Set(nextLines);
  const diffLines: string[] = [`--- ${previousLabel}`, `+++ ${nextLabel}`];
  for (const oldLine of previousLines) {
    if (!nextLineSet.has(oldLine)) diffLines.push(`- ${oldLine}`);
  }
  for (const newLine of nextLines) {
    if (!previousLineSet.has(newLine)) diffLines.push(`+ ${newLine}`);
    else diffLines.push(`  ${newLine}`);
  }
  return diffLines.join("\n");
}
