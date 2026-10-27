// Persistence and revision/diff management for project-scoped Kanban tickets (Spec -> Brief -> Score -> Rework).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BoardTicketSchema,
  briefItemsFromPipelineBrief,
  type BoardColumn,
  type BoardTicket,
  type BriefItemInput,
  type BriefItemStatus,
} from "../../shared/board";
import type { PipelineBrief, ScorecardEntry } from "../../shared/pipeline";
import {
  applyBriefItemProgressUpdate,
  applyReworkToTicket,
  applyScorecardToTicket,
  mergeBriefItemsForRevision,
} from "./board-item-scoring";
import { transaction } from "./database";
import { computeUnifiedTextDiff, serializeBriefForDiff } from "./diff";

export interface SaveSpecInput {
  repoPath: string;
  ticketIdOrKey?: string;
  title?: string;
  acceptanceCriteria?: string;
  specContent: string;
  author: "human" | "supervisor";
  summary?: string;
  activeRunId?: string | null;
  activePipelineId?: string | null;
  leadAgentId?: string | null;
}

export interface SaveBriefInput {
  ticketId: string;
  authorAgentId: string;
  reason: string;
  approach: string;
  items: readonly BriefItemInput[];
  activePipelineId?: string | null;
  leadAgentId?: string | null;
}

// SQLite-backed store managing project-scoped Spec and Brief tickets across multiple SLP runs.
export class BoardStore {
  constructor(private readonly resolveDatabase: () => DatabaseSync) {}

