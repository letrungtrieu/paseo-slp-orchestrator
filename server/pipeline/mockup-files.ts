// Filesystem cloning and multi-version archiving for `.slp/mockups/<feature>`, with HTML preview bundling re-exported.
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export {
  bundleMockupHtmlPreview,
  type BundleMockupHtmlPreviewOptions,
} from "./mockup-html-bundler";

export interface SnapshotFeatureMockupParams {
  repoPath: string;
  leadWorktreePath?: string | null;
  featureSlug: string;
  fallbackFeatureSlugs?: readonly string[];
  versionNumber: number;
}

export interface SnapshotFeatureMockupOutput {
  featureSlug: string;
  workingDirPath: string;
  versionDirPath: string;
  entryHtmlPath: string;
  absoluteEntryHtmlPath: string;
}

// Return the modification timestamp (ms) of a file on disk, or null when the path does not exist.
async function fileModifiedTimestampMs(candidateFilePath: string): Promise<number | null> {
  try {
    const fileStats = await stat(candidateFilePath);
    return fileStats.isFile() ? fileStats.mtimeMs : null;
  } catch {
    return null;
  }
}

// Check whether a file exists on disk without throwing when probing worktree vs repoPath locations.
async function fileExistsOnDisk(candidateFilePath: string): Promise<boolean> {
  const modifiedTimestamp = await fileModifiedTimestampMs(candidateFilePath);
  return modifiedTimestamp !== null;
}

// Copy all working mockup files (excluding the `versions/` archive folder) from sourceDir into targetDir.
async function copyWorkingMockupFilesExcludingVersions(
  sourceWorkingDirectory: string,
  targetDirectory: string,
): Promise<void> {
  if (resolve(sourceWorkingDirectory) === resolve(targetDirectory)) {
    return;
  }
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

// Discover an alternate `.slp/mockups/<slug>` directory when an agent wrote to a pipeline-named or differently slugged folder.
async function discoverNewestMockupDirectory(
  workspaceRoots: readonly string[],
  candidateSlugs: readonly string[],
): Promise<string | null> {
  let newestDirectory: string | null = null;
  let newestTimestampMs = -1;

  // First check explicit fallback slugs (such as the pipeline name or ticket key) in priority order.
  for (const candidateSlug of candidateSlugs) {
    const trimmedSlug = candidateSlug.trim();
    if (!trimmedSlug) continue;
    for (const workspaceRoot of workspaceRoots) {
      const candidateDir = resolve(workspaceRoot, ".slp/mockups", trimmedSlug);
      const indexTimestampMs = await fileModifiedTimestampMs(join(candidateDir, "index.html"));
      if (indexTimestampMs !== null && indexTimestampMs >= newestTimestampMs) {
        newestTimestampMs = indexTimestampMs;
        newestDirectory = candidateDir;
      }
    }
  }
  if (newestDirectory) {
    return newestDirectory;
  }

  // If no explicit slug matched, scan `.slp/mockups/*/index.html` for the most recently authored mockup folder.
  for (const workspaceRoot of workspaceRoots) {
    const mockupsRoot = resolve(workspaceRoot, ".slp/mockups");
    let entries;
    try {
      entries = await readdir(mockupsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const directoryEntry of entries) {
      if (!directoryEntry.isDirectory() || directoryEntry.name === "versions") {
        continue;
      }
      const candidateDir = join(mockupsRoot, directoryEntry.name);
      const indexTimestampMs = await fileModifiedTimestampMs(join(candidateDir, "index.html"));
      if (indexTimestampMs !== null && indexTimestampMs >= newestTimestampMs) {
        newestTimestampMs = indexTimestampMs;
        newestDirectory = candidateDir;
      }
    }
  }
  return newestDirectory;
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

  const worktreeModifiedMs = worktreeWorkingDir
    ? await fileModifiedTimestampMs(join(worktreeWorkingDir, "index.html"))
    : null;
  const repoModifiedMs = await fileModifiedTimestampMs(join(repoWorkingDir, "index.html"));

  let authoritativeWorkingDir: string | null = null;
  // When both worktree and repoPath have `index.html`, pick whichever was modified most recently so rework edits are never overwritten.
  if (worktreeModifiedMs !== null && repoModifiedMs !== null && worktreeWorkingDir) {
    authoritativeWorkingDir =
      worktreeModifiedMs >= repoModifiedMs ? worktreeWorkingDir : repoWorkingDir;
  } else if (worktreeModifiedMs !== null && worktreeWorkingDir) {
    authoritativeWorkingDir = worktreeWorkingDir;
  } else if (repoModifiedMs !== null) {
    authoritativeWorkingDir = repoWorkingDir;
  } else {
    // Fall back to scanning alternate slug folders under `.slp/mockups/` if the agent used a pipeline or simplified folder name.
    const workspaceRoots = [
      ...(params.leadWorktreePath ? [resolve(params.leadWorktreePath)] : []),
      resolve(params.repoPath),
    ];
    const discoveredAlternateDir = await discoverNewestMockupDirectory(
      workspaceRoots,
      params.fallbackFeatureSlugs ?? [],
    );
    if (discoveredAlternateDir) {
      const targetCanonicalDir = worktreeWorkingDir ?? repoWorkingDir;
      await copyWorkingMockupFilesExcludingVersions(discoveredAlternateDir, targetCanonicalDir);
      authoritativeWorkingDir = targetCanonicalDir;
    }
  }

  if (!authoritativeWorkingDir) {
    throw new Error(
      `Missing mockup entry point '${relativeWorkingDir}/index.html'. Write your HTML/CSS/JS mockup to '${relativeWorkingDir}/index.html' before calling slp_submit_mockup.`,
    );
  }

  // Sync the active working directory between the Lead's worktree and repoPath so both hold the latest files and assets.
  if (authoritativeWorkingDir !== repoWorkingDir) {
    await copyWorkingMockupFilesExcludingVersions(authoritativeWorkingDir, repoWorkingDir);
  }
  if (worktreeWorkingDir && authoritativeWorkingDir !== worktreeWorkingDir) {
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
  const worktreeVersionDir = params.leadWorktreePath
    ? resolve(params.leadWorktreePath, relativeVersionDir)
    : null;

  const repoVersionExists = await fileExistsOnDisk(join(repoVersionDir, "index.html"));
  const worktreeVersionExists = worktreeVersionDir
    ? await fileExistsOnDisk(join(worktreeVersionDir, "index.html"))
    : false;
  if (!repoVersionExists && !worktreeVersionExists) {
    return;
  }

  const sourceVersionDir = repoVersionExists ? repoVersionDir : worktreeVersionDir!;
  // Ensure the working directory in both repoPath and the Lead's worktree matches the chosen version snapshot.
  const repoWorkingDir = resolve(params.repoPath, relativeWorkingDir);
  await copyWorkingMockupFilesExcludingVersions(sourceVersionDir, repoWorkingDir);

  if (params.leadWorktreePath && resolve(params.leadWorktreePath) !== resolve(params.repoPath)) {
    const worktreeWorkingDir = resolve(params.leadWorktreePath, relativeWorkingDir);
    await copyWorkingMockupFilesExcludingVersions(sourceVersionDir, worktreeWorkingDir);
  }
}
