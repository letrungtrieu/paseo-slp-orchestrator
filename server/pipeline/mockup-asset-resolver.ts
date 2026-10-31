// Path resolution, base64 data-URI encoding, and inspector bridge script generation for `.slp/mockup` previews.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MOCKUP_ROOT } from "../../shared/board";

export const EXTERNAL_ASSET_SCHEME_REGEX = /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|about:|\/\/|#)/i;

// Maximum file size (10 MB) for inlining local binary assets into base64 data URIs.
const MAX_INLINE_ASSET_BYTES = 10 * 1024 * 1024;
// Maximum number of mockup directory images pre-indexed into `window.__slpMockupAssets` for dynamic JS rendering.
const MAX_PREINDEXED_MOCKUP_IMAGES = 64;

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// Verify that a resolved candidate file stays inside one of the authorized repository or worktree roots.
export function isPathInsideAllowedRoots(
  candidateFilePath: string,
  allowedRootDirectories: readonly string[],
): boolean {
  const normalizedCandidate = resolve(candidateFilePath);
  return allowedRootDirectories.some((allowedRoot) => {
    const normalizedRoot = resolve(allowedRoot);
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
    );
  });
}

// Construct ordered candidate base directories: the mockup's own folder first, then workspace locations agents commonly reference.
export function buildCandidateBaseDirectories(
  repoPath: string,
  relativeEntryHtmlPath: string,
): { allowedRoots: string[]; candidateBaseDirectories: string[]; mockupDirectoriesToIndex: string[] } {
  const repoRoot = resolve(repoPath);
  const entryDirectory = resolve(repoRoot, dirname(relativeEntryHtmlPath.replace(/\\/g, "/")));
  return {
    allowedRoots: [repoRoot],
    candidateBaseDirectories: [...new Set([
      entryDirectory,
      resolve(repoRoot, MOCKUP_ROOT),
      repoRoot,
      resolve(repoRoot, "public"),
    ])],
    mockupDirectoriesToIndex: [entryDirectory],
  };
}

