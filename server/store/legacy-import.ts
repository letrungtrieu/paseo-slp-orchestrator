// Read the previous file layout once; existing worktrees and JSON backups are never modified during migration.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CommLogEntrySchema, StateFileSchema } from "../../shared/state";
import { transaction } from "./database";
import { writeRun } from "./run-repository";

function isPlainObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function readLegacyText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (readError) {
    // Archived worktrees may already be gone; other failures must not silently discard their content.
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw readError;
  }
}

function legacyMasterSpecPath(sourceState: unknown, runId: string): string | null {
  if (!isPlainObject(sourceState) || !isPlainObject(sourceState.runs)) return null;
  const sourceRun = sourceState.runs[runId];
  if (!isPlainObject(sourceRun)) return null;
  return typeof sourceRun.masterSpecPath === "string" ? sourceRun.masterSpecPath : null;
}

export function importLegacyState(database: DatabaseSync, stateFilePath: string): void {
  const migrationName = "legacy-json-and-worktree-documents";
  if (database.prepare("SELECT name FROM migrations WHERE name = ?").get(migrationName)) return;
  const legacyText = readLegacyText(stateFilePath);
  // Validate before the transaction so corrupt history cannot be replaced with an empty database.
  const sourceState: unknown = legacyText !== null ? JSON.parse(legacyText) : null;
  const legacyState = legacyText !== null ? StateFileSchema.parse(sourceState) : null;
  transaction(database, () => {
    for (const run of Object.values(legacyState?.runs ?? {})) {
      // A retried migration never overwrites newer SQLite decisions for an already imported run.
      if (database.prepare("SELECT id FROM runs WHERE id = ?").get(run.id)) continue;
      const legacySpecPath = legacyMasterSpecPath(sourceState, run.id);
      if (!run.masterSpec && legacySpecPath) {
        run.masterSpec = readLegacyText(isAbsolute(legacySpecPath) ? legacySpecPath : join(run.devCwd, legacySpecPath));
      }
      for (const task of Object.values(run.tasks)) {
        const legacyReport = task.workspace ? readLegacyText(join(task.workspace.cwd, ".slp", "ACCEPTANCE_DOC.md")) : null;
        // Preserve historical prose verbatim, while new submissions use the structured report schema.
        if (legacyReport?.trim() && !task.acceptanceReport) {
          task.acceptanceReport = { report: legacyReport, submittedBy: "legacy-import", submittedAt: task.updatedAt };
        }
      }
      writeRun(database, run);
      const legacyLog = readLegacyText(join(run.repoPath, ".slp", "comm-log.jsonl"));
      for (const logLine of legacyLog?.split("\n") ?? []) {
        // Old logs can end with a truncated line after a crash; valid entries still migrate.
        let logCandidate: unknown;
        try { logCandidate = JSON.parse(logLine); } catch { continue; }
        const parsedEntry = CommLogEntrySchema.safeParse(logCandidate);
        if (parsedEntry.success && parsedEntry.data.runId === run.id) {
          database.prepare("INSERT INTO comm_logs(run_id, ts, payload) VALUES (?, ?, ?)")
            .run(run.id, parsedEntry.data.ts, JSON.stringify(parsedEntry.data));
        }
      }
    }
    // The marker is committed with all imported rows, so a partial import can safely retry.
    database.prepare("INSERT INTO migrations(name, applied_at) VALUES (?, ?)").run(migrationName, new Date().toISOString());
  });
}
