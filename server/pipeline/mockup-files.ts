// Path rules and git checks for the project's single `.slp/mockup` source, with HTML preview bundling re-exported.
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { MOCKUP_ROOT } from "../../shared/board";
import { runGit } from "../git/git";
import { ToolError } from "./tool-error";

export { bundleMockupHtmlPreview } from "./mockup-html-bundler";

// Accepts `checkout.html` or a full path so agents cannot scatter feature mockups outside the shared root.
export function normalizeMockupFilePath(rawFilePath: string): string {
  const slashedPath = rawFilePath.trim().replace(/\\/g, "/");
  const relativeToRoot = slashedPath.startsWith(`${MOCKUP_ROOT}/`)
    ? slashedPath.slice(MOCKUP_ROOT.length + 1)
    : slashedPath;
  const normalizedName = posix.normalize(relativeToRoot);
  // One feature is one top-level file; `core/` and `assets/` are shared parts, never a feature's entry point.
  if (normalizedName.includes("/") || !normalizedName.endsWith(".html") || normalizedName.startsWith(".")) {
    throw new ToolError(`A feature mockup must be a single HTML file directly under '${MOCKUP_ROOT}/', such as 'checkout.html'.`);
  }
  return `${MOCKUP_ROOT}/${normalizedName}`;
}

// Inline code hides logic from review and blurs git diffs, so the feature index may only load files.
const INLINE_SCRIPT_BLOCK_REGEX = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const INLINE_STYLE_BLOCK_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

// Refuses a missing index and one that still carries inline <script> or <style> code.
export async function assertMockupIndexLoadsOnly(repoPath: string, mockupFile: string): Promise<void> {
  const indexSource = await readFile(resolve(repoPath, mockupFile), "utf8").catch(() => null);
  if (indexSource === null) {
    throw new ToolError(`Missing mockup file '${mockupFile}'. Write it before calling this tool.`);
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
  const trackedOutput = await runGit(repoPath, ["ls-files", "--", mockupFile]);
  if (!trackedOutput.trim()) {
    throw new ToolError(`'${mockupFile}' is not committed yet. Commit '${MOCKUP_ROOT}' first (check that it is not in .gitignore).`);
  }
  const uncommittedChanges = (await runGit(repoPath, ["status", "--porcelain", "--", MOCKUP_ROOT])).trim();
  if (uncommittedChanges) {
    throw new ToolError(`Commit the changes in '${MOCKUP_ROOT}' before approving:\n${uncommittedChanges}`);
  }
  return (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
}
