// Discover only the three root role files and .slp/peers Markdown; ignore arbitrary docs or other .slp subdirectories.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ProjectPromptConfig, ProjectRole } from "../../shared/project-prompts";
import { defaultProjectPrompts, defaultPromptFiles } from "./defaults";
import { parseRoleMarkdown } from "./markdown";

// UI discovery and Start run can race; neither should observe a half-written default catalog.
const initializingDirectories = new Map<string, Promise<void>>();

// Restrict root-level discovery to the root orchestration role files so unrelated .slp/*.md files are ignored.
const ROOT_ROLE_FILENAMES = new Set(["SUPERVISOR.MD", "LEAD.MD", "QA_LEAD.MD"]);
const QA_LEAD_FILENAME = "QA_LEAD.md";
// Root roles are engine contracts rather than optional peers, so their IDs can never be reused by a peer file.
const RESERVED_ROOT_ROLE_IDS = ["lead", "master-lead", "qa-lead", "supervisor"];

async function rootRoleMarkdownFiles(configurationDirectory: string): Promise<string[]> {
  let directoryEntries;
  try { directoryEntries = await readdir(configurationDirectory, { withFileTypes: true }); }
  catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw readError;
  }
  const discoveredRootRoleFiles: string[] = [];
  for (const directoryEntry of directoryEntries.sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name))) {
    // Ignore non-role files and non-peers directories (such as .slp/architecture) that do not contain role prompts.
    if (directoryEntry.isFile() && ROOT_ROLE_FILENAMES.has(directoryEntry.name.toUpperCase())) {
      discoveredRootRoleFiles.push(join(configurationDirectory, directoryEntry.name));
    }
  }
  return discoveredRootRoleFiles;
}

async function peerMarkdownFiles(peersDirectory: string): Promise<string[]> {
  let directoryEntries;
  try { directoryEntries = await readdir(peersDirectory, { withFileTypes: true }); }
  catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw readError;
  }
  const discoveredPeerFiles: string[] = [];
  for (const directoryEntry of directoryEntries.sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name))) {
    const entryPath = join(peersDirectory, directoryEntry.name);
    // Do not follow directory symlinks: recursive discovery inside .slp/peers must terminate and remain project-local.
    if (directoryEntry.isDirectory()) discoveredPeerFiles.push(...await peerMarkdownFiles(entryPath));
    else if (directoryEntry.isFile() && /\.md$/i.test(directoryEntry.name)) discoveredPeerFiles.push(entryPath);
  }
  return discoveredPeerFiles;
}

async function roleMarkdownFiles(configurationDirectory: string): Promise<string[]> {
  // Combine only the 3 root role files and .slp/peers Markdown so other .slp folders never trigger YAML errors.
  const rootFiles = await rootRoleMarkdownFiles(configurationDirectory);
  const peerFiles = await peerMarkdownFiles(join(configurationDirectory, "peers"));
  return [...rootFiles, ...peerFiles];
}

async function writeMissingDefaultPromptFile(configurationDirectory: string, relativePath: string, markdown: string): Promise<void> {
  const promptPath = join(configurationDirectory, relativePath);
  await mkdir(dirname(promptPath), { recursive: true });
  try {
    // Exclusive creation protects user edits and prevents race conditions when two initializations overlap.
    await writeFile(promptPath, markdown, { encoding: "utf8", flag: "wx" });
  } catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
  }
}

async function initializeEmptyConfiguration(configurationDirectory: string): Promise<void> {
  const discoveredRoleFiles = await roleMarkdownFiles(configurationDirectory);
  // An empty catalog receives every template; once a project has its own roles, the user owns which peers exist.
  if (discoveredRoleFiles.length === 0) {
    for (const promptFile of defaultPromptFiles()) {
      await writeMissingDefaultPromptFile(configurationDirectory, promptFile.relativePath, promptFile.markdown);
    }
    return;
  }
  // Every delegation spawns a QA Lead, so projects created before QA_LEAD.md existed still need its root file.
  const hasQaLeadFile = discoveredRoleFiles.some(
    (filePath) => relative(configurationDirectory, filePath).toUpperCase() === QA_LEAD_FILENAME.toUpperCase(),
  );
  const qaLeadTemplate = defaultPromptFiles().find((promptFile) => promptFile.relativePath === QA_LEAD_FILENAME);
  if (!hasQaLeadFile && qaLeadTemplate) {
    await writeMissingDefaultPromptFile(configurationDirectory, qaLeadTemplate.relativePath, qaLeadTemplate.markdown);
  }
}

export async function loadProjectPrompts(repoPath: string): Promise<ProjectPromptConfig> {
  const configurationDirectory = resolve(repoPath, ".slp");
  // A legacy .slp containing only logs or architecture docs needs the same first-time templates as a missing directory.
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
  for (const markdownPath of await roleMarkdownFiles(configurationDirectory)) {
    const sourcePath = relative(repoPath, markdownPath).replace(/\\/g, "/");
    const markdownText = await readFile(markdownPath, "utf8");
    // Every .slp Markdown file defines its own front-matter summary and role agent prompt directly.
    const definition = parseRoleMarkdown(markdownText, sourcePath);
    const relativePath = relative(configurationDirectory, markdownPath).replace(/\\/g, "/").toUpperCase();
    const rootRole =
      relativePath === "SUPERVISOR.MD"
        ? "supervisor"
        : relativePath === "LEAD.MD"
          ? "lead"
          : relativePath === "QA_LEAD.MD"
            ? "qaLead"
            : null;
    if (rootRole) {
      // A misplaced role is usually a copied template; reject it instead of silently applying the wrong workflow.
      const allowedRoles = rootRole === "lead" ? ["lead", "master-lead"] : rootRole === "qaLead" ? ["qa-lead"] : ["supervisor"];
      if (!allowedRoles.includes(definition.role)) throw new Error(`${sourcePath}: role must be '${allowedRoles[0]}'`);
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
  if (RESERVED_ROOT_ROLE_IDS.includes(definition.role)) {
    throw new Error(`${definition.sourcePath}: '${definition.role}' is reserved for a root orchestration role`);
  }
  sourcePaths.set(definition.role, definition.sourcePath);
  peers.push(definition);
}
