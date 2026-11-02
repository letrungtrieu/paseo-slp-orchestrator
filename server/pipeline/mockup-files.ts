// Path rules and git checks for `.design/` (`paseo-design` plugin) and `.slp/mockup`, with HTML preview bundling re-exported.
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { DESIGN_ROOT, MOCKUP_ROOT } from "../../shared/board";
import { runGit } from "../git/git";
import { ToolError } from "./tool-error";

export { bundleMockupHtmlPreview } from "./mockup-html-bundler";

// Accepts `.design/checkout.html`, `.slp/mockup/checkout.html`, or `checkout.html` so feature designs stay inside the recognized roots.
export function normalizeMockupFilePath(rawFilePath: string): string {
  const slashedPath = rawFilePath.trim().replace(/\\/g, "/");
  // When the path targets `.design/` (from `paseo-design`), preserve the `.design` root so pure HTML/CSS/JS files work seamlessly.
  if (slashedPath.startsWith(`${DESIGN_ROOT}/`)) {
    const relativeToDesignRoot = slashedPath.slice(DESIGN_ROOT.length + 1);
    const normalizedDesignName = posix.normalize(relativeToDesignRoot);
    if (
      !normalizedDesignName ||
      normalizedDesignName.startsWith("..") ||
      normalizedDesignName.startsWith(".") ||
      !normalizedDesignName.endsWith(".html")
    ) {
      throw new ToolError(
        `A design file under '${DESIGN_ROOT}/' must be an HTML file such as '${DESIGN_ROOT}/checkout.html'.`,
      );
    }
    return `${DESIGN_ROOT}/${normalizedDesignName}`;
  }

  const relativeToRoot = slashedPath.startsWith(`${MOCKUP_ROOT}/`)
    ? slashedPath.slice(MOCKUP_ROOT.length + 1)
    : slashedPath;
  const normalizedName = posix.normalize(relativeToRoot);
  // One feature is one top-level file; `core/` and `assets/` are shared parts, never a feature's entry point.
  if (normalizedName.includes("/") || !normalizedName.endsWith(".html") || normalizedName.startsWith(".")) {
    throw new ToolError(`A feature mockup must be a single HTML file directly under '${MOCKUP_ROOT}/' (or '${DESIGN_ROOT}/'), such as 'checkout.html'.`);
  }
  return `${MOCKUP_ROOT}/${normalizedName}`;
}

// Inline code hides logic from review and blurs git diffs in `.slp/mockup`, while `.design/` allows full inline HTML-JS-CSS.
const INLINE_SCRIPT_BLOCK_REGEX = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const INLINE_STYLE_BLOCK_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

// Refuses a missing index and (for `.slp/mockup/` files) one that still carries inline <script> or <style> code.
export async function assertMockupIndexLoadsOnly(repoPath: string, mockupFile: string): Promise<void> {
  const indexSource = await readFile(resolve(repoPath, mockupFile), "utf8").catch(() => null);
  if (indexSource === null) {
    throw new ToolError(`Missing mockup file '${mockupFile}'. Write it before calling this tool.`);
  }
  // Files inside `.design/` (`paseo-design` plugin) are intentionally written in pure HTML-JS-CSS for fast interactive prototyping.
  if (mockupFile.replace(/\\/g, "/").startsWith(`${DESIGN_ROOT}/`)) {
    return;
  }
  const inlineBlocks = [
    ...indexSource.matchAll(INLINE_SCRIPT_BLOCK_REGEX),
    ...indexSource.matchAll(INLINE_STYLE_BLOCK_REGEX),
  ];
  if (inlineBlocks.some((inlineBlock) => inlineBlock[1].trim() !== "")) {
    throw new ToolError(
      `'${mockupFile}' contains inline <script> or <style> code. Move it into '${MOCKUP_ROOT}/features/<feature>/' as .js or .css files and load them with <script src> or <link>.`,
    );
  }
}

// Approval pins a commit, so the approved content must already be in git or a Run could start from a branch that lacks it.
export async function resolveApprovedMockupCommit(repoPath: string, mockupFile: string): Promise<string> {
  const activeDesignRoot = mockupFile.replace(/\\/g, "/").startsWith(`${DESIGN_ROOT}/`)
    ? DESIGN_ROOT
    : MOCKUP_ROOT;
  const trackedOutput = await runGit(repoPath, ["ls-files", "--", mockupFile]);
  if (!trackedOutput.trim()) {
    throw new ToolError(`'${mockupFile}' is not committed yet. Commit '${activeDesignRoot}' first (check that it is not in .gitignore).`);
  }
  const uncommittedChanges = (await runGit(repoPath, ["status", "--porcelain", "--", activeDesignRoot])).trim();
  if (uncommittedChanges) {
    throw new ToolError(`Commit the changes in '${activeDesignRoot}' before approving:\n${uncommittedChanges}`);
  }
  return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
}
