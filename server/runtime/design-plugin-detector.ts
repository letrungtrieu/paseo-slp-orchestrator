// Detects whether the standalone `paseo-design` plugin is installed/enabled and syncs `.design/` state with the SLP Kanban board.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  DESIGN_ROOT,
  type BoardTicket,
  type MockupElementComment,
} from "../../shared/board";
import type { BoardStore } from "../store/board-store";

export const PASEO_DESIGN_PLUGIN_ID = "paseo-design";

const DESIGN_MANIFEST_RELATIVE_PATH = `${DESIGN_ROOT}/designs.json`;

interface PaseoDaemonPluginConfigEntry {
  source?: string;
  path?: string;
  enabled?: boolean;
}

interface PaseoDaemonConfigFile {
  plugins?: Record<string, PaseoDaemonPluginConfigEntry>;
}

interface DesignStudioManifestEntry {
  file: string;
  title: string;
  summary?: string;
  status?: "draft" | "approved";
  approvedCommit?: string | null;
  approvedAt?: string | null;
  feedback?: string | null;
  elementComments?: MockupElementComment[];
  updatedAt?: string;
}

interface DesignStudioManifestFile {
  version: 1;
  entries: Record<string, DesignStudioManifestEntry>;
}

// Allows deterministic unit testing of both the design-enabled and design-disabled SLP flows.
let designPluginInstalledTestOverride: boolean | null = null;

export function setDesignPluginInstalledOverrideForTests(overrideValue: boolean | null): void {
  designPluginInstalledTestOverride = overrideValue;
}

// Resolves the active Paseo daemon config.json path, honoring PASEO_HOME when running in a custom daemon home.
function resolvePaseoDaemonConfigPath(): string {
  const customPaseoHome = process.env.PASEO_HOME?.trim();
  const baseHomeDirectory = customPaseoHome || resolve(homedir(), ".paseo");
  return resolve(baseHomeDirectory, "config.json");
}

// Checks whether `paseo-design` is installed and enabled in Paseo's config.json or `.design/` already exists in the repo.
export function isPaseoDesignPluginInstalled(repoPath?: string): boolean {
  if (designPluginInstalledTestOverride !== null) {
    return designPluginInstalledTestOverride;
  }

  // If the repository already contains a `.design/` directory, activate the `.design` workflow for it.
  if (repoPath?.trim()) {
    const repositoryDesignDirectory = resolve(repoPath.trim(), DESIGN_ROOT);
    if (existsSync(repositoryDesignDirectory)) {
      return true;
    }
  }

  // Inspect Paseo's daemon configuration to see whether the user installed `paseo-design`.
  const daemonConfigPath = resolvePaseoDaemonConfigPath();
  if (!existsSync(daemonConfigPath)) {
    return false;
  }
  try {
    const rawConfigJson = readFileSync(daemonConfigPath, "utf8");
    const parsedDaemonConfig = JSON.parse(rawConfigJson) as PaseoDaemonConfigFile;
    const designPluginConfig = parsedDaemonConfig.plugins?.[PASEO_DESIGN_PLUGIN_ID];
    if (!designPluginConfig) {
      return false;
    }
    return designPluginConfig.enabled !== false;
  } catch {
    return false;
  }
}

// Reads `.design/designs.json` when present so designs authored in `paseo-design` can be linked to SLP Kanban tickets.
function readDesignStudioManifest(repoPath: string): DesignStudioManifestFile | null {
  const manifestAbsolutePath = resolve(repoPath, DESIGN_MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestAbsolutePath)) {
    return null;
  }
  try {
    const rawManifestText = readFileSync(manifestAbsolutePath, "utf8");
    const parsedManifest = JSON.parse(rawManifestText) as Partial<DesignStudioManifestFile>;
    if (!parsedManifest || typeof parsedManifest.entries !== "object" || !parsedManifest.entries) {
      return null;
    }
    return {
      version: 1,
      entries: parsedManifest.entries as Record<string, DesignStudioManifestEntry>,
    };
  } catch {
    return null;
  }
}

