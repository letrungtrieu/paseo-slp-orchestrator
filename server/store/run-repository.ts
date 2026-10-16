// Translate relational SQLite rows into the pipeline's run aggregate without exposing SQL to agents.
import type { DatabaseSync } from "node:sqlite";
import { RunSchema, type Run } from "../../shared/state";

export function readRuns(database: DatabaseSync): Run[] {
  return database.prepare("SELECT id, payload FROM runs ORDER BY rowid").all().map((runRow) => {
    const run = RunSchema.parse(JSON.parse(String(runRow.payload)));
    // Reports are joined at load so callers still receive one consistent task object.
    const taskRows = database.prepare(`
      SELECT tasks.task_id, tasks.payload, task_reports.payload AS report_payload
      FROM tasks LEFT JOIN task_reports USING (run_id, task_id) WHERE tasks.run_id = ?
      ORDER BY tasks.rowid
    `).all(String(runRow.id));
    for (const taskRow of taskRows) {
      run.tasks[String(taskRow.task_id)] = {
        ...JSON.parse(String(taskRow.payload)),
        acceptanceReport: taskRow.report_payload ? JSON.parse(String(taskRow.report_payload)) : null,
      };
    }
    // Validate nested rows too; corrupt persisted state must fail rather than disappear silently.
    return RunSchema.parse(run);
  });
}

export function writeRun(database: DatabaseSync, run: Run): void {
  const { tasks, ...runMetadata } = run;
  database.prepare(`
    INSERT INTO runs(id, status, updated_at, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload
  `).run(run.id, run.status, run.updatedAt, JSON.stringify(runMetadata));
  // Removing a task also removes its report through the foreign key, keeping both views aligned.
  for (const savedTask of database.prepare("SELECT task_id FROM tasks WHERE run_id = ?").all(run.id)) {
    if (!Object.hasOwn(tasks, String(savedTask.task_id))) {
      database.prepare("DELETE FROM tasks WHERE run_id = ? AND task_id = ?").run(run.id, String(savedTask.task_id));
    }
  }
  for (const task of Object.values(tasks)) {
    const { acceptanceReport, ...taskMetadata } = task;
    // Unchanged siblings do not need rewritten pages when only one task advances.
    database.prepare(`
      INSERT INTO tasks(run_id, task_id, phase, updated_at, payload) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, task_id) DO UPDATE SET
        phase=excluded.phase, updated_at=excluded.updated_at, payload=excluded.payload
      WHERE tasks.payload != excluded.payload
    `).run(run.id, task.id, task.phase, task.updatedAt, JSON.stringify(taskMetadata));
    if (acceptanceReport) {
      // The report and ready-for-merge transition are committed in the caller's same transaction.
      database.prepare(`
        INSERT INTO task_reports(run_id, task_id, submitted_at, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, task_id) DO UPDATE SET submitted_at=excluded.submitted_at, payload=excluded.payload
        WHERE task_reports.payload != excluded.payload
      `).run(run.id, task.id, acceptanceReport.submittedAt, JSON.stringify(acceptanceReport));
    } else database.prepare("DELETE FROM task_reports WHERE run_id = ? AND task_id = ?").run(run.id, task.id);
  }
}
