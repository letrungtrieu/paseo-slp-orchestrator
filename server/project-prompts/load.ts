// Discover project-authored Markdown recursively; no runtime task or report data is written into this configuration folder.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ProjectPromptConfig, ProjectRole } from "../../shared/project-prompts";
import { defaultProjectPrompts, defaultPromptFiles } from "./defaults";
import { parseRoleMarkdown } from "./markdown";

// UI discovery and Start run can race; neither should observe a half-written default catalog.
const initializingDirectories = new Map<string, Promise<void>>();

async function markdownFiles(directory: string, rootDirectory = directory): Promise<string[]> {
  let directoryEntries;
  try { directoryEntries = await readdir(directory, { withFileTypes: true }); }
  catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw readError;
  }
  const discoveredFiles: string[] = [];
  for (const entry of directoryEntries.sort((first, second) => first.name.localeCompare(second.name))) {
    const entryPath = join(directory, entry.name);
    // Do not follow directory symlinks: recursive discovery must terminate and remain project-local.
    if (entry.isDirectory()) discoveredFiles.push(...await markdownFiles(entryPath, rootDirectory));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      // These two old generated artifacts are data migrated to SQLite, not role configuration.
      const relativePath = relative(rootDirectory, entryPath).replace(/\\/g, "/");
      if (!["MASTER_SPEC.md", "ACCEPTANCE_DOC.md"].includes(relativePath)) discoveredFiles.push(entryPath);
    }
  }
  return discoveredFiles;
}

async function initializeEmptyConfiguration(configurationDirectory: string): Promise<void> {
  if ((await markdownFiles(configurationDirectory)).length) return;
  for (const promptFile of defaultPromptFiles()) {
    const promptPath = join(configurationDirectory, promptFile.relativePath);
    await mkdir(dirname(promptPath), { recursive: true });
    try {
      // Exclusive creation also protects edits when two run initializations race.
      await writeFile(promptPath, promptFile.markdown, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
  }
}

export async function loadProjectPrompts(repoPath: string): Promise<ProjectPromptConfig> {
  const configurationDirectory = resolve(repoPath, ".slp");
  // A legacy .slp containing only logs needs the same first-time templates as a missing directory.
  let initialization = initializingDirectories.get(configurationDirectory);
  if (!initialization) {
    initialization = initializeEmptyConfiguration(configurationDirectory);
    initializingDirectories.set(configurationDirectory, initialization);
  }
  try { await initialization; }
  finally {
    if (initializingDirectories.get(configurationDirectory) === initialization) initializingDirectories.delete(configurationDirectory);
  }
  const defaults = defaultProjectPrompts();
  const configuration: ProjectPromptConfig = { ...defaults, peers: [] };
  const peerSourcePaths = new Map<string, string>();
  const rootSourcePaths = new Map<string, string>();
  for (const markdownPath of await markdownFiles(configurationDirectory)) {
    const sourcePath = relative(repoPath, markdownPath).replace(/\\/g, "/");
    const definition = parseRoleMarkdown(await readFile(markdownPath, "utf8"), sourcePath);
    const relativePath = relative(configurationDirectory, markdownPath).replace(/\\/g, "/").toUpperCase();
    const rootRole = relativePath === "SUPERVISOR.MD" ? "supervisor" : relativePath === "LEAD.MD" ? "lead" : null;
    if (rootRole) {
      // A misplaced role is usually a copied template; reject it instead of silently applying the wrong workflow.
      const allowedRoles = rootRole === "lead" ? ["lead", "master-lead"] : ["supervisor"];
      if (!allowedRoles.includes(definition.role)) throw new Error(`${sourcePath}: role must be '${rootRole}'`);
      if (rootSourcePaths.has(rootRole)) throw new Error(`${sourcePath}: duplicate ${rootRole} configuration`);
      rootSourcePaths.set(rootRole, sourcePath);
      configuration[rootRole] = definition;
    } else addPeer(configuration.peers, definition, peerSourcePaths);
  }
  return configuration;
}

function addPeer(peers: ProjectRole[], definition: ProjectRole, sourcePaths: Map<string, string>): void {
  const existingPath = sourcePaths.get(definition.role);
  // IDs, not filenames, are the lookup key, so duplicates cannot be resolved by discovery order.
  if (existingPath) throw new Error(`${definition.sourcePath}: duplicate role '${definition.role}' also defined in ${existingPath}`);
  if (["lead", "master-lead", "supervisor", "forked-lead"].includes(definition.role)) {
    throw new Error(`${definition.sourcePath}: '${definition.role}' is reserved for a root orchestration role`);
  }
  sourcePaths.set(definition.role, definition.sourcePath);
  peers.push(definition);
}
