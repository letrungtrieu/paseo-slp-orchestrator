// Guards the preview bundle size: every image must be embedded once, not once per path spelling.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleMockupHtmlPreview } from "../server/pipeline/mockup-html-bundler";

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "slp-mockup-bundle-"));
  await mkdir(join(repoPath, ".slp/mockup/assets"), { recursive: true });
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

// A recognisable payload lets the test count how many times an image body lands in the bundle.
const IMAGE_PAYLOAD = Buffer.from("PNG-PAYLOAD-".repeat(200));
const IMAGE_BASE64 = IMAGE_PAYLOAD.toString("base64");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("bundleMockupHtmlPreview asset embedding", () => {
  it("embeds a statically referenced image exactly once", async () => {
    await writeFile(join(repoPath, ".slp/mockup/assets/hero.png"), IMAGE_PAYLOAD);
    await writeFile(join(repoPath, ".slp/mockup/page.html"), '<body><img src="assets/hero.png"></body>');

    const { bundledHtml } = await bundleMockupHtmlPreview(repoPath, ".slp/mockup/page.html");

    // The pre-index map used to add three more copies (relative key, ./key, basename) on top of the inline one.
    expect(countOccurrences(bundledHtml, IMAGE_BASE64)).toBe(1);
  });

  it("indexes an image only reachable by a dynamic path once, under every key spelling", async () => {
    await writeFile(join(repoPath, ".slp/mockup/assets/dynamic.png"), IMAGE_PAYLOAD);
    await writeFile(join(repoPath, ".slp/mockup/page.html"), "<body><script>var name = 'dyn' + 'amic';</script></body>");

    const { bundledHtml } = await bundleMockupHtmlPreview(repoPath, ".slp/mockup/page.html");

    expect(countOccurrences(bundledHtml, IMAGE_BASE64)).toBe(1);
    // All three spellings must still resolve, now through the shared slot index.
    expect(bundledHtml).toContain('"assets/dynamic.png":0');
    expect(bundledHtml).toContain('"./assets/dynamic.png":0');
    expect(bundledHtml).toContain('"dynamic.png":0');
  });

  it("stops pre-indexing once the size budget is spent", async () => {
    // Three ~4 MB images exceed the 8 MB budget, so at least one must be left out of the bundle.
    const bigImage = Buffer.alloc(4 * 1024 * 1024, 7);
    for (const imageName of ["a.png", "b.png", "c.png"]) {
      await writeFile(join(repoPath, ".slp/mockup/assets", imageName), bigImage);
    }
    await writeFile(join(repoPath, ".slp/mockup/page.html"), "<body></body>");

    const { bundledHtml } = await bundleMockupHtmlPreview(repoPath, ".slp/mockup/page.html");

    expect(bundledHtml.length).toBeLessThan(9 * 1024 * 1024);
  });
});
