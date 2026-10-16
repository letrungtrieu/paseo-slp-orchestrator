// Keep SQLite setup and transaction ownership separate from the run's domain representation.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function transaction<Outcome>(database: DatabaseSync, operation: () => Outcome): Outcome {
  // Taking the write lock first makes a state change and its task/report rows one durable decision.
  database.exec("BEGIN IMMEDIATE");
  try {
    const operationOutcome = operation();
    database.exec("COMMIT");
    return operationOutcome;
  } catch (operationError) {
    database.exec("ROLLBACK");
    throw operationError;
  }
}

export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    // Agent authentication tokens live here, so the database is private to the daemon's OS user.
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const schemaVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (schemaVersion > 1) throw new Error(`Unsupported SLP database version: ${schemaVersion}`);
    if (schemaVersion === 0) transaction(database, () => {
      // Task rows remain independently queryable; the payload holds their nested domain fields.
      database.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE TABLE tasks (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL, phase TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (run_id, task_id)
        );
        CREATE INDEX tasks_by_phase ON tasks(run_id, phase);
        CREATE TABLE task_reports (
          run_id TEXT NOT NULL, task_id TEXT NOT NULL, submitted_at TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (run_id, task_id),
          FOREIGN KEY (run_id, task_id) REFERENCES tasks(run_id, task_id) ON DELETE CASCADE
        );
        CREATE TABLE comm_logs (
          log_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          ts TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX logs_by_run ON comm_logs(run_id, ts, log_id);
        CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    });
    return database;
  } catch (databaseError) {
    // Failed initialization must release the handle so the next reload can repair or retry it.
    database.close();
    throw databaseError;
  }
}
