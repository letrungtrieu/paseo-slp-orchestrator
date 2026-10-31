// One-time move of tickets stored as a single JSON payload into the relational mockup/Spec/Brief tables.
import type { DatabaseSync } from "node:sqlite";
import { BoardTicketSchema } from "../../shared/board";
import { upgradeLegacyTicketPayload } from "./board-mockup";
import { writeTicketRows } from "./board-ticket-rows";

export function migrateBoardPayloadsToRelations(database: DatabaseSync): void {
  const storedCards = database.prepare("SELECT payload FROM board_tickets").all();
  for (const storedCard of storedCards) {
    const storedPayload = JSON.parse(String(storedCard.payload)) as Record<string, unknown>;
    // Only the old single-payload shape needs moving; a card already split into tables must be left alone.
    if (!Array.isArray(storedPayload.specRevisions)) continue;

    const migratedTicket = BoardTicketSchema.parse(upgradeLegacyTicketPayload(storedPayload));
    // Tickets prepared before this rule were ready to run, so an approved mockup is taken as already matching its Spec.
    // A draft mockup stays unmatched so its next approval asks for a review of the Spec.
    const migratedMockupCommit =
      migratedTicket.mockup?.status === "approved" && migratedTicket.currentSpecRev >= 1
        ? migratedTicket.mockup.approvedCommit
        : null;
    writeTicketRows(database, { ...migratedTicket, specMockupCommit: migratedMockupCommit });
  }
}
