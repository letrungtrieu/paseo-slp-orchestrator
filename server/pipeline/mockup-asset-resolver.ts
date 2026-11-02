// Path resolution, base64 data-URI encoding, and pre-indexed image collection for `.slp/mockup` previews.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DESIGN_ROOT, MOCKUP_ROOT } from "../../shared/board";

export const EXTERNAL_ASSET_SCHEME_REGEX = /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|about:|\/\/|#)/i;

// Maximum file size (10 MB) for inlining local binary assets into base64 data URIs.
const MAX_INLINE_ASSET_BYTES = 10 * 1024 * 1024;
// Maximum number of mockup directory images pre-indexed for dynamic JS rendering.
const MAX_PREINDEXED_MOCKUP_IMAGES = 64;
// Budget for the pre-indexed data URIs: the whole bundle travels through one RPC and one iframe `srcDoc`, so it must stay small.
const MAX_PREINDEXED_ASSET_CHARS = 8 * 1024 * 1024;

// Each image is stored once; every path spelling a script may use points at its slot in `assetUris`.
export interface PreindexedMockupAssets {
  assetUris: string[];
  assetIndexByKey: Record<string, number>;
}

export const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
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
      resolve(repoRoot, DESIGN_ROOT),
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
// Files already inlined by the static passes (`encodedUriCache`) are skipped: their data URI is already in the page.
export async function collectMockupDirectoryAssetMap(
  mockupDirectories: readonly string[],
  allowedRoots: readonly string[],
  encodedUriCache: Map<string, string>,
): Promise<PreindexedMockupAssets> {
  const preindexedAssets: PreindexedMockupAssets = { assetUris: [], assetIndexByKey: {} };
  let indexedImageCount = 0;
  let indexedUriChars = 0;

  async function walkDirectory(rootMockupDir: string, currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const directoryEntry of entries) {
      if (indexedImageCount >= MAX_PREINDEXED_MOCKUP_IMAGES) return;
      const fullEntryPath = join(currentDir, directoryEntry.name);
      if (!isPathInsideAllowedRoots(fullEntryPath, allowedRoots)) {
        continue;
      }
      if (directoryEntry.isDirectory()) {
        await walkDirectory(rootMockupDir, fullEntryPath);
        continue;
      }
      if (!directoryEntry.isFile() || encodedUriCache.has(fullEntryPath)) {
        continue;
      }
      // The size is only known after encoding, so the budget check follows it; an over-budget file is skipped, not truncated.
      const assetDataUri = await encodeFileAsDataUri(fullEntryPath, encodedUriCache);
      if (!assetDataUri) {
        continue;
      }
      if (indexedUriChars + assetDataUri.length > MAX_PREINDEXED_ASSET_CHARS) {
        continue;
      }
      indexedImageCount += 1;
      indexedUriChars += assetDataUri.length;
      const assetSlot = preindexedAssets.assetUris.push(assetDataUri) - 1;
      const relativeKey = relative(rootMockupDir, fullEntryPath).replace(/\\/g, "/");
      preindexedAssets.assetIndexByKey[relativeKey] ??= assetSlot;
      preindexedAssets.assetIndexByKey[`./${relativeKey}`] ??= assetSlot;
      preindexedAssets.assetIndexByKey[basename(fullEntryPath)] ??= assetSlot;
    }
  }

  for (const mockupDir of mockupDirectories) {
    await walkDirectory(mockupDir, mockupDir);
  }
  return preindexedAssets;
}
