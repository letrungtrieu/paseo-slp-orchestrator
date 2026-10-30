// Filesystem cloning, multi-version archiving, and HTML/CSS/JS bundling for `.slp/mockups/<feature>`.
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const EXTERNAL_ASSET_SCHEME_REGEX = /^(?:https?:|data:|blob:|\/\/)/i;
const STYLESHEET_LINK_TAG_REGEX = /<link\b([^>]*?)>/gi;
const EXTERNAL_SCRIPT_TAG_REGEX =
  /<script\b([^>]*?)\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')([^>]*)>\s*<\/script>/gi;

// Injected into bundled preview HTML so the SLP Mockup Viewer can toggle "Pick HTML Element to Comment" mode.
const SLP_MOCKUP_ELEMENT_INSPECTOR_BRIDGE = `<script data-slp-mockup-inspector="true">
(function () {
  var inspectEnabled = false;
  var hoveredElement = null;
  var selectedElement = null;

  function buildElementSelector(targetEl) {
    if (!targetEl || targetEl.nodeType !== 1) return "body";
    if (targetEl.id) return targetEl.tagName.toLowerCase() + "#" + targetEl.id;
    var pathSegments = [];
    var currentEl = targetEl;
    while (currentEl && currentEl.nodeType === 1 && currentEl.tagName.toLowerCase() !== "html") {
      var segment = currentEl.tagName.toLowerCase();
      if (currentEl.id) {
        segment += "#" + currentEl.id;
        pathSegments.unshift(segment);
        break;
      }
      var classList = Array.from(currentEl.classList || []).filter(Boolean).slice(0, 2);
      if (classList.length > 0) {
        segment += "." + classList.join(".");
      }
      var parentEl = currentEl.parentElement;
      if (parentEl) {
        var sameTagSiblings = Array.from(parentEl.children).filter(function (sib) {
          return sib.tagName === currentEl.tagName;
        });
        if (sameTagSiblings.length > 1) {
          var nthIndex = sameTagSiblings.indexOf(currentEl) + 1;
          segment += ":nth-of-type(" + nthIndex + ")";
        }
      }
      pathSegments.unshift(segment);
      currentEl = parentEl;
      if (pathSegments.length >= 4) break;
    }
    return pathSegments.join(" > ") || "body";
  }

  function extractElementSnippet(targetEl) {
    if (!targetEl) return "";
    var rawText = (targetEl.innerText || targetEl.textContent || targetEl.getAttribute("placeholder") || targetEl.getAttribute("aria-label") || targetEl.value || "").trim().replace(/\\s+/g, " ");
    return rawText.slice(0, 80);
  }

  function clearHoverOutline() {
    if (hoveredElement && hoveredElement !== selectedElement) {
      hoveredElement.style.outline = hoveredElement.__slpPrevOutline || "";
      hoveredElement.style.outlineOffset = hoveredElement.__slpPrevOutlineOffset || "";
    }
    hoveredElement = null;
  }

  function clearSelectedOutline() {
    if (selectedElement) {
      selectedElement.style.outline = selectedElement.__slpPrevOutline || "";
      selectedElement.style.outlineOffset = selectedElement.__slpPrevOutlineOffset || "";
    }
    selectedElement = null;
  }

  document.addEventListener("mousemove", function (mouseEvent) {
    if (!inspectEnabled) return;
    var candidateEl = mouseEvent.target;
    if (!candidateEl || candidateEl === hoveredElement || candidateEl === document.body || candidateEl === document.documentElement) return;
    clearHoverOutline();
    hoveredElement = candidateEl;
    if (hoveredElement !== selectedElement) {
      hoveredElement.__slpPrevOutline = hoveredElement.style.outline;
      hoveredElement.__slpPrevOutlineOffset = hoveredElement.style.outlineOffset;
      hoveredElement.style.outline = "2px dashed #06b6d4";
      hoveredElement.style.outlineOffset = "2px";
    }
  }, true);

  document.addEventListener("click", function (clickEvent) {
    if (!inspectEnabled) return;
    var pickedEl = clickEvent.target;
    if (!pickedEl || pickedEl.nodeType !== 1) return;
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    clickEvent.stopImmediatePropagation();
    clearHoverOutline();
    clearSelectedOutline();
    selectedElement = pickedEl;
    selectedElement.__slpPrevOutline = selectedElement.style.outline;
    selectedElement.__slpPrevOutlineOffset = selectedElement.style.outlineOffset;
    selectedElement.style.outline = "2px solid #f59e0b";
    selectedElement.style.outlineOffset = "2px";
    window.parent.postMessage({
      type: "slp-mockup-element-picked",
      selector: buildElementSelector(pickedEl),
      tagName: pickedEl.tagName.toLowerCase(),
      elementText: extractElementSnippet(pickedEl)
    }, "*");
  }, true);

  window.addEventListener("message", function (msgEvent) {
    var payload = msgEvent && msgEvent.data;
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "slp-mockup-set-inspect-mode") {
      inspectEnabled = Boolean(payload.enabled);
      document.body.style.cursor = inspectEnabled ? "crosshair" : "";
      if (!inspectEnabled) {
        clearHoverOutline();
        clearSelectedOutline();
      }
    } else if (payload.type === "slp-mockup-highlight-selector" && payload.selector) {
      try {
        var foundEl = document.querySelector(payload.selector);
        if (foundEl) {
          clearSelectedOutline();
          selectedElement = foundEl;
          selectedElement.__slpPrevOutline = selectedElement.style.outline;
          selectedElement.__slpPrevOutlineOffset = selectedElement.style.outlineOffset;
          selectedElement.style.outline = "2px solid #f59e0b";
          selectedElement.style.outlineOffset = "2px";
          foundEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } catch (_err) {}
    }
  });
})();
</script>`;

