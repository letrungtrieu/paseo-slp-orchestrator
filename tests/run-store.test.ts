import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun } from "./helpers/run-factory";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createTemporaryDirectory = useTemporaryDirectories();

const openedStores: RunStore[] = [];

// Pending background writes must finish before the directory is removed, otherwise the
// atomic-write rename races with cleanup and the test fails with ENOTEMPTY.
afterEach(async () => {
  await Promise.all(openedStores.splice(0).map((openedStore) => openedStore.flush()));
});

async function newStore(prefix = "store") {
  const stateDirectory = await createTemporaryDirectory(prefix);
  const stateFilePath = join(stateDirectory, "nested", "state.json");
  const store = new RunStore(stateFilePath);
  openedStores.push(store);
  return { stateFilePath, store };
}

describe("RunStore persistence", () => {
  // first plugin start has no state file and must not fail
  it("starts empty when no state file exists yet", async () => {
    const { store } = await newStore();
    store.load();
    expect(store.list()).toEqual([]);
  });

  it("round-trips inserted and mutated runs through the state file", async () => {
    const { store, stateFilePath } = await newStore();
    store.insert(buildRun({ id: "run-a" }));
    store.mutate("run-a", (run) => {
      run.status = "planning";
      run.criteria = "criteria text";
    });
    await store.flush();

    const reloadedStore = new RunStore(stateFilePath);
    reloadedStore.load();
    expect(reloadedStore.require("run-a")).toMatchObject({ status: "planning", criteria: "criteria text" });
  });

  // the state directory may not exist yet and a stale .tmp would break the atomic swap
  it("creates the parent directory on first write and leaves no temp file behind", async () => {
    const { store, stateFilePath } = await newStore();
    store.insert(buildRun());
    await store.flush();
    expect(JSON.parse(await readFile(stateFilePath, "utf8")).version).toBe(1);
    // the atomic write renames the temp file away
    await expect(readFile(`${stateFilePath}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // writes are chained, so the last mutation must win on disk
  it("serialises many concurrent mutations into a consistent final file", async () => {
    const { store, stateFilePath } = await newStore();
    store.insert(buildRun());
    for (let counter = 1; counter <= 25; counter += 1) {
      store.mutate("run-1", (run) => {
        run.title = `title-${counter}`;
      });
    }
    await store.flush();
    const persistedState = JSON.parse(await readFile(stateFilePath, "utf8"));
    expect(persistedState.runs["run-1"].title).toBe("title-25");
  });

  // silently starting empty would wipe the run history
  it("throws on a file that is not valid JSON instead of silently starting empty", async () => {
    const { store, stateFilePath } = await newStore();
    store.insert(buildRun());
    await store.flush();
    await writeFile(stateFilePath, "{ this is not json", "utf8");
    expect(() => new RunStore(stateFilePath).load()).toThrow();
  });

  it("throws on JSON that does not match the state schema", async () => {
    const { store, stateFilePath } = await newStore();
    store.insert(buildRun());
    await store.flush();
    await writeFile(stateFilePath, JSON.stringify({ version: 2, runs: {} }), "utf8");
    expect(() => new RunStore(stateFilePath).load()).toThrow();
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
    const peerRecord = buildAgentRecord({ agentId: "agent-peer", role: "implementer", taskId: "t1", token: "tok-peer" });
    store.insert(buildRun({ id: "run-a", agents: { "agent-lead": leadRecord } }));
    store.insert(buildRun({ id: "run-b", agents: { "agent-peer": peerRecord } }));

    expect(store.findCallerByToken("tok-peer")).toMatchObject({ run: { id: "run-b" }, agentRecord: { agentId: "agent-peer", role: "implementer" } });
    expect(store.findCallerByToken("tok-lead")?.run.id).toBe("run-a");
    expect(store.findCallerByToken("wrong")).toBeNull();
    expect(store.findCallerByToken("")).toBeNull();
  });

  // lifecycle hooks identify agents by id, not token
  it("findAgent locates an agent by id", async () => {
    const { store } = await newStore();
    store.insert(buildRun({ agents: { a1: buildAgentRecord({ agentId: "a1", role: "qa" }) } }));
    expect(store.findAgent("a1")?.agentRecord.role).toBe("qa");
    expect(store.findAgent("a2")).toBeNull();
  });
});
