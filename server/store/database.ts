// Keep SQLite setup and transaction ownership separate from the run's domain representation.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateBoardPayloadsToRelations } from "./board-relations-migration";

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

const LATEST_SCHEMA_VERSION = 4;

// Peer questions get a relational table of their own: every ask/answer is audited, and rewriting the
// whole Run payload for each exchange would make the synchronous write grow with the conversation.
const PEER_QUESTIONS_SCHEMA = `
  CREATE TABLE questions (
    question_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    pipeline_id TEXT,
    status TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    answered_at TEXT,
    answer_delivered_at TEXT,
    expired_at TEXT,
    expire_reason TEXT,
    reminder_count INTEGER NOT NULL DEFAULT 0,
    last_reminded_at TEXT
  );
  CREATE INDEX questions_by_recipient ON questions(run_id, to_agent_id, status);
  CREATE INDEX questions_by_asker ON questions(run_id, from_agent_id, status);
  CREATE INDEX questions_by_run ON questions(run_id, created_at);
  PRAGMA user_version = 2;
`;

// Project-scoped Kanban tickets live outside individual runs so Specs and Briefs persist across runs and reworks.
const BOARD_TICKETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_tickets (
    ticket_id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    ticket_key TEXT NOT NULL,
    column_name TEXT NOT NULL,
    active_run_id TEXT,
    active_pipeline_id TEXT,
    updated_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_tickets_by_repo ON board_tickets(repo_path, updated_at);
  CREATE INDEX IF NOT EXISTS board_tickets_by_run ON board_tickets(active_run_id);
  PRAGMA user_version = 3;
`;

// A ticket's dependencies are tables, not JSON: a ticket has at most one mockup, a Spec depends on that mockup
// (one to one), and every Brief revision depends on the Spec it was derived from (one Spec, many Briefs).
const BOARD_RELATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_mockups (
    ticket_id TEXT PRIMARY KEY REFERENCES board_tickets(ticket_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
    approved_commit TEXT,
    updated_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS board_specs (
    ticket_id TEXT PRIMARY KEY REFERENCES board_tickets(ticket_id) ON DELETE CASCADE,
    mockup_ticket_id TEXT UNIQUE REFERENCES board_mockups(ticket_id),
    -- Approved mockup commit this Spec was last written or reviewed against; null when it never matched one.
    reviewed_mockup_commit TEXT,
    updated_at TEXT NOT NULL,
    CHECK (mockup_ticket_id IS NULL OR mockup_ticket_id = ticket_id)
  );
  CREATE TABLE IF NOT EXISTS board_spec_revisions (
    ticket_id TEXT NOT NULL REFERENCES board_specs(ticket_id) ON DELETE CASCADE,
    rev INTEGER NOT NULL CHECK (rev >= 1),
    author TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    diff TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (ticket_id, rev)
  );
  CREATE TABLE IF NOT EXISTS board_brief_revisions (
    ticket_id TEXT NOT NULL REFERENCES board_specs(ticket_id) ON DELETE CASCADE,
    rev INTEGER NOT NULL CHECK (rev >= 1),
    spec_rev INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (ticket_id, rev)
  );
  PRAGMA user_version = 4;
`;

export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    // Agent authentication tokens live here, so the database is private to the daemon's OS user.
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const schemaVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (schemaVersion > LATEST_SCHEMA_VERSION) throw new Error(`Unsupported SLP database version: ${schemaVersion}`);
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
    // Runs after the v1 block on a fresh file, and alone on an existing v1 file: one forward-only step per version.
    if (schemaVersion < 2) transaction(database, () => database.exec(PEER_QUESTIONS_SCHEMA));
    // Upgrade existing v2 databases and fresh databases to v3 with the project-scoped board_tickets table.
    if (schemaVersion < 3) transaction(database, () => database.exec(BOARD_TICKETS_SCHEMA));
    // v4 splits each stored ticket payload into the mockup, Spec and Brief tables in the same transaction as their creation.
    if (schemaVersion < 4) {
      transaction(database, () => {
        database.exec(BOARD_RELATIONS_SCHEMA);
        migrateBoardPayloadsToRelations(database);
      });
    }
    return database;
  } catch (databaseError) {
    // Failed initialization must release the handle so the next reload can repair or retry it.
    database.close();
    throw databaseError;
  }
}