// Resolve a local relative or workspace-rooted path against the ordered candidate mockup and workspace directories.
export async function resolveLocalAssetFilePath(
  rawReferencePath: string,
  candidateBaseDirectories: readonly string[],
  allowedRoots: readonly string[],
  preferredBaseDirectory?: string,
): Promise<string | null> {
  const trimmedRef = rawReferencePath.trim();
  if (!trimmedRef || EXTERNAL_ASSET_SCHEME_REGEX.test(trimmedRef)) {
    return null;
  }
  const pathWithoutQueryOrHash = (trimmedRef.split(/[?#]/)[0] ?? trimmedRef).trim();
  if (!pathWithoutQueryOrHash) {
    return null;
  }

  let decodedRelativePath = pathWithoutQueryOrHash;
  try {
    decodedRelativePath = decodeURIComponent(pathWithoutQueryOrHash);
  } catch {
    // Keep raw path if percent-decoding fails on an unescaped `%` character.
  }

  const orderedBases = preferredBaseDirectory
    ? [preferredBaseDirectory, ...candidateBaseDirectories]
    : candidateBaseDirectories;

  // Try the path as written, without leading slashes (for `/assets/...`), and without excess `../` depth shifts.
  const relativePathVariants = [
    ...new Set([
      decodedRelativePath,
      pathWithoutQueryOrHash,
      decodedRelativePath.replace(/^\/+/, ""),
      decodedRelativePath.replace(/^(?:\.\.\/)+/, ""),
    ]),
  ].filter(Boolean);

  for (const baseDirectory of orderedBases) {
    for (const pathVariant of relativePathVariants) {
      const candidateAbsolutePath = isAbsolute(pathVariant)
        ? resolve(baseDirectory, pathVariant.replace(/^\/+/, ""))
        : resolve(baseDirectory, pathVariant);
      if (!isPathInsideAllowedRoots(candidateAbsolutePath, allowedRoots)) {
        continue;
      }
      try {
        const fileStats = await stat(candidateAbsolutePath);
        if (fileStats.isFile() && fileStats.size <= MAX_INLINE_ASSET_BYTES) {
          return candidateAbsolutePath;
        }
      } catch {
        // Continue probing the next candidate directory when the file does not exist here.
      }
    }
  }
  return null;
}

// Read a local binary/SVG/font asset file and encode it as a self-contained `data:<mime>;base64,...` URI.
export async function encodeFileAsDataUri(
  absoluteFilePath: string,
  encodedUriCache: Map<string, string>,
): Promise<string | null> {
  const cachedDataUri = encodedUriCache.get(absoluteFilePath);
  if (cachedDataUri) {
    return cachedDataUri;
  }
  const fileExtension = extname(absoluteFilePath).toLowerCase();
  const mimeType = MIME_TYPE_BY_EXTENSION[fileExtension];
  if (!mimeType) {
    return null;
  }
  try {
    const fileBuffer = await readFile(absoluteFilePath);
    const dataUri = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
    encodedUriCache.set(absoluteFilePath, dataUri);
    return dataUri;
  } catch {
    return null;
  }
}

// Pre-index image files inside the mockup folder so dynamic JS DOM rendering (`img.src = ...`) can resolve them at runtime.
export async function collectMockupDirectoryAssetMap(
  mockupDirectories: readonly string[],
  allowedRoots: readonly string[],
  encodedUriCache: Map<string, string>,
): Promise<Record<string, string>> {
  const assetMapByRelativeKey: Record<string, string> = {};
  let indexedImageCount = 0;

  async function walkDirectory(rootMockupDir: string, currentDir: string): Promise<void> {
    if (indexedImageCount >= MAX_PREINDEXED_MOCKUP_IMAGES) return;
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const directoryEntry of entries) {
      if (indexedImageCount >= MAX_PREINDEXED_MOCKUP_IMAGES) break;
      const fullEntryPath = join(currentDir, directoryEntry.name);
      if (!isPathInsideAllowedRoots(fullEntryPath, allowedRoots)) {
        continue;
      }
      if (directoryEntry.isDirectory()) {
        await walkDirectory(rootMockupDir, fullEntryPath);
        continue;
      }
      if (!directoryEntry.isFile()) {
        continue;
      }
      const assetDataUri = await encodeFileAsDataUri(fullEntryPath, encodedUriCache);
      if (!assetDataUri) {
        continue;
      }
      indexedImageCount += 1;
      const relativeKey = relative(rootMockupDir, fullEntryPath).replace(/\\/g, "/");
      assetMapByRelativeKey[relativeKey] ??= assetDataUri;
      assetMapByRelativeKey[`./${relativeKey}`] ??= assetDataUri;
      assetMapByRelativeKey[basename(fullEntryPath)] ??= assetDataUri;
    }
  }

  for (const mockupDir of mockupDirectories) {
    await walkDirectory(mockupDir, mockupDir);
  }
  return assetMapByRelativeKey;
}

// Build the inspector + dynamic asset fallback bridge injected at the end of the bundled mockup HTML.
export function buildMockupInspectorBridgeScript(
  preindexedAssetMap: Readonly<Record<string, string>>,
): string {
  // Serialize the pre-indexed mockup image map safely so dynamic JS `img.src = "assets/" + name` resolves inside srcDoc.
  const serializedAssetMap = JSON.stringify(preindexedAssetMap).replace(/<\/script/gi, "<\\/script");
  return `<script data-slp-mockup-inspector="true">
(function () {
  var inspectEnabled = false;
  var hoveredElement = null;
  var selectedElement = null;
  var mockupAssetMap = ${serializedAssetMap};
  window.__slpMockupAssets = mockupAssetMap;

  function lookupMockupAssetDataUri(rawAssetPath) {
    if (!rawAssetPath || typeof rawAssetPath !== "string") return null;
    var trimmedPath = rawAssetPath.trim();
    if (!trimmedPath || /^(?:https?:|data:|blob:|\\/\\/)/i.test(trimmedPath)) return null;
    var cleanPath = (trimmedPath.split(/[?#]/)[0] || trimmedPath).replace(/\\\\/g, "/");
    if (mockupAssetMap[cleanPath]) return mockupAssetMap[cleanPath];
    var normalizedRelative = cleanPath.replace(/^(?:\\.\\/|\\/|\\.\\.\\/)*/, "");
    if (mockupAssetMap[normalizedRelative]) return mockupAssetMap[normalizedRelative];
    var fileBasename = normalizedRelative.split("/").pop();
    if (fileBasename && mockupAssetMap[fileBasename]) return mockupAssetMap[fileBasename];
    return null;
  }

  function rewriteDynamicElementAssetAttributes(rootNode) {
    if (!rootNode || !rootNode.querySelectorAll) return;
    var mediaNodes = rootNode.querySelectorAll("img[src], source[src], video[src], video[poster], image[href], use[href]");
    for (var idx = 0; idx < mediaNodes.length; idx++) {
      var mediaEl = mediaNodes[idx];
      var attrNames = ["src", "poster", "href"];
      for (var attrIdx = 0; attrIdx < attrNames.length; attrIdx++) {
        var attrName = attrNames[attrIdx];
        var rawVal = mediaEl.getAttribute(attrName);
        var resolvedUri = lookupMockupAssetDataUri(rawVal);
        if (resolvedUri && rawVal !== resolvedUri) {
          mediaEl.setAttribute(attrName, resolvedUri);
        }
      }
    }
  }

  window.addEventListener("error", function (errorEvent) {
    var brokenTarget = errorEvent && errorEvent.target;
    if (!brokenTarget || brokenTarget.nodeType !== 1) return;
    var rawSrcAttr = brokenTarget.getAttribute && (brokenTarget.getAttribute("src") || brokenTarget.getAttribute("href"));
    var fallbackUri = lookupMockupAssetDataUri(rawSrcAttr);
    if (fallbackUri) {
      if (brokenTarget.hasAttribute("src")) brokenTarget.setAttribute("src", fallbackUri);
      else if (brokenTarget.hasAttribute("href")) brokenTarget.setAttribute("href", fallbackUri);
    }
  }, true);

  if (typeof MutationObserver !== "undefined") {
    var domObserver = new MutationObserver(function () {
      rewriteDynamicElementAssetAttributes(document);
    });
    if (document.documentElement) {
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "poster", "href"]
      });
    }
  }
  rewriteDynamicElementAssetAttributes(document);

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
}