  private persistTicket(database: DatabaseSync, ticket: BoardTicket): void {
    // Store indexed columns alongside the JSON payload so project and run lookups avoid full-table JSON scans.
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
        JSON.stringify(ticket),
      );
  }

  // Lists all Kanban tickets belonging to a repository ordered by most recent activity first.
  listByRepo(repoPath: string): BoardTicket[] {
    const ticketRows = this.resolveDatabase()
      .prepare("SELECT payload FROM board_tickets WHERE repo_path = ? ORDER BY updated_at DESC")
      .all(repoPath);
    return ticketRows.map((ticketRow) => BoardTicketSchema.parse(JSON.parse(String(ticketRow.payload))));
  }

  // Lists all Kanban tickets currently associated with a specific active run.
  listByRun(runId: string): BoardTicket[] {
    const ticketRows = this.resolveDatabase()
      .prepare("SELECT payload FROM board_tickets WHERE active_run_id = ? ORDER BY updated_at DESC")
      .all(runId);
    return ticketRows.map((ticketRow) => BoardTicketSchema.parse(JSON.parse(String(ticketRow.payload))));
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
    if (byIdRow) return BoardTicketSchema.parse(JSON.parse(String(byIdRow.payload)));
    // Scope key lookup to the repository when known so SLP-1 in project A never collides with SLP-1 in project B.
    const byKeyRow = repoPath
      ? database
          .prepare("SELECT payload FROM board_tickets WHERE repo_path = ? AND UPPER(ticket_key) = UPPER(?)")
          .get(repoPath, trimmedLookup)
      : database
          .prepare("SELECT payload FROM board_tickets WHERE UPPER(ticket_key) = UPPER(?) ORDER BY updated_at DESC LIMIT 1")
          .get(trimmedLookup);
    return byKeyRow ? BoardTicketSchema.parse(JSON.parse(String(byKeyRow.payload))) : null;
  }

  // Finds the ticket bound to a specific pipeline so stage approvals and QA scorecards update the right card.
  findByPipeline(pipelineId: string): BoardTicket | null {
    const ticketRow = this.resolveDatabase()
      .prepare("SELECT payload FROM board_tickets WHERE active_pipeline_id = ? LIMIT 1")
      .get(pipelineId);
    return ticketRow ? BoardTicketSchema.parse(JSON.parse(String(ticketRow.payload))) : null;
  }

  // Throws a descriptive error when an agent or RPC caller references a non-existent ticket id or key.
  requireTicket(ticketIdOrKey: string, repoPath?: string): BoardTicket {
    const foundTicket = this.find(ticketIdOrKey, repoPath);
    if (!foundTicket) throw new Error(`Unknown Kanban ticket '${ticketIdOrKey}'.`);
    return foundTicket;
  }

  private allocateTicketKey(database: DatabaseSync, repoPath: string): string {
    // Sequential per-repository keys (SLP-1, SLP-2, ...) give humans and agents a short reference like Jira.
    const countRow = database
      .prepare("SELECT COUNT(*) AS count FROM board_tickets WHERE repo_path = ?")
      .get(repoPath) as { count?: number } | undefined;
    const nextSequenceNumber = Number(countRow?.count ?? 0) + 1;
    return `SLP-${nextSequenceNumber}`;
  }

  // Creates or updates the Spec document on a ticket, computing a Git-style unified diff against the previous revision.
  saveSpec(input: SaveSpecInput): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const nowIso = new Date().toISOString();
      // Reuse an existing ticket in the same repository when matched by explicit key or case-insensitive feature title.
      const existingTicket =
        (input.ticketIdOrKey ? this.find(input.ticketIdOrKey, input.repoPath) : null) ??
        (input.title
          ? this.listByRepo(input.repoPath).find(
              (candidateTicket) => candidateTicket.title.toLowerCase() === input.title!.trim().toLowerCase(),
            ) ?? null
          : null);

      const previousSpecRevision = existingTicket?.specRevisions.at(-1) ?? null;
      const nextSpecRevisionNumber = (existingTicket?.currentSpecRev ?? 0) + 1;
      // Avoid creating a redundant revision if the Spec text is identical to the latest stored revision.
      if (existingTicket && previousSpecRevision && previousSpecRevision.content.trim() === input.specContent.trim()) {
        const updatedMetadataTicket: BoardTicket = {
          ...existingTicket,
          title: input.title?.trim() || existingTicket.title,
          acceptanceCriteria: input.acceptanceCriteria?.trim() ?? existingTicket.acceptanceCriteria,
          activeRunId: input.activeRunId !== undefined ? input.activeRunId : existingTicket.activeRunId,
          activePipelineId: input.activePipelineId !== undefined ? input.activePipelineId : existingTicket.activePipelineId,
          leadAgentId: input.leadAgentId !== undefined ? input.leadAgentId : existingTicket.leadAgentId,
          updatedAt: nowIso,
        };
        this.persistTicket(database, updatedMetadataTicket);
        return updatedMetadataTicket;
      }

      // Compute a Git-style unified diff so the Supervisor and Lead can update only affected Brief bullets.
      const unifiedSpecDiff = computeUnifiedTextDiff(
        previousSpecRevision?.content ?? "",
        input.specContent,
        previousSpecRevision ? `spec-v${previousSpecRevision.rev}` : "empty",
        `spec-v${nextSpecRevisionNumber}`,
      );
      const createdSpecRevision = {
        rev: nextSpecRevisionNumber,
        author: input.author,
        summary: input.summary?.trim() || (nextSpecRevisionNumber === 1 ? "Initial specification" : `Updated specification to v${nextSpecRevisionNumber}`),
        content: input.specContent.trim(),
        diff: unifiedSpecDiff,
        createdAt: nowIso,
      };

      // Preserve existing Brief history when updating an existing ticket, or initialize a clean SPEC card for new features.
      const updatedTicket: BoardTicket = existingTicket
        ? {
            ...existingTicket,
            title: input.title?.trim() || existingTicket.title,
            acceptanceCriteria: input.acceptanceCriteria?.trim() || existingTicket.acceptanceCriteria,
            currentSpecRev: nextSpecRevisionNumber,
            specRevisions: [...existingTicket.specRevisions, createdSpecRevision],
            activeRunId: input.activeRunId !== undefined ? input.activeRunId : existingTicket.activeRunId,
            activePipelineId: input.activePipelineId !== undefined ? input.activePipelineId : existingTicket.activePipelineId,
            leadAgentId: input.leadAgentId !== undefined ? input.leadAgentId : existingTicket.leadAgentId,
            updatedAt: nowIso,
          }
        : {
            id: randomUUID(),
            ticketKey: this.allocateTicketKey(database, input.repoPath),
            repoPath: input.repoPath,
            title: input.title?.trim() || "Feature Ticket",
            acceptanceCriteria: input.acceptanceCriteria?.trim() || "",
            column: "spec",
            currentSpecRev: 1,
            currentBriefRev: 0,
            lastSyncedSpecRev: 0,
            specRevisions: [createdSpecRevision],
            briefRevisions: [],
            approach: "",
            items: [],
            activeRunId: input.activeRunId ?? null,
            activePipelineId: input.activePipelineId ?? null,
            leadAgentId: input.leadAgentId ?? null,
            activeAgents: [],
            createdAt: nowIso,
            updatedAt: nowIso,
          };

      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Records a new Brief revision when the Lead plans or pivots technical approaches, preserving scores on unchanged bullets.
  saveBrief(input: SaveBriefInput): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const existingTicket = this.requireTicket(input.ticketId);
      const nowIso = new Date().toISOString();
      const nextBriefRev = existingTicket.currentBriefRev + 1;
      const targetSpecRev = Math.max(1, existingTicket.currentSpecRev);

      // Merge incoming bullets with prior state so unchanged bullets keep their execution/QA scores while changed ones reset.
      const mergedBriefItems = mergeBriefItemsForRevision(
        existingTicket.items,
        input.items,
        targetSpecRev,
        nextBriefRev,
      );

      // Compute a Git-style unified diff between the previous Brief snapshot and the newly merged Brief bullets.
      const previousBriefMarkdown = existingTicket.currentBriefRev > 0
        ? serializeBriefForDiff(existingTicket.approach, existingTicket.items)
        : "";
      const nextBriefMarkdown = serializeBriefForDiff(input.approach, mergedBriefItems);
      const unifiedBriefDiff = computeUnifiedTextDiff(
        previousBriefMarkdown,
        nextBriefMarkdown,
        existingTicket.currentBriefRev > 0 ? `brief-v${existingTicket.currentBriefRev}` : "empty",
        `brief-v${nextBriefRev}`,
      );

      const createdBriefRevision = {
        rev: nextBriefRev,
        specRev: targetSpecRev,
        authorAgentId: input.authorAgentId,
        reason: input.reason.trim() || (nextBriefRev === 1 ? "Initial technical brief" : "Updated brief items"),
        approach: input.approach.trim(),
        items: mergedBriefItems,
        diff: unifiedBriefDiff,
        createdAt: nowIso,
      };

      // Move a ticket from SPEC (or reopened DONE) into BRIEF once its actionable bullet items are recorded.
      const nextColumn: BoardColumn = existingTicket.column === "spec" || existingTicket.column === "done"
        ? "brief"
        : existingTicket.column;

      const updatedTicket: BoardTicket = {
        ...existingTicket,
        column: nextColumn,
        currentBriefRev: nextBriefRev,
        lastSyncedSpecRev: targetSpecRev,
        briefRevisions: [...existingTicket.briefRevisions, createdBriefRevision],
        approach: input.approach.trim(),
        items: mergedBriefItems,
        activePipelineId: input.activePipelineId !== undefined ? input.activePipelineId : existingTicket.activePipelineId,
        leadAgentId: input.leadAgentId !== undefined ? input.leadAgentId : existingTicket.leadAgentId,
        updatedAt: nowIso,
      };

      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Synchronizes a PipelineBrief authored via slp_define_pipeline or slp_approve_stage into the project Kanban board.
  syncPipelineBriefToTicket(params: {
    repoPath: string;
    runId: string;
    pipelineId: string;
    pipelineName: string;
    leadAgentId: string;
    brief: PipelineBrief;
    reason: string;
    fallbackCriteria?: string;
    fallbackSpec?: string | null;
  }): BoardTicket {
    const existingByPipeline = this.findByPipeline(params.pipelineId);
    const repoTickets = this.listByRepo(params.repoPath);
    const existingByTitle = repoTickets.find(
      (candidateTicket) => candidateTicket.title.toLowerCase() === params.pipelineName.trim().toLowerCase(),
    );
    // Match the ticket already delegated to this Lead in the active run when the pipeline name differs from the feature title.
    const existingByLeadInRun = repoTickets.find(
      (candidateTicket) =>
        candidateTicket.activeRunId === params.runId &&
        candidateTicket.leadAgentId === params.leadAgentId,
    );
    const existingUnboundInRun = repoTickets.find(
      (candidateTicket) =>
        candidateTicket.activeRunId === params.runId &&
        !candidateTicket.activePipelineId,
    );
    let targetTicket =
      existingByPipeline ?? existingByTitle ?? existingByLeadInRun ?? existingUnboundInRun ?? null;
    // Create a fallback Spec ticket if a pipeline was defined without prior delegation ticket creation.
    if (!targetTicket) {
      targetTicket = this.saveSpec({
        repoPath: params.repoPath,
        title: params.pipelineName,
        acceptanceCriteria: params.fallbackCriteria ?? "",
        specContent: params.fallbackSpec ?? params.fallbackCriteria ?? params.pipelineName,
        author: "supervisor",
        summary: "Synchronized from pipeline definition",
        activeRunId: params.runId,
        activePipelineId: params.pipelineId,
        leadAgentId: params.leadAgentId,
      });
    }
    const convertedItems = briefItemsFromPipelineBrief(
      params.brief,
      Math.max(1, targetTicket.currentSpecRev),
      targetTicket.currentBriefRev + 1,
    );
    return this.saveBrief({
      ticketId: targetTicket.id,
      authorAgentId: params.leadAgentId,
      reason: params.reason,
      approach: params.brief.approach,
      items: convertedItems.map(({ id, requirement, verification, scope }) => ({
        id,
        requirement,
        verification,
        scope,
      })),
      activePipelineId: params.pipelineId,
      leadAgentId: params.leadAgentId,
    });
  }

  // Updates the execution progress status and optional developer note of a single Brief bullet.
  updateItemProgress(params: {
    ticketIdOrKey: string;
    repoPath?: string;
    itemId: string;
    status: BriefItemStatus;
    note?: string;
  }): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const existingTicket = this.requireTicket(params.ticketIdOrKey, params.repoPath);
      const updatedTicket = applyBriefItemProgressUpdate(
        existingTicket,
        params.itemId,
        params.status,
        params.note,
      );
      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Grades Brief bullets from a QA scorecard and moves the ticket into SCORE or REWORK.
  scoreItems(params: {
    ticketIdOrKey: string;
    repoPath?: string;
    gradedBy: string;
    scorecard: readonly ScorecardEntry[];
  }): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const existingTicket = this.requireTicket(params.ticketIdOrKey, params.repoPath);
      const updatedTicket = applyScorecardToTicket(
        existingTicket,
        params.gradedBy,
        params.scorecard,
      );
      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Marks targeted or failing in-scope Brief bullets as needing rework and moves the ticket to REWORK.
  markRework(params: {
    ticketIdOrKey: string;
    repoPath?: string;
    feedback: string;
    itemIds?: readonly string[];
  }): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const existingTicket = this.requireTicket(params.ticketIdOrKey, params.repoPath);
      const updatedTicket = applyReworkToTicket(
        existingTicket,
        params.feedback,
        params.itemIds,
      );
      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Explicitly moves a ticket to a target Kanban column (for example moving to DONE on slp_approve_main).
  setColumn(ticketIdOrKey: string, column: BoardColumn, repoPath?: string): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const existingTicket = this.requireTicket(ticketIdOrKey, repoPath);
      const updatedTicket: BoardTicket = {
        ...existingTicket,
        column,
        updatedAt: new Date().toISOString(),
      };
      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }
}
