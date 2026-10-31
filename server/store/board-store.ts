// Persistence and revision/diff management for project-scoped Kanban tickets (Mockup -> Spec -> Brief -> Score -> Rework).
import { randomUUID } from "node:crypto";
import {
  briefItemsFromPipelineBrief,
  deriveFeatureMockupSlug,
  describeSpecWriteBlocker,
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
import {
  applyMockupApprovalToTicket,
  applyMockupFeedbackToTicket,
  applyMockupUpdateToTicket,
  createMockupTicket,
  type RecordMockupFeedbackParams,
  type SaveTicketMockupParams,
} from "./board-mockup";
import { BoardTicketRepository } from "./board-ticket-repository";
import { transaction } from "./database";
import { computeUnifiedTextDiff, serializeBriefForDiff } from "./diff";

// A Spec saved while its mockup is approved has now been checked against that exact commit; otherwise the old stamp stands.
function specCommitAfterSave(ticket: BoardTicket): string | null {
  return ticket.mockup?.status === "approved" ? ticket.mockup.approvedCommit : ticket.specMockupCommit;
}

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

export interface SaveMockupInput extends SaveTicketMockupParams {
  repoPath: string;
  ticketIdOrKey?: string;
  title?: string;
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
export class BoardStore extends BoardTicketRepository {
  // Creates or updates the Spec document on a ticket, computing a Git-style unified diff against the previous revision.
  saveSpec(input: SaveSpecInput): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const nowIso = new Date().toISOString();
      // Reuse an existing ticket in the same repository when matched by explicit key, pipeline, title, assigned Lead, or unbound run draft.
      const runTickets = input.activeRunId ? this.listByRun(input.activeRunId) : [];
      const existingTicket =
        (input.ticketIdOrKey ? this.find(input.ticketIdOrKey, input.repoPath) : null) ??
        (input.activePipelineId ? this.findByPipeline(input.activePipelineId) : null) ??
        (input.title
          ? this.listByRepo(input.repoPath).find(
              (candidateTicket) => candidateTicket.title.toLowerCase() === input.title!.trim().toLowerCase(),
            ) ?? null
          : null) ??
        (input.leadAgentId
          ? runTickets.find((candidateTicket) => candidateTicket.leadAgentId === input.leadAgentId) ?? null
          : null) ??
        runTickets.find(
          (candidateTicket) => !candidateTicket.leadAgentId || !candidateTicket.activePipelineId,
        ) ??
        null;

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
          // Saving unchanged text under an approved mockup is how a review confirms the Spec still matches it.
          specMockupCommit: specCommitAfterSave(existingTicket),
          updatedAt: nowIso,
        };
        this.persistTicket(database, updatedMetadataTicket);
        return updatedMetadataTicket;
      }

      // A draft mockup locks its Spec: the lock sits here so no caller (agent tool, UI or Run) can write around it.
      const specLockReason = existingTicket ? describeSpecWriteBlocker(existingTicket) : null;
      if (specLockReason) throw new Error(specLockReason);

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
      const allocatedTicketKey = existingTicket?.ticketKey ?? this.allocateTicketKey(database, input.repoPath);
      const resolvedTitle = input.title?.trim() || existingTicket?.title || "Feature Ticket";
      const updatedTicket: BoardTicket = existingTicket
        ? {
            ...existingTicket,
            title: resolvedTitle,
            featureSlug: existingTicket.featureSlug || deriveFeatureMockupSlug(resolvedTitle, allocatedTicketKey),
            acceptanceCriteria: input.acceptanceCriteria?.trim() || existingTicket.acceptanceCriteria,
            currentSpecRev: nextSpecRevisionNumber,
            specMockupCommit: specCommitAfterSave(existingTicket),
            specRevisions: [...existingTicket.specRevisions, createdSpecRevision],
            activeRunId: input.activeRunId !== undefined ? input.activeRunId : existingTicket.activeRunId,
            activePipelineId: input.activePipelineId !== undefined ? input.activePipelineId : existingTicket.activePipelineId,
            leadAgentId: input.leadAgentId !== undefined ? input.leadAgentId : existingTicket.leadAgentId,
            updatedAt: nowIso,
          }
        : {
            id: randomUUID(),
            ticketKey: allocatedTicketKey,
            repoPath: input.repoPath,
            title: resolvedTitle,
            featureSlug: deriveFeatureMockupSlug(resolvedTitle, allocatedTicketKey),
            acceptanceCriteria: input.acceptanceCriteria?.trim() || "",
            column: "spec",
            currentSpecRev: 1,
            currentBriefRev: 0,
            lastSyncedSpecRev: 0,
            specMockupCommit: null,
            specRevisions: [createdSpecRevision],
            mockup: null,
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

      // Move a ticket from SPEC, MOCKUP, or reopened DONE into BRIEF once its actionable bullet items are recorded.
      const nextColumn: BoardColumn =
        existingTicket.column === "spec" ||
        existingTicket.column === "mockup" ||
        existingTicket.column === "done"
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

  // Links a mockup file to its ticket, creating the ticket when the idea starts as a mockup with no Spec yet.
  saveMockup(input: SaveMockupInput): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      // Matching by file keeps repeated saves on one card when the agent omits the ticket key between edits.
      const existingTicket =
        (input.ticketIdOrKey ? this.requireTicket(input.ticketIdOrKey, input.repoPath) : null) ??
        this.listByRepo(input.repoPath).find((candidateTicket) => candidateTicket.mockup?.file === input.file) ??
        null;
      const baseTicket = existingTicket ?? createMockupTicket({
        ticketKey: this.allocateTicketKey(database, input.repoPath),
        repoPath: input.repoPath,
        title: input.title?.trim() || input.file,
        nowIso: new Date().toISOString(),
      });
      const updatedTicket = applyMockupUpdateToTicket(baseTicket, input);
      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Stores the human's open notes on a ticket's mockup so they survive until the Product Agent addresses them.
  recordMockupFeedback(
    params: RecordMockupFeedbackParams & { ticketIdOrKey: string; repoPath: string },
  ): BoardTicket {
    return this.updateMockupTicket(params.ticketIdOrKey, params.repoPath, (existingTicket) =>
      applyMockupFeedbackToTicket(existingTicket, params));
  }

  // Marks a ticket's mockup as approved at the commit that pins its content.
  approveMockup(params: { ticketIdOrKey: string; repoPath: string; approvedCommit: string }): BoardTicket {
    return this.updateMockupTicket(params.ticketIdOrKey, params.repoPath, (existingTicket) =>
      applyMockupApprovalToTicket(existingTicket, params.approvedCommit));
  }

  private updateMockupTicket(
    ticketIdOrKey: string,
    repoPath: string,
    applyTransition: (existingTicket: BoardTicket) => BoardTicket,
  ): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const updatedTicket = applyTransition(this.requireTicket(ticketIdOrKey, repoPath));
      this.persistTicket(database, updatedTicket);
      return updatedTicket;
    });
  }

  // Binds a prepared ticket to the Run started for it, which is how delegation later finds the feature's Spec and mockup.
  bindRun(ticketIdOrKey: string, repoPath: string, runId: string): BoardTicket {
    const database = this.resolveDatabase();
    return transaction(database, () => {
      const updatedTicket: BoardTicket = {
        ...this.requireTicket(ticketIdOrKey, repoPath),
        activeRunId: runId,
        updatedAt: new Date().toISOString(),
      };
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