export interface SnapshotFeatureMockupParams {
  repoPath: string;
  leadWorktreePath?: string | null;
  featureSlug: string;
  versionNumber: number;
}

export interface SnapshotFeatureMockupOutput {
  featureSlug: string;
  workingDirPath: string;
  versionDirPath: string;
  entryHtmlPath: string;
  absoluteEntryHtmlPath: string;
}

// Check whether a file exists on disk without throwing when probing worktree vs repoPath locations.
async function fileExistsOnDisk(candidateFilePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(candidateFilePath);
    return fileStats.isFile();
  } catch {
    return false;
  }
}

// Copy all working mockup files (excluding the `versions/` archive folder) from sourceDir into targetDir.
async function copyWorkingMockupFilesExcludingVersions(
  sourceWorkingDirectory: string,
  targetDirectory: string,
): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  const directoryEntries = await readdir(sourceWorkingDirectory, { withFileTypes: true });

  for (const directoryEntry of directoryEntries) {
    // Never recursively copy the `versions` archive folder into itself when snapshotting a new version.
    if (directoryEntry.name === "versions") {
      continue;
    }
    const sourceEntryPath = join(sourceWorkingDirectory, directoryEntry.name);
    const targetEntryPath = join(targetDirectory, directoryEntry.name);
    await cp(sourceEntryPath, targetEntryPath, { recursive: true, force: true });
  }
}

