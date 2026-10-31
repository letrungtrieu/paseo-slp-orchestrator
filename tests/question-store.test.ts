import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildPeerQuestionViews, computePeerQuestionMetrics } from "../server/pipeline/peer-messaging/question-metrics";
import { openDatabase } from "../server/store/database";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun } from "./helpers/run-factory";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createTemporaryDirectory = useTemporaryDirectories();
const openedStores: RunStore[] = [];
afterEach(() => { for (const openedStore of openedStores.splice(0)) openedStore.close(); });

async function storeWithRun() {
  const stateDirectory = await createTemporaryDirectory("questions");
  const store = new RunStore(join(stateDirectory, "orchestrator.sqlite3"));
  openedStores.push(store);
  store.load();
  const run = buildRun({ id: "run-1" });
  store.insert(run);
  return { store, run, stateDirectory };
}

const newQuestion = (questionId: string, overrides: Record<string, unknown> = {}) => ({
  questionId, runId: "run-1", fromAgentId: "agent-asker", toAgentId: "agent-recipient",
  scope: "stage" as const, pipelineId: "pipeline-1", question: `question ${questionId}`,
  createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
});

describe("question ledger schema", () => {
  it("upgrades an existing v1 database to v2 without touching its runs", async () => {
    const stateDirectory = await createTemporaryDirectory("migration");
    const databasePath = join(stateDirectory, "orchestrator.sqlite3");
    // Build a genuine v1 file: the full v2 schema minus the questions table, stamped user_version 1.
    openDatabase(databasePath).close();
    const legacyConnection = new DatabaseSync(databasePath);
    legacyConnection.exec("DROP TABLE questions; PRAGMA user_version = 1;");
    legacyConnection.close();

    const upgradedConnection = openDatabase(databasePath);
    expect(upgradedConnection.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    expect(upgradedConnection.prepare("SELECT name FROM sqlite_master WHERE name = 'questions'").get()).toBeTruthy();
    expect(upgradedConnection.prepare("SELECT name FROM sqlite_master WHERE name = 'board_tickets'").get()).toBeTruthy();
    upgradedConnection.close();
  });

  it("refuses a database written by a newer schema", async () => {
    const stateDirectory = await createTemporaryDirectory("future");
    const databasePath = join(stateDirectory, "orchestrator.sqlite3");
    openDatabase(databasePath).close();
    const futureConnection = new DatabaseSync(databasePath);
    futureConnection.exec("PRAGMA user_version = 5;");
    futureConnection.close();
    expect(() => openDatabase(databasePath)).toThrow(/Unsupported SLP database version: 5/);
  });
});

describe("QuestionStore", () => {
  it("round-trips a question through answer and delivery with durable timestamps", async () => {
    const { store } = await storeWithRun();
    const insertedQuestion = store.questions.insert(newQuestion("q1"));
    expect(insertedQuestion).toMatchObject({ status: "pending", answer: null, deliveredAt: null, reminderCount: 0 });

    store.questions.markDeliveredTo("agent-recipient", ["q1"], "2026-01-01T00:00:01.000Z");
    const answeredQuestion = store.questions.recordAnswer("q1", "the answer", "2026-01-01T00:00:05.000Z");
    expect(answeredQuestion).toMatchObject({ status: "answered", answer: "the answer", deliveredAt: "2026-01-01T00:00:01.000Z" });
    // Delivery is scoped by agent: the same id applied to the asker stamps the answer, not the question.
    store.questions.markDeliveredTo("agent-asker", ["q1"], "2026-01-01T00:00:06.000Z");
    expect(store.questions.require("q1").answerDeliveredAt).toBe("2026-01-01T00:00:06.000Z");
  });

  it("keeps the ledger across a reload of the database file", async () => {
    const { store, stateDirectory } = await storeWithRun();
    store.questions.insert(newQuestion("q1"));
    store.questions.recordAnswer("q1", "persisted", "2026-01-01T00:00:05.000Z");
    store.close();

    const reopenedStore = new RunStore(join(stateDirectory, "orchestrator.sqlite3"));
    openedStores.push(reopenedStore);
    reopenedStore.load();
    expect(reopenedStore.questions.require("q1")).toMatchObject({ status: "answered", answer: "persisted" });
  });

  it("records an answer to an expired question as answered_late and never lets a stale sweep overwrite an answer", async () => {
    const { store } = await storeWithRun();
    store.questions.insert(newQuestion("q1"));
    expect(store.questions.expire("q1", "2026-01-01T00:10:00.000Z", "timeout")).toBe(true);
    expect(store.questions.recordAnswer("q1", "too late", "2026-01-01T00:11:00.000Z").status).toBe("answered_late");

    store.questions.insert(newQuestion("q2"));
    store.questions.recordAnswer("q2", "in time", "2026-01-01T00:00:03.000Z");
    // The sweep read q2 as pending a moment before the answer landed; expiring it now must be a no-op.
    expect(store.questions.expire("q2", "2026-01-01T00:10:00.000Z", "timeout")).toBe(false);
    expect(store.questions.require("q2").status).toBe("answered");
  });

  it("lists only pending work for the right agent and counts open questions per asker", async () => {
    const { store } = await storeWithRun();
    store.questions.insert(newQuestion("q1"));
    store.questions.insert(newQuestion("q2", { toAgentId: "agent-other" }));
    store.questions.insert(newQuestion("q3"));
    store.questions.recordAnswer("q3", "done", "2026-01-01T00:00:03.000Z");

    expect(store.questions.listPendingForRecipient("run-1", "agent-recipient").map((q) => q.questionId)).toEqual(["q1"]);
    expect(store.questions.countPendingFromAsker("run-1", "agent-asker")).toBe(2);
    expect(store.questions.listUnconsumedAnswers("run-1", "agent-asker").map((q) => q.questionId)).toEqual(["q3"]);
    store.questions.markAnswerDelivered("q3", "2026-01-01T00:00:04.000Z");
    expect(store.questions.listUnconsumedAnswers("run-1")).toEqual([]);
  });
});

describe("peer question metrics", () => {
  it("summarises answer rate, response time and per-pair health", async () => {
    const { store } = await storeWithRun();
    store.mutate("run-1", (run) => {
      run.agents["agent-asker"] = buildAgentRecord({ agentId: "agent-asker", role: "peer", projectRole: "reviewer" });
      run.agents["agent-recipient"] = buildAgentRecord({ agentId: "agent-recipient", role: "peer", projectRole: "developer" });
    });
    store.questions.insert(newQuestion("fast"));
    store.questions.recordAnswer("fast", "ok", "2026-01-01T00:00:02.000Z");
    store.questions.insert(newQuestion("slow", { createdAt: "2026-01-01T00:01:00.000Z" }));
    store.questions.recordAnswer("slow", "ok", "2026-01-01T00:01:10.000Z");
    store.questions.insert(newQuestion("lost", { createdAt: "2026-01-01T00:02:00.000Z" }));
    store.questions.expire("lost", "2026-01-01T00:12:00.000Z", "timeout");
    store.questions.insert(newQuestion("open", { createdAt: "2026-01-01T00:03:00.000Z" }));

    const views = buildPeerQuestionViews(store.require("run-1"), store.questions.listForRun("run-1", 100));
    const metrics = computePeerQuestionMetrics(views);
    expect(metrics).toMatchObject({ total: 4, pending: 1, answered: 2, expired: 1, answeredLate: 0 });
    // 2 answered out of 3 resolved; the still-open question does not count against the rate.
    expect(metrics.answerRate).toBeCloseTo(2 / 3);
    expect(metrics.medianResponseMs).toBe(2_000);
    expect(metrics.p90ResponseMs).toBe(10_000);
    expect(metrics.byPair).toEqual([
      { fromLabel: "reviewer", toLabel: "developer", asked: 4, answered: 2, expired: 1, medianResponseMs: 2_000 },
    ]);
  });

  it("reports empty metrics without dividing by zero", () => {
    expect(computePeerQuestionMetrics([])).toMatchObject({ total: 0, answerRate: null, medianResponseMs: null, byPair: [] });
  });
});
