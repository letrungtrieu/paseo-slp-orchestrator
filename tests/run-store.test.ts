import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun, buildTask } from "./helpers/run-factory";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createTemporaryDirectory = useTemporaryDirectories();
const openedStores: RunStore[] = [];

// Release SQLite handles before temporary directory cleanup, including on failing assertions.
afterEach(() => { for (const openedStore of openedStores.splice(0)) openedStore.close(); });

function openStore(databasePath: string): RunStore {
  const store = new RunStore(databasePath);
  openedStores.push(store);
  return store;
}

async function newStore() {
  const stateDirectory = await createTemporaryDirectory("store");
  const databasePath = join(stateDirectory, "nested", "orchestrator.sqlite3");
  return { databasePath, store: openStore(databasePath) };
}

describe("RunStore SQLite persistence", () => {
  it("starts empty and creates a genuine SQLite database", async () => {
    const { store, databasePath } = await newStore();
    store.load();
    expect(store.list()).toEqual([]);
    expect(readFileSync(databasePath).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  // Reload through a second connection proves that acknowledgement follows a durable commit.
  it("round-trips run context, tasks and separately stored reports", async () => {
    const { store, databasePath } = await newStore();
    const task = buildTask({ id: "api", acceptanceReport: {
      report: "Imported historic acceptance text", submittedBy: "legacy-import", submittedAt: "2026-01-01",
    } });
    store.insert(buildRun({ tasks: { api: task }, masterSpec: "Architecture and contracts" }));
    store.mutate("run-1", (run) => { run.status = "planning"; run.criteria = "criteria text"; });
    const reloadedStore = openStore(databasePath);
    reloadedStore.load();
    expect(reloadedStore.require("run-1")).toMatchObject({ status: "planning", criteria: "criteria text",
      masterSpec: "Architecture and contracts", tasks: { api: { acceptanceReport: task.acceptanceReport } } });
  });

  it("persists the final state of repeated mutations", async () => {
    const { store, databasePath } = await newStore();
    store.insert(buildRun());
    for (let mutationNumber = 1; mutationNumber <= 25; mutationNumber += 1) {
      store.mutate("run-1", (run) => { run.title = `title-${mutationNumber}`; });
    }
    const reloadedStore = openStore(databasePath);
    reloadedStore.load();
    expect(reloadedStore.require("run-1").title).toBe("title-25");
  });

  // A rejected mutator must not leave a live value ahead of the database.
  it("rolls back memory when a mutator throws", async () => {
    const { store, databasePath } = await newStore();
    store.insert(buildRun());
    expect(() => store.mutate("run-1", (run) => { run.title = "partial"; throw new Error("rejected"); })).toThrow("rejected");
    expect(store.require("run-1").title).toBe("Test run");
    const reloadedStore = openStore(databasePath);
    reloadedStore.load();
    expect(reloadedStore.require("run-1").title).toBe("Test run");
  });

  it("rolls back run and task rows together on an SQL failure", async () => {
    const { store, databasePath } = await newStore();
    store.insert(buildRun({ tasks: { api: buildTask({ id: "api" }) } }));
    const database = new DatabaseSync(databasePath);
    try {
      // Force failure after the run row has changed, exercising the transaction's partial-write protection.
      database.exec("CREATE TRIGGER reject_task BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'forced task failure'); END");
      expect(() => store.mutate("run-1", (run) => {
        run.title = "partial"; run.tasks.api.purpose = "partial task";
      })).toThrow("forced task failure");
      const reloadedStore = openStore(databasePath);
      reloadedStore.load();
      expect(reloadedStore.require("run-1").title).toBe("Test run");
      expect(reloadedStore.require("run-1").tasks.api.purpose).toBe("test purpose");
      expect(store.require("run-1").title).toBe("Test run");
    } finally { database.close(); }
  });

  // Loading bad or newer storage must surface an error, never silently replace history.
  it("rejects a corrupt SQLite file", async () => {
    const { store, databasePath } = await newStore();
    store.load(); store.close();
    writeFileSync(databasePath, "not a database");
    expect(() => openStore(databasePath).load()).toThrow();
  });

  it("rejects an unsupported schema version", async () => {
    const { store, databasePath } = await newStore();
    store.load();
    const database = new DatabaseSync(databasePath);
    try { database.exec("PRAGMA user_version = 99"); } finally { database.close(); }
    expect(() => openStore(databasePath).load()).toThrow("Unsupported SLP database version");
  });

  it("queries only the requested run's bounded audit tail after reload", async () => {
    const { store, databasePath } = await newStore();
    store.insert(buildRun()); store.insert(buildRun({ id: "other" }));
    for (const summary of ["first", "second", "third"]) {
      store.appendLog({ runId: "run-1", taskId: null, from: "test", to: "pipeline", kind: "test", summary, outcome: "info" });
    }
    // Interleaved traffic from another run must not appear in this run's tail.
    store.appendLog({ runId: "other", taskId: null, from: "test", to: "pipeline", kind: "test", summary: "foreign", outcome: "info" });
    const reloadedStore = openStore(databasePath);
    reloadedStore.load();
    expect(reloadedStore.tailLog("run-1", 2).map((entry) => entry.summary)).toEqual(["second", "third"]);
  });
});

describe("RunStore access", () => {
  // callers rely on require() to fail loudly on stale run ids
  it("require throws for an unknown run and find returns undefined", async () => {
    const { store } = await newStore();
    expect(store.find("nope")).toBeUndefined();
    expect(() => store.require("nope")).toThrow(/Unknown SLP run/);
  });

  it("mutate returns the mutator's value and stamps updatedAt", async () => {
    const { store } = await newStore();
    store.insert(buildRun({ updatedAt: "2000-01-01T00:00:00.000Z" }));
    const previousStatus = store.mutate("run-1", (run) => {
      const before = run.status;
      run.status = "reporting";
      return before;
    });
    expect(previousStatus).toBe("running");
    expect(store.require("run-1").updatedAt > "2000-01-01T00:00:00.000Z").toBe(true);
  });

  // a mutator must never run against a missing run
  it("mutate on an unknown run throws and does not call the mutator", async () => {
    const { store } = await newStore();
    let mutatorCalled = false;
    expect(() => store.mutate("ghost", () => { mutatorCalled = true; })).toThrow();
    expect(mutatorCalled).toBe(false);
  });

  // the bus authenticates agents only by this lookup
  it("findCallerByToken resolves the owning run and agent across runs", async () => {
    const { store } = await newStore();
    const leadRecord = buildAgentRecord({ agentId: "agent-lead", role: "master_lead", token: "tok-lead" });
    const peerRecord = buildAgentRecord({ agentId: "agent-peer", role: "peer", projectRole: "developer", taskId: "t1", token: "tok-peer" });
    store.insert(buildRun({ id: "run-a", agents: { "agent-lead": leadRecord } }));
    store.insert(buildRun({ id: "run-b", agents: { "agent-peer": peerRecord } }));

    expect(store.findCallerByToken("tok-peer")).toMatchObject({ run: { id: "run-b" }, agentRecord: { agentId: "agent-peer", role: "peer", projectRole: "developer" } });
    expect(store.findCallerByToken("tok-lead")?.run.id).toBe("run-a");
    expect(store.findCallerByToken("wrong")).toBeNull();
    expect(store.findCallerByToken("")).toBeNull();
  });

  // lifecycle hooks identify agents by id, not token
  it("findAgent locates an agent by id", async () => {
    const { store } = await newStore();
    store.insert(buildRun({ agents: { a1: buildAgentRecord({ agentId: "a1", role: "peer", projectRole: "qa-engineer" }) } }));
    expect(store.findAgent("a1")?.agentRecord).toMatchObject({ role: "peer", projectRole: "qa-engineer" });
    expect(store.findAgent("a2")).toBeNull();
  });
});
