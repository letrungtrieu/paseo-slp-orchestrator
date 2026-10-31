// Maps a Kanban ticket onto relational rows: mockup (1) -> Spec (1) -> Spec revisions and Brief revisions (N).
// The ticket stays one object for callers; SQLite itself knows which row depends on which.
import type { DatabaseSync } from "node:sqlite";
import { BoardTicketSchema, type BoardTicket } from "../../shared/board";

// These fields live in their own tables, so the card row must not carry a second copy that could drift.
// The two revision counters are derived from the revision rows instead of being stored.
const RELATIONAL_TICKET_FIELDS = new Set([
  "mockup",
  "specRevisions",
  "briefRevisions",
  "currentSpecRev",
  "currentBriefRev",
  "specMockupCommit",
]);

function cardFieldsOf(ticket: BoardTicket): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ticket).filter(([fieldName]) => !RELATIONAL_TICKET_FIELDS.has(fieldName)));
}

// Writes the card and everything that depends on it; callers wrap this in their own transaction.
export function writeTicketRows(database: DatabaseSync, ticket: BoardTicket): void {
  // The card row goes first because the mockup and Spec rows reference it.
  database
    .prepare(
      `INSERT INTO board_tickets (
        ticket_id, repo_path, ticket_key, column_name, active_run_id, active_pipeline_id, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        repo_path = excluded.repo_path,
        ticket_key = excluded.ticket_key,
        column_name = excluded.column_name,
        active_run_id = excluded.active_run_id,
        active_pipeline_id = excluded.active_pipeline_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload`,
    )
    .run(
      ticket.id,
      ticket.repoPath,
      ticket.ticketKey,
      ticket.column,
      ticket.activeRunId,
      ticket.activePipelineId,
      ticket.updatedAt,
      JSON.stringify(cardFieldsOf(ticket)),
    );

  if (ticket.mockup) {
    database
      .prepare(
        `INSERT INTO board_mockups (ticket_id, status, approved_commit, updated_at, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ticket_id) DO UPDATE SET
          status = excluded.status,
          approved_commit = excluded.approved_commit,
          updated_at = excluded.updated_at,
          payload = excluded.payload`,
      )
      .run(
        ticket.id,
        ticket.mockup.status,
        ticket.mockup.approvedCommit,
        ticket.mockup.updatedAt,
        JSON.stringify(ticket.mockup),
      );
  }

  // A mockup-only ticket has no Spec yet, and creating an empty Spec row would make "a Spec exists" lie.
  const ticketHasSpec = ticket.specRevisions.length > 0 || ticket.briefRevisions.length > 0;
  if (!ticketHasSpec) return;

  database
    .prepare(
      `INSERT INTO board_specs (ticket_id, mockup_ticket_id, reviewed_mockup_commit, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        mockup_ticket_id = excluded.mockup_ticket_id,
        reviewed_mockup_commit = excluded.reviewed_mockup_commit,
        updated_at = excluded.updated_at`,
    )
    .run(ticket.id, ticket.mockup ? ticket.id : null, ticket.specMockupCommit, ticket.updatedAt);

  // Revisions are immutable snapshots, so a second write of the same revision number must never overwrite history.
  const insertSpecRevision = database.prepare(
    `INSERT OR IGNORE INTO board_spec_revisions (ticket_id, rev, author, summary, content, diff, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const specRevision of ticket.specRevisions) {
    insertSpecRevision.run(
      ticket.id,
      specRevision.rev,
      specRevision.author,
      specRevision.summary,
      specRevision.content,
      specRevision.diff,
      specRevision.createdAt,
    );
  }
  const insertBriefRevision = database.prepare(
    `INSERT OR IGNORE INTO board_brief_revisions (ticket_id, rev, spec_rev, created_at, payload)
    VALUES (?, ?, ?, ?, ?)`,
  );
  for (const briefRevision of ticket.briefRevisions) {
    insertBriefRevision.run(
      ticket.id,
      briefRevision.rev,
      briefRevision.specRev,
      briefRevision.createdAt,
      JSON.stringify(briefRevision),
    );
  }
}

// Rejoins a stored card with its mockup, Spec and Brief rows into the ticket callers work with.
export function readTicketFromCardPayload(database: DatabaseSync, cardPayload: unknown): BoardTicket {
  const cardFields = JSON.parse(String(cardPayload)) as Record<string, unknown>;
  const ticketId = String(cardFields.id);

  const mockupRow = database.prepare("SELECT payload FROM board_mockups WHERE ticket_id = ?").get(ticketId);
  const specRow = database
    .prepare("SELECT reviewed_mockup_commit FROM board_specs WHERE ticket_id = ?")
    .get(ticketId);
  const specRevisions = database
    .prepare(
      `SELECT rev, author, summary, content, diff, created_at FROM board_spec_revisions
      WHERE ticket_id = ? ORDER BY rev`,
    )
    .all(ticketId)
    .map((specRevisionRow) => ({
      rev: Number(specRevisionRow.rev),
      author: specRevisionRow.author,
      summary: specRevisionRow.summary,
      content: specRevisionRow.content,
      diff: specRevisionRow.diff,
      createdAt: specRevisionRow.created_at,
    }));
  const briefRevisions = database
    .prepare("SELECT payload FROM board_brief_revisions WHERE ticket_id = ? ORDER BY rev")
    .all(ticketId)
    .map((briefRevisionRow) => JSON.parse(String(briefRevisionRow.payload)) as { rev: number });

  return BoardTicketSchema.parse({
    ...cardFields,
    mockup: mockupRow ? JSON.parse(String(mockupRow.payload)) : null,
    specMockupCommit: specRow?.reviewed_mockup_commit ?? null,
    specRevisions,
    briefRevisions,
    // Counters come from the rows so they cannot disagree with the revisions that exist.
    currentSpecRev: specRevisions.at(-1)?.rev ?? 0,
    currentBriefRev: briefRevisions.at(-1)?.rev ?? 0,
  });
}