// Snapshot `.slp/mockups/<feature>/` into `.slp/mockups/<feature>/versions/v<N>/` and sync across worktree and repoPath.
export async function snapshotFeatureMockupVersion(
  params: SnapshotFeatureMockupParams,
): Promise<SnapshotFeatureMockupOutput> {
  const relativeWorkingDir = `.slp/mockups/${params.featureSlug}`;
  const relativeVersionDir = `${relativeWorkingDir}/versions/v${params.versionNumber}`;
  const relativeEntryHtmlPath = `${relativeVersionDir}/index.html`;

  const repoWorkingDir = resolve(params.repoPath, relativeWorkingDir);
  const worktreeWorkingDir = params.leadWorktreePath
    ? resolve(params.leadWorktreePath, relativeWorkingDir)
    : null;

  // Prefer the Lead's worktree working mockup when present; fall back to repoPath when written directly.
  const worktreeIndexExists = worktreeWorkingDir
    ? await fileExistsOnDisk(join(worktreeWorkingDir, "index.html"))
    : false;
  const repoIndexExists = await fileExistsOnDisk(join(repoWorkingDir, "index.html"));

  if (!worktreeIndexExists && !repoIndexExists) {
    throw new Error(
      `Missing mockup entry point '${relativeWorkingDir}/index.html'. Write your HTML/CSS/JS mockup to '${relativeWorkingDir}/index.html' before calling slp_submit_mockup.`,
    );
  }

  const authoritativeWorkingDir = worktreeIndexExists && worktreeWorkingDir
    ? worktreeWorkingDir
    : repoWorkingDir;

  // Sync the active working directory between the Lead's worktree and repoPath so both have the latest files.
  if (worktreeWorkingDir && authoritativeWorkingDir !== repoWorkingDir) {
    await copyWorkingMockupFilesExcludingVersions(authoritativeWorkingDir, repoWorkingDir);
  } else if (worktreeWorkingDir && authoritativeWorkingDir !== worktreeWorkingDir) {
    await copyWorkingMockupFilesExcludingVersions(authoritativeWorkingDir, worktreeWorkingDir);
  }

  // Clone the working mockup into the immutable version directory (`versions/v<N>`) in repoPath and worktree.
  const repoVersionDir = resolve(params.repoPath, relativeVersionDir);
  await copyWorkingMockupFilesExcludingVersions(authoritativeWorkingDir, repoVersionDir);

  if (worktreeWorkingDir && resolve(params.leadWorktreePath!) !== resolve(params.repoPath)) {
    const worktreeVersionDir = resolve(params.leadWorktreePath!, relativeVersionDir);
    await copyWorkingMockupFilesExcludingVersions(authoritativeWorkingDir, worktreeVersionDir);
  }

  return {
    featureSlug: params.featureSlug,
    workingDirPath: relativeWorkingDir,
    versionDirPath: relativeVersionDir,
    entryHtmlPath: relativeEntryHtmlPath,
    absoluteEntryHtmlPath: join(repoVersionDir, "index.html"),
  };
}

// Restore or sync a specific archived version (`versions/v<N>`) back into the working directory `.slp/mockups/<feature>/`.
export async function syncMockupVersionToWorkingDirectory(params: {
  repoPath: string;
  leadWorktreePath?: string | null;
  featureSlug: string;
  versionNumber: number;
}): Promise<void> {
  const relativeWorkingDir = `.slp/mockups/${params.featureSlug}`;
  const relativeVersionDir = `${relativeWorkingDir}/versions/v${params.versionNumber}`;
  const repoVersionDir = resolve(params.repoPath, relativeVersionDir);
  const versionIndexExists = await fileExistsOnDisk(join(repoVersionDir, "index.html"));
  if (!versionIndexExists) {
    return;
  }

  // Ensure the working directory in both repoPath and the Lead's worktree matches the chosen version snapshot.
  const repoWorkingDir = resolve(params.repoPath, relativeWorkingDir);
  await copyWorkingMockupFilesExcludingVersions(repoVersionDir, repoWorkingDir);

  if (params.leadWorktreePath && resolve(params.leadWorktreePath) !== resolve(params.repoPath)) {
    const worktreeWorkingDir = resolve(params.leadWorktreePath, relativeWorkingDir);
    await copyWorkingMockupFilesExcludingVersions(repoVersionDir, worktreeWorkingDir);
  }
}

