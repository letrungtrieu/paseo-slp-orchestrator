// Self-contained HTML/CSS/JS/image bundler for `.slp/mockup` so `<iframe srcDoc>` previews render a feature file with its shared core.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildCandidateBaseDirectories,
  buildMockupInspectorBridgeScript,
  collectMockupDirectoryAssetMap,
  encodeFileAsDataUri,
  EXTERNAL_ASSET_SCHEME_REGEX,
  resolveLocalAssetFilePath,
} from "./mockup-asset-resolver";

const STYLESHEET_LINK_TAG_REGEX = /<link\b([^>]*?)>/gi;
const EXTERNAL_SCRIPT_TAG_REGEX =
  /<script\b([^>]*?)\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')([^>]*)>\s*<\/script>/gi;
const INLINE_STYLE_BLOCK_REGEX = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const INLINE_STYLE_ATTRIBUTE_REGEX = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_FUNCTION_REGEX = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi;
const HTML_ASSET_ATTRIBUTE_REGEX =
  /\b(src|poster|xlink:href|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
const HTML_SRCSET_ATTRIBUTE_REGEX = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
const SCRIPT_BLOCK_REGEX = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
const QUOTED_ASSET_LITERAL_REGEX =
  /(["'])(?!https?:|data:|blob:|\/\/)([^"'\r\n]+?\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp|mp3|wav|ogg|mp4|webm))\1/gi;

// Extract an HTML attribute value (such as href or rel) regardless of single or double quoting.
function extractHtmlAttribute(rawTagAttributes: string, attributeName: string): string | null {
  const attributePattern = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`,
    "i",
  );
  const attributeMatch = rawTagAttributes.match(attributePattern);
  return attributeMatch?.[1] ?? attributeMatch?.[2] ?? attributeMatch?.[3] ?? null;
}

// Replace all local `url(...)` references inside a CSS string with base64 data URIs.
async function inlineCssUrlReferences(
  cssSourceText: string,
  candidateBaseDirectories: readonly string[],
  allowedRoots: readonly string[],
  encodedUriCache: Map<string, string>,
  preferredBaseDirectory?: string,
): Promise<string> {
  const urlMatches = Array.from(cssSourceText.matchAll(CSS_URL_FUNCTION_REGEX));
  if (urlMatches.length === 0) {
    return cssSourceText;
  }
  let rewrittenCssText = cssSourceText;
  for (const urlMatch of urlMatches) {
    const fullUrlExpression = urlMatch[0];
    const rawUrlValue = (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3] ?? "").trim();
    const resolvedAssetPath = await resolveLocalAssetFilePath(
      rawUrlValue,
      candidateBaseDirectories,
      allowedRoots,
      preferredBaseDirectory,
    );
    if (!resolvedAssetPath) {
      continue;
    }
    const assetDataUri = await encodeFileAsDataUri(resolvedAssetPath, encodedUriCache);
    if (assetDataUri) {
      rewrittenCssText = rewrittenCssText.replace(fullUrlExpression, `url("${assetDataUri}")`);
    }
  }
  return rewrittenCssText;
}

// Read a mockup's index.html, inline sibling/workspace CSS, JS, and images, and inject the SLP element-comment inspector bridge.
export async function bundleMockupHtmlPreview(
  repoPath: string,
  relativeEntryHtmlPath: string,
): Promise<{ absoluteHtmlPath: string; bundledHtml: string }> {
  const { allowedRoots, candidateBaseDirectories, mockupDirectoriesToIndex } =
    buildCandidateBaseDirectories(repoPath, relativeEntryHtmlPath);

  // Fall back to the plain repo path so a missing file reports where it was expected.
  const resolvedEntryCandidate = await resolveLocalAssetFilePath(
    relativeEntryHtmlPath,
    allowedRoots,
    allowedRoots,
  );
  const absoluteHtmlPath = resolvedEntryCandidate ?? resolve(repoPath, relativeEntryHtmlPath);
  const rawHtml = await readFile(absoluteHtmlPath, "utf8");
  const mockupEntryDirectory = dirname(absoluteHtmlPath);
  const encodedUriCache = new Map<string, string>();

  let bundledHtml = rawHtml;
  const stylesheetMatches = Array.from(rawHtml.matchAll(STYLESHEET_LINK_TAG_REGEX));

  // Inline local <link rel="stylesheet" href="./styles.css"> files and rewrite nested CSS `url(...)` relative to the CSS file first.
  for (const stylesheetMatch of stylesheetMatches) {
    const fullLinkTag = stylesheetMatch[0];
    const tagAttributes = stylesheetMatch[1] ?? "";
    const relAttribute = extractHtmlAttribute(tagAttributes, "rel")?.toLowerCase() ?? "";
    const hrefAttribute = extractHtmlAttribute(tagAttributes, "href")?.trim() ?? "";

    if (!relAttribute.includes("stylesheet") || !hrefAttribute || EXTERNAL_ASSET_SCHEME_REGEX.test(hrefAttribute)) {
      continue;
    }

    const resolvedCssFilePath = await resolveLocalAssetFilePath(
      hrefAttribute,
      candidateBaseDirectories,
      allowedRoots,
      mockupEntryDirectory,
    );
    if (!resolvedCssFilePath) {
      continue;
    }
    try {
      const stylesheetSourceText = await readFile(resolvedCssFilePath, "utf8");
      const cssWithInlinedAssets = await inlineCssUrlReferences(
        stylesheetSourceText,
        candidateBaseDirectories,
        allowedRoots,
        encodedUriCache,
        dirname(resolvedCssFilePath),
      );
      const safeStylesheetText = cssWithInlinedAssets.replace(/<\/style/gi, "<\\/style");
      bundledHtml = bundledHtml.replace(
        fullLinkTag,
        `<style data-inlined-href="${hrefAttribute}">\n${safeStylesheetText}\n</style>`,
      );
    } catch {
      // Preserve the original <link> tag if an optional stylesheet cannot be read.
    }
  }

  // Inline local <script src="./app.js"></script> files so interactive UI events work inside the sandboxed srcDoc iframe.
  const scriptMatches = Array.from(bundledHtml.matchAll(EXTERNAL_SCRIPT_TAG_REGEX));
  for (const scriptMatch of scriptMatches) {
    const fullScriptTag = scriptMatch[0];
    const leadingAttributes = scriptMatch[1] ?? "";
    const rawScriptSrc = (scriptMatch[2] ?? scriptMatch[3] ?? "").trim();
    const trailingAttributes = scriptMatch[4] ?? "";

    if (!rawScriptSrc || EXTERNAL_ASSET_SCHEME_REGEX.test(rawScriptSrc)) {
      continue;
    }

    const resolvedScriptFilePath = await resolveLocalAssetFilePath(
      rawScriptSrc,
      candidateBaseDirectories,
      allowedRoots,
      mockupEntryDirectory,
    );
    if (!resolvedScriptFilePath) {
      continue;
    }
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

  // Rewrite `url(...)` inside all `<style>...</style>` blocks (including newly inlined stylesheets and existing inline style tags).
  const styleBlockMatches = Array.from(bundledHtml.matchAll(INLINE_STYLE_BLOCK_REGEX));
  for (const styleBlockMatch of styleBlockMatches) {
    const fullStyleBlock = styleBlockMatch[0];
    const openStyleTag = styleBlockMatch[1] ?? "<style>";
    const styleBodyText = styleBlockMatch[2] ?? "";
    const closeStyleTag = styleBlockMatch[3] ?? "</style>";
    const rewrittenStyleBody = await inlineCssUrlReferences(
      styleBodyText,
      candidateBaseDirectories,
      allowedRoots,
      encodedUriCache,
      mockupEntryDirectory,
    );
    if (rewrittenStyleBody !== styleBodyText) {
      bundledHtml = bundledHtml.replace(fullStyleBlock, `${openStyleTag}${rewrittenStyleBody}${closeStyleTag}`);
    }
  }

  // Rewrite `url(...)` inside inline `style="..."` HTML attributes (such as `style="background-image: url('./hero.png')"`).
  const inlineStyleAttrMatches = Array.from(bundledHtml.matchAll(INLINE_STYLE_ATTRIBUTE_REGEX));
  for (const inlineStyleAttrMatch of inlineStyleAttrMatches) {
    const fullStyleAttribute = inlineStyleAttrMatch[0];
    const styleAttributeValue = inlineStyleAttrMatch[1] ?? inlineStyleAttrMatch[2] ?? "";
    const rewrittenStyleAttributeValue = await inlineCssUrlReferences(
      styleAttributeValue,
      candidateBaseDirectories,
      allowedRoots,
      encodedUriCache,
      mockupEntryDirectory,
    );
    if (rewrittenStyleAttributeValue !== styleAttributeValue) {
      const quoteChar = fullStyleAttribute.includes("'") && !fullStyleAttribute.includes('"') ? "'" : '"';
      bundledHtml = bundledHtml.replace(
        fullStyleAttribute,
        `style=${quoteChar}${rewrittenStyleAttributeValue}${quoteChar}`,
      );
    }
  }

  // Rewrite `srcset="..."` attributes on responsive `<img>` and `<source>` elements into data URIs.
  const srcsetMatches = Array.from(bundledHtml.matchAll(HTML_SRCSET_ATTRIBUTE_REGEX));
  for (const srcsetMatch of srcsetMatches) {
    const fullSrcsetAttribute = srcsetMatch[0];
    const rawSrcsetValue = srcsetMatch[1] ?? srcsetMatch[2] ?? "";
    const srcsetCandidates = rawSrcsetValue.split(",");
    let didRewriteSrcset = false;
    const rewrittenCandidates: string[] = [];

    for (const candidateSegment of srcsetCandidates) {
      const trimmedSegment = candidateSegment.trim();
      if (!trimmedSegment) continue;
      const [candidateUrl, ...descriptorTokens] = trimmedSegment.split(/\s+/);
      const resolvedCandidatePath = await resolveLocalAssetFilePath(
        candidateUrl,
        candidateBaseDirectories,
        allowedRoots,
        mockupEntryDirectory,
      );
      const encodedCandidateUri = resolvedCandidatePath
        ? await encodeFileAsDataUri(resolvedCandidatePath, encodedUriCache)
        : null;
      if (encodedCandidateUri) {
        didRewriteSrcset = true;
        rewrittenCandidates.push([encodedCandidateUri, ...descriptorTokens].join(" "));
      } else {
        rewrittenCandidates.push(trimmedSegment);
      }
    }

    if (didRewriteSrcset) {
      bundledHtml = bundledHtml.replace(fullSrcsetAttribute, `srcset="${rewrittenCandidates.join(", ")}"`);
    }
  }

  // Rewrite local `src`, `poster`, `href` (icons/SVG `<image>`/`<use>`), and `xlink:href` attributes to base64 data URIs.
  const assetAttributeMatches = Array.from(bundledHtml.matchAll(HTML_ASSET_ATTRIBUTE_REGEX));
  for (const assetAttributeMatch of assetAttributeMatches) {
    const fullAttributeMatch = assetAttributeMatch[0];
    const attributeName = assetAttributeMatch[1] ?? "src";
    const rawAttributeValue = (assetAttributeMatch[2] ?? assetAttributeMatch[3] ?? "").trim();
    if (!rawAttributeValue || EXTERNAL_ASSET_SCHEME_REGEX.test(rawAttributeValue)) {
      continue;
    }
    const resolvedAssetFilePath = await resolveLocalAssetFilePath(
      rawAttributeValue,
      candidateBaseDirectories,
      allowedRoots,
      mockupEntryDirectory,
    );
    if (!resolvedAssetFilePath) {
      continue;
    }
    const encodedDataUri = await encodeFileAsDataUri(resolvedAssetFilePath, encodedUriCache);
    if (encodedDataUri) {
      bundledHtml = bundledHtml.replace(fullAttributeMatch, `${attributeName}="${encodedDataUri}"`);
    }
  }

  // Rewrite static local image string literals inside `<script>...</script>` blocks to data URIs.
  const scriptBlockMatches = Array.from(bundledHtml.matchAll(SCRIPT_BLOCK_REGEX));
  for (const scriptBlockMatch of scriptBlockMatches) {
    const fullScriptBlock = scriptBlockMatch[0];
    const openScriptTag = scriptBlockMatch[1] ?? "<script>";
    const scriptBodyText = scriptBlockMatch[2] ?? "";
    const closeScriptTag = scriptBlockMatch[3] ?? "</script>";
    const literalMatches = Array.from(scriptBodyText.matchAll(QUOTED_ASSET_LITERAL_REGEX));
    if (literalMatches.length === 0) {
      continue;
    }
    let rewrittenScriptBody = scriptBodyText;
    for (const literalMatch of literalMatches) {
      const fullQuotedLiteral = literalMatch[0];
      const quoteCharacter = literalMatch[1] ?? '"';
      const candidateAssetPath = literalMatch[2] ?? "";
      const resolvedAssetPath = await resolveLocalAssetFilePath(
        candidateAssetPath,
        candidateBaseDirectories,
        allowedRoots,
        mockupEntryDirectory,
      );
      if (!resolvedAssetPath) {
        continue;
      }
      const assetDataUri = await encodeFileAsDataUri(resolvedAssetPath, encodedUriCache);
      if (assetDataUri) {
        rewrittenScriptBody = rewrittenScriptBody.replace(
          fullQuotedLiteral,
          `${quoteCharacter}${assetDataUri}${quoteCharacter}`,
        );
      }
    }
    if (rewrittenScriptBody !== scriptBodyText) {
      bundledHtml = bundledHtml.replace(fullScriptBlock, `${openScriptTag}${rewrittenScriptBody}${closeScriptTag}`);
    }
  }

  // Pre-index all images in the mockup folder so dynamic JS template strings (`img.src = "assets/" + id`) also resolve.
  const preindexedAssetMap = await collectMockupDirectoryAssetMap(
    mockupDirectoriesToIndex,
    allowedRoots,
    encodedUriCache,
  );
  const inspectorBridgeScript = buildMockupInspectorBridgeScript(preindexedAssetMap);

  const bundledHtmlWithInspector = /<\/body>/i.test(bundledHtml)
    ? bundledHtml.replace(/<\/body>/i, `${inspectorBridgeScript}\n</body>`)
    : `${bundledHtml}\n${inspectorBridgeScript}`;

  return { absoluteHtmlPath, bundledHtml: bundledHtmlWithInspector };
}
