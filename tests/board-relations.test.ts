// The mockup -> Spec -> Brief dependency must exist in SQLite itself, not only in the ticket object.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../server/store/database";
import { RunStore } from "../server/store/run-store";
import { BoardTicketSchema } from "../shared/board";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createTemporaryDirectory = useTemporaryDirectories();
const REPO_PATH = "/repo/checkout";

async function newStore(prefix: string): Promise<{ store: RunStore; databasePath: string }> {
  const stateDirectory = await createTemporaryDirectory(prefix);
  const databasePath = join(stateDirectory, "orchestrator.sqlite3");
  return { store: new RunStore(databasePath), databasePath };
}

// Foreign keys are a per-connection setting, so the inspecting connection turns them on like the daemon does.
function inspectionConnection(databasePath: string): DatabaseSync {
  const connection = new DatabaseSync(databasePath);
  connection.exec("PRAGMA foreign_keys = ON;");
  return connection;
}

function countRows(connection: DatabaseSync, tableName: string): number {
  return Number(connection.prepare(`SELECT COUNT(*) AS rowCount FROM ${tableName}`).get()?.rowCount);
}

describe("board relations", () => {
  it("stores a mockup, its Spec and the Brief revisions as dependent rows", async () => {
    const { store, databasePath } = await newStore("relations");
    const draftTicket = store.board.saveMockup({
      repoPath: REPO_PATH,
      title: "Checkout",
      file: ".slp/mockup/checkout.html",
      summary: "Màn hình thanh toán",
      authorAgentId: "product-agent-1",
    });
    const connection = inspectionConnection(databasePath);

    // A mockup-only ticket must not pretend it has a Spec.
    expect(countRows(connection, "board_mockups")).toBe(1);
    expect(countRows(connection, "board_specs")).toBe(0);

    store.board.approveMockup({ ticketIdOrKey: draftTicket.id, repoPath: REPO_PATH, approvedCommit: "commit-1" });
    store.board.saveSpec({
      repoPath: REPO_PATH,
      ticketIdOrKey: draftTicket.id,
      specContent: "Thin spec",
      author: "supervisor",
    });
    store.board.saveBrief({
      ticketId: draftTicket.id,
      authorAgentId: "lead-1",
      reason: "First brief",
      approach: "Build it",
      items: [{ id: "B1", requirement: "Pay", verification: "Run the test", scope: "in" }],
    });

    const specRow = connection.prepare("SELECT mockup_ticket_id, reviewed_mockup_commit FROM board_specs").get();
    expect(specRow).toMatchObject({ mockup_ticket_id: draftTicket.id, reviewed_mockup_commit: "commit-1" });
    expect(countRows(connection, "board_spec_revisions")).toBe(1);
    expect(countRows(connection, "board_brief_revisions")).toBe(1);

    // Reading rejoins the rows into the same ticket, with counters taken from the revisions that exist.
    const rejoinedTicket = store.board.requireTicket(draftTicket.id);
    expect(rejoinedTicket.currentSpecRev).toBe(1);
    expect(rejoinedTicket.currentBriefRev).toBe(1);
    expect(rejoinedTicket.mockup?.status).toBe("approved");
    connection.close();
  });

  it("refuses a Spec or Brief row that has no parent", async () => {
    const { store, databasePath } = await newStore("orphans");
    store.board.saveMockup({
      repoPath: REPO_PATH,
      title: "Checkout",
      file: ".slp/mockup/checkout.html",
      summary: "x",
      authorAgentId: "product-agent-1",
    });
    const connection = inspectionConnection(databasePath);
    expect(() =>
      connection
        .prepare("INSERT INTO board_specs (ticket_id, updated_at) VALUES ('missing-ticket', 'now')")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      connection
        .prepare("INSERT INTO board_brief_revisions (ticket_id, rev, spec_rev, created_at, payload) VALUES ('missing-ticket', 1, 1, 'now', '{}')")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    connection.close();
  });

  it("locks the Spec in the store while the mockup is a draft", async () => {
    const { store } = await newStore("lock");
    const draftTicket = store.board.saveMockup({
      repoPath: REPO_PATH,
      title: "Checkout",
      file: ".slp/mockup/checkout.html",
      summary: "x",
      authorAgentId: "product-agent-1",
    });
    expect(() =>
      store.board.saveSpec({ repoPath: REPO_PATH, ticketIdOrKey: draftTicket.id, specContent: "Early spec", author: "human" }),
    ).toThrow(/still a draft/);
  });

  it("moves tickets stored as one JSON payload into the tables when the database is upgraded", async () => {
    const stateDirectory = await createTemporaryDirectory("migration");
    const databasePath = join(stateDirectory, "orchestrator.sqlite3");
    openDatabase(databasePath).close();

    // Rebuild what a v3 file looks like: no relation tables, and the whole ticket inside the card payload.
    const legacyConnection = new DatabaseSync(databasePath);
    legacyConnection.exec(
      "DROP TABLE board_brief_revisions; DROP TABLE board_spec_revisions; DROP TABLE board_specs; DROP TABLE board_mockups; PRAGMA user_version = 3;",
    );
    const timestamp = "2026-10-01T00:00:00.000Z";
    const insertLegacyTicket = legacyConnection.prepare(
      "INSERT INTO board_tickets (ticket_id, repo_path, ticket_key, column_name, active_run_id, active_pipeline_id, updated_at, payload) VALUES (?, ?, ?, 'spec', NULL, NULL, ?, ?)",
    );
    for (const [ticketId, ticketKey, mockupStatus] of [
      ["ticket-approved", "SLP-1", "approved"],
      ["ticket-draft", "SLP-2", "draft"],
    ] as const) {
      const legacyTicket = BoardTicketSchema.parse({
        id: ticketId,
        ticketKey,
        repoPath: REPO_PATH,
        title: ticketKey,
        currentSpecRev: 1,
        specRevisions: [{ rev: 1, author: "supervisor", content: "Old spec", createdAt: timestamp }],
        mockup: {
          file: ".slp/mockup/x.html",
          status: mockupStatus,
          approvedCommit: mockupStatus === "approved" ? "commit-9" : null,
          authorAgentId: "a",
          updatedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      insertLegacyTicket.run(ticketId, REPO_PATH, ticketKey, timestamp, JSON.stringify(legacyTicket));
    }
    legacyConnection.close();

    const upgradedStore = new RunStore(databasePath);
    const approvedTicket = upgradedStore.board.requireTicket("ticket-approved");
    const draftTicket = upgradedStore.board.requireTicket("ticket-draft");
    expect(approvedTicket.specRevisions).toHaveLength(1);
    // A ticket that was ready to run stays ready; one still in draft is reviewed when its mockup is next approved.
    expect(approvedTicket.specMockupCommit).toBe("commit-9");
    expect(draftTicket.specMockupCommit).toBeNull();
    expect(draftTicket.mockup?.status).toBe("draft");
  });
});