// Syncs `.design/designs.json` entries into the project's Kanban board so designs created in `paseo-design` appear as MOCKUP/DESIGN cards.
export function syncDesignStudioManifestToBoard(board: BoardStore, repoPath: string): void {
  if (!repoPath.trim()) return;
  const designManifest = readDesignStudioManifest(repoPath);
  if (!designManifest) return;

  const existingTickets = board.listByRepo(repoPath);
  for (const manifestEntry of Object.values(designManifest.entries)) {
    if (!manifestEntry?.file || !manifestEntry.file.startsWith(`${DESIGN_ROOT}/`)) {
      continue;
    }
    const matchingTicket = existingTickets.find(
      (candidateTicket) => candidateTicket.mockup?.file === manifestEntry.file,
    );

    // Create a Kanban ticket when a new `.design/<feature>.html` file was registered in `paseo-design`.
    if (!matchingTicket) {
      const createdTicket = board.saveMockup({
        repoPath,
        title: manifestEntry.title || manifestEntry.file,
        file: manifestEntry.file,
        summary: manifestEntry.summary || "Thiết kế HTML/CSS/JS từ Paseo Design Studio (.design)",
        authorAgentId: PASEO_DESIGN_PLUGIN_ID,
      });
      if (
        (manifestEntry.feedback && manifestEntry.feedback.trim().length > 0) ||
        (manifestEntry.elementComments && manifestEntry.elementComments.length > 0)
      ) {
        board.recordMockupFeedback({
          ticketIdOrKey: createdTicket.id,
          repoPath,
          feedback: manifestEntry.feedback ?? "",
          elementComments: manifestEntry.elementComments ?? [],
        });
      }
      if (manifestEntry.status === "approved" && manifestEntry.approvedCommit) {
        board.approveMockup({
          ticketIdOrKey: createdTicket.id,
          repoPath,
          approvedCommit: manifestEntry.approvedCommit,
        });
      }
      continue;
    }

    // Propagate approval from `paseo-design` to the SLP Kanban ticket when the human approved the design in Design Studio.
    if (
      manifestEntry.status === "approved" &&
      manifestEntry.approvedCommit &&
      (matchingTicket.mockup?.status !== "approved" ||
        matchingTicket.mockup.approvedCommit !== manifestEntry.approvedCommit)
    ) {
      board.approveMockup({
        ticketIdOrKey: matchingTicket.id,
        repoPath,
        approvedCommit: manifestEntry.approvedCommit,
      });
    }
  }
}

// Mirrors updates on a `.design/*.html` Kanban ticket back to `.design/designs.json` so `paseo-design` stays in sync.
export function mirrorBoardMockupToDesignStudioManifest(
  repoPath: string,
  ticket: BoardTicket,
): void {
  const mockupState = ticket.mockup;
  if (!repoPath.trim() || !mockupState || !mockupState.file.startsWith(`${DESIGN_ROOT}/`)) {
    return;
  }
  const manifestAbsolutePath = resolve(repoPath, DESIGN_MANIFEST_RELATIVE_PATH);
  const existingManifest = readDesignStudioManifest(repoPath) ?? {
    version: 1 as const,
    entries: {},
  };

  existingManifest.entries[mockupState.file] = {
    file: mockupState.file,
    title: ticket.title,
    summary: mockupState.summary,
    status: mockupState.status,
    approvedCommit: mockupState.approvedCommit,
    approvedAt: mockupState.approvedAt,
    feedback: mockupState.feedback,
    elementComments: mockupState.elementComments,
    updatedAt: mockupState.updatedAt,
  };

  try {
    mkdirSync(dirname(manifestAbsolutePath), { recursive: true });
    writeFileSync(manifestAbsolutePath, `${JSON.stringify(existingManifest, null, 2)}\n`, "utf8");
  } catch {
    // Ignore write failures when the repository is on a read-only mount.
  }
}
