// SQLite reads and writes for Kanban ticket rows, kept apart from the Spec, mockup and Brief lifecycle rules.
import type { DatabaseSync } from "node:sqlite";
import type { BoardTicket } from "../../shared/board";
import { readTicketFromCardPayload, writeTicketRows } from "./board-ticket-rows";

// Row-level ticket access shared by the board's workflow operations; lifecycle rules live in BoardStore.
export class BoardTicketRepository {
  constructor(protected readonly resolveDatabase: () => DatabaseSync) {}

  // The card and its mockup, Spec and Brief rows are written together so a ticket never persists half of its dependencies.
  protected persistTicket(database: DatabaseSync, ticket: BoardTicket): void {
    writeTicketRows(database, ticket);
  }

  // Lists all Kanban tickets belonging to a repository ordered by most recent activity first.
  listByRepo(repoPath: string): BoardTicket[] {
    const ticketRows = this.resolveDatabase()
      .prepare("SELECT payload FROM board_tickets WHERE repo_path = ? ORDER BY updated_at DESC")
      .all(repoPath);
    return ticketRows.map((ticketRow) => readTicketFromCardPayload(this.resolveDatabase(), ticketRow.payload));
  }

  // Lists all Kanban tickets currently associated with a specific active run.
  listByRun(runId: string): BoardTicket[] {
    const ticketRows = this.resolveDatabase()
      .prepare("SELECT payload FROM board_tickets WHERE active_run_id = ? ORDER BY updated_at DESC")
      .all(runId);
    return ticketRows.map((ticketRow) => readTicketFromCardPayload(this.resolveDatabase(), ticketRow.payload));
  }

  // Resolves a ticket by its internal UUID or its human-readable Jira-style key (such as SLP-1).
  find(ticketIdOrKey: string, repoPath?: string): BoardTicket | null {
    const trimmedLookup = ticketIdOrKey.trim();
    if (!trimmedLookup) return null;
    const database = this.resolveDatabase();
    // Match exact UUID first, then fall back to human-friendly ticketKey (e.g. SLP-1) within the project.
    const byIdRow = database
      .prepare("SELECT payload FROM board_tickets WHERE ticket_id = ?")
      .get(trimmedLookup);
    if (byIdRow) return readTicketFromCardPayload(database, byIdRow.payload);
    // Scope key lookup to the repository when known so SLP-1 in project A never collides with SLP-1 in project B.
    const byKeyRow = repoPath
      ? database
          .prepare("SELECT payload FROM board_tickets WHERE repo_path = ? AND UPPER(ticket_key) = UPPER(?)")
          .get(repoPath, trimmedLookup)
      : database
          .prepare("SELECT payload FROM board_tickets WHERE UPPER(ticket_key) = UPPER(?) ORDER BY updated_at DESC LIMIT 1")
          .get(trimmedLookup);
    return byKeyRow ? readTicketFromCardPayload(database, byKeyRow.payload) : null;
  }

  // Finds the ticket bound to a specific pipeline so stage approvals and QA scorecards update the right card.
  findByPipeline(pipelineId: string): BoardTicket | null {
    const ticketRow = this.resolveDatabase()
      .prepare("SELECT payload FROM board_tickets WHERE active_pipeline_id = ? LIMIT 1")
      .get(pipelineId);
    return ticketRow ? readTicketFromCardPayload(this.resolveDatabase(), ticketRow.payload) : null;
  }

  // Throws a descriptive error when an agent or RPC caller references a non-existent ticket id or key.
  requireTicket(ticketIdOrKey: string, repoPath?: string): BoardTicket {
    const foundTicket = this.find(ticketIdOrKey, repoPath);
    if (!foundTicket) throw new Error(`Unknown Kanban ticket '${ticketIdOrKey}'.`);
    return foundTicket;
  }

  protected allocateTicketKey(database: DatabaseSync, repoPath: string): string {
    // Sequential per-repository keys (SLP-1, SLP-2, ...) give humans and agents a short reference like Jira.
    const countRow = database
      .prepare("SELECT COUNT(*) AS count FROM board_tickets WHERE repo_path = ?")
      .get(repoPath) as { count?: number } | undefined;
    const nextSequenceNumber = Number(countRow?.count ?? 0) + 1;
    return `SLP-${nextSequenceNumber}`;
  }
}
