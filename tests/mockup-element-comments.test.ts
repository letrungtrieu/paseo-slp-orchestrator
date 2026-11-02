// Covers how element notes, single or drag-selected groups, are rendered for the Product Agent.
import { describe, expect, it } from "vitest";
import { formatMockupElementCommentsMarkdown } from "../server/store/board-mockup";

describe("formatMockupElementCommentsMarkdown", () => {
  it("keeps the one-line form for a note on a single element", () => {
    const singleElementNote = formatMockupElementCommentsMarkdown([
      { selector: "button#buy", tagName: "button", elementText: "Buy", targets: [], comment: "Make it bigger" },
    ]);
    // Notes saved before multi-select must read exactly as they always did.
    expect(singleElementNote).toContain("1. `<button>` selector `button#buy` (\"Buy\"): Make it bigger");
  });

  it("lists every element a drag-select note covers", () => {
    const groupTargets = [
      { selector: "div#card-a", tagName: "div", elementText: "A" },
      { selector: "div#card-b", tagName: "div", elementText: "B" },
    ];
    const groupNote = formatMockupElementCommentsMarkdown([
      { ...groupTargets[0], targets: groupTargets, comment: "Align these cards" },
    ]);
    expect(groupNote).toContain("2 elements: Align these cards");
    expect(groupNote).toContain("selector `div#card-a`");
    expect(groupNote).toContain("selector `div#card-b`");
  });

  it("includes disk asset path, dimensions, and direct image-edit instructions for Design-mode image and canvas sprite notes", () => {
    const designNote = formatMockupElementCommentsMarkdown([
      {
        selector: "canvas#game-hud [sprite: assets/golden-chest.png [frame 0,0 64x64]]",
        tagName: "canvas-img",
        elementText: "assets/golden-chest.png [frame 0,0 64x64]",
        assetPath: "assets/golden-chest.png",
        imageDimensions: "256x64px · canvas(120,80 64x64px)",
        targets: [],
        comment: "Nhờ Codex vẽ lại rương vàng kim sáng hơn và thêm hiệu ứng lấp lánh",
      },
    ]);
    expect(designNote).toContain(
      "[Image Asset: `assets/golden-chest.png` · 256x64px · canvas(120,80 64x64px)]",
    );
    expect(designNote).toContain("Design / Image Asset Edit Note:");
  });
});
