// The preview server is a network surface over repository files, so these tests pin what it may and may not serve.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMockupPreviewUrl } from "../server/pipeline/mockup-preview-server";

let repoPath: string;
let outsideDirectory: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "slp-preview-repo-"));
  outsideDirectory = await mkdtemp(join(tmpdir(), "slp-preview-outside-"));
  await mkdir(join(repoPath, ".slp/mockup/assets"), { recursive: true });
  await writeFile(join(repoPath, ".slp/mockup/page.html"), "<html><body><img src=\"assets/a.png\"></body></html>");
  await writeFile(join(repoPath, ".slp/mockup/assets/a.png"), Buffer.from("PNGDATA"));
  await writeFile(join(repoPath, ".slp/mockup/app.js"), "console.log(1)");
  await writeFile(join(repoPath, "secret.env"), "TOKEN=1");
  await writeFile(join(outsideDirectory, "outside.txt"), "outside");
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
  await rm(outsideDirectory, { recursive: true, force: true });
});

// Builds a sibling URL under the same token, e.g. the assets a page would request relative to itself.
function siblingUrl(entryUrl: string, relativePath: string): string {
  return new URL(relativePath, entryUrl).toString();
}

describe("mockup preview server", () => {
  it("serves the entry HTML with the inspector bridge and no inlined image", async () => {
    const entryUrl = await getMockupPreviewUrl(repoPath, ".slp/mockup/page.html");
    const response = await fetch(entryUrl);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("data-slp-mockup-inspector");
    expect(body).toContain("CanvasRenderingContext2D.prototype.drawImage");
    expect(body).toContain("resolveCanvasSpriteAtPoint");
    // The page must reference the image by URL, otherwise the bundle-size problem is back.
    expect(body).toContain('src="assets/a.png"');
    expect(body).not.toContain("data:image");
  });

  it("streams assets with their MIME type and CORS header for the sandboxed iframe", async () => {
    const entryUrl = await getMockupPreviewUrl(repoPath, ".slp/mockup/page.html");
    const imageResponse = await fetch(siblingUrl(entryUrl, "assets/a.png"));
    const scriptResponse = await fetch(siblingUrl(entryUrl, "app.js"));

    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(Buffer.from(await imageResponse.arrayBuffer()).toString()).toBe("PNGDATA");
    expect(scriptResponse.headers.get("content-type")).toContain("javascript");
  });

  it("does not serve files above the mockup root or through a symlink out of it", async () => {
    const entryUrl = await getMockupPreviewUrl(repoPath, ".slp/mockup/page.html");
    await symlink(join(outsideDirectory, "outside.txt"), join(repoPath, ".slp/mockup/link.txt"));
    const token = new URL(entryUrl).pathname.split("/")[1];
    const origin = new URL(entryUrl).origin;

    // Raw sockets via fetch normalise `..`, so the encoded form is what a real attacker would send.
    const traversal = await fetch(`${origin}/${token}/%2e%2e/%2e%2e/secret.env`);
    const symlinkEscape = await fetch(siblingUrl(entryUrl, "link.txt"));

    expect(traversal.status).toBe(404);
    expect(symlinkEscape.status).toBe(404);
  });

  it("rejects an unknown token", async () => {
    const entryUrl = await getMockupPreviewUrl(repoPath, ".slp/mockup/page.html");
    const origin = new URL(entryUrl).origin;

    expect((await fetch(`${origin}/not-a-token/page.html`)).status).toBe(404);
  });

  it("keeps the same URL for the same repository so browser caches survive", async () => {
    const firstUrl = await getMockupPreviewUrl(repoPath, ".slp/mockup/page.html");
    const secondUrl = await getMockupPreviewUrl(repoPath, ".slp/mockup/page.html");

    expect(secondUrl).toBe(firstUrl);
  });
});