// Extract an HTML attribute value (such as href or rel) regardless of single or double quoting.
function extractHtmlAttribute(rawTagAttributes: string, attributeName: string): string | null {
  const attributePattern = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`,
    "i",
  );
  const attributeMatch = rawTagAttributes.match(attributePattern);
  return attributeMatch?.[1] ?? attributeMatch?.[2] ?? attributeMatch?.[3] ?? null;
}

// Read a mockup's index.html, inline sibling CSS/JS files, and inject the SLP element-comment inspector bridge.
export async function bundleMockupHtmlPreview(
  repoPath: string,
  relativeEntryHtmlPath: string,
): Promise<{ absoluteHtmlPath: string; bundledHtml: string }> {
  const absoluteHtmlPath = resolve(repoPath, relativeEntryHtmlPath);
  const rawHtml = await readFile(absoluteHtmlPath, "utf8");
  const mockupVersionDirectory = dirname(absoluteHtmlPath);

  let htmlWithInlinedStyles = rawHtml;
  const stylesheetMatches = Array.from(rawHtml.matchAll(STYLESHEET_LINK_TAG_REGEX));

  // Inline local <link rel="stylesheet" href="./styles.css"> files from the same mockup version directory.
  for (const stylesheetMatch of stylesheetMatches) {
    const fullLinkTag = stylesheetMatch[0];
    const tagAttributes = stylesheetMatch[1] ?? "";
    const relAttribute = extractHtmlAttribute(tagAttributes, "rel")?.toLowerCase() ?? "";
    const hrefAttribute = extractHtmlAttribute(tagAttributes, "href")?.trim() ?? "";

    if (!relAttribute.includes("stylesheet") || !hrefAttribute || EXTERNAL_ASSET_SCHEME_REGEX.test(hrefAttribute)) {
      continue;
    }

    const cleanRelativeCssPath = hrefAttribute.split(/[?#]/)[0] ?? hrefAttribute;
    const resolvedCssFilePath = resolve(mockupVersionDirectory, cleanRelativeCssPath);
    try {
      const stylesheetSourceText = await readFile(resolvedCssFilePath, "utf8");
      const safeStylesheetText = stylesheetSourceText.replace(/<\/style/gi, "<\\/style");
      htmlWithInlinedStyles = htmlWithInlinedStyles.replace(
        fullLinkTag,
        `<style data-inlined-href="${hrefAttribute}">\n${safeStylesheetText}\n</style>`,
      );
    } catch {
      // Preserve the original <link> tag if an optional stylesheet does not exist on disk.
    }
  }

  let bundledHtml = htmlWithInlinedStyles;
  const scriptMatches = Array.from(htmlWithInlinedStyles.matchAll(EXTERNAL_SCRIPT_TAG_REGEX));

  // Inline local <script src="./app.js"></script> files so interactive UI events work inside the sandboxed srcDoc iframe.
  for (const scriptMatch of scriptMatches) {
    const fullScriptTag = scriptMatch[0];
    const leadingAttributes = scriptMatch[1] ?? "";
    const rawScriptSrc = (scriptMatch[2] ?? scriptMatch[3] ?? "").trim();
    const trailingAttributes = scriptMatch[4] ?? "";

    if (!rawScriptSrc || EXTERNAL_ASSET_SCHEME_REGEX.test(rawScriptSrc)) {
      continue;
    }

    const cleanRelativeScriptPath = rawScriptSrc.split(/[?#]/)[0] ?? rawScriptSrc;
    const resolvedScriptFilePath = resolve(mockupVersionDirectory, cleanRelativeScriptPath);
    try {
      const scriptSourceText = await readFile(resolvedScriptFilePath, "utf8");
      const safeScriptSourceText = scriptSourceText.replace(/<\/script/gi, "<\\/script");
      const preservedTypeAttribute = extractHtmlAttribute(
        `${leadingAttributes} ${trailingAttributes}`,
        "type",
      );
      const typeAttributeFragment = preservedTypeAttribute ? ` type="${preservedTypeAttribute}"` : "";
      bundledHtml = bundledHtml.replace(
        fullScriptTag,
        `<script${typeAttributeFragment} data-inlined-src="${rawScriptSrc}">\n${safeScriptSourceText}\n</script>`,
      );
    } catch {
      // Preserve the original <script> tag if an optional script file cannot be read.
    }
  }

  // Append the element-comment inspector bridge so users can click any HTML tag in the preview to attach a review comment.
  const bundledHtmlWithInspector = /<\/body>/i.test(bundledHtml)
    ? bundledHtml.replace(/<\/body>/i, `${SLP_MOCKUP_ELEMENT_INSPECTOR_BRIDGE}\n</body>`)
    : `${bundledHtml}\n${SLP_MOCKUP_ELEMENT_INSPECTOR_BRIDGE}`;

  return { absoluteHtmlPath, bundledHtml: bundledHtmlWithInspector };
}
