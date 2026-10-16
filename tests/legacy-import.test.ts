import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../server/store/run-store";
import { buildAgentRecord, buildRun, buildTask } from "./helpers/run-factory";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();
const openedStores: RunStore[] = [];
afterEach(() => { for (const store of openedStores.splice(0)) store.close(); });

async function legacyFixture() {
  const stateDirectory = await createDirectory("legacy");
  const repoPath = join(stateDirectory, "repo");
  mkdirSync(join(repoPath, ".slp"), { recursive: true });
  const legacyPath = join(stateDirectory, "state.json");
  const databasePath = join(stateDirectory, "orchestrator.sqlite3");
  const run = buildRun({ repoPath, devCwd: repoPath,
    tasks: { api: buildTask({ id: "api", workspace: { cwd: repoPath, branch: "task/api", workspaceId: "ws-api" } }) },
    agents: { lead: buildAgentRecord({ agentId: "lead", role: "master_lead", token: "preserved-token" }) },
  });
  writeFileSync(legacyPath, JSON.stringify({ version: 1, runs: { [run.id]: { ...run, masterSpecPath: ".slp/MASTER_SPEC.md" } } }));
  const openStore = () => {
    const store = new RunStore(databasePath, legacyPath);
    openedStores.push(store);
    return store;
  };
  return { legacyPath, repoPath, openStore };
}

describe("legacy file import", () => {
  it("imports specs, task reports, logs and agent identities without changing the old files", async () => {
    const { legacyPath, repoPath, openStore } = await legacyFixture();
    writeFileSync(join(repoPath, ".slp/MASTER_SPEC.md"), "Original architecture");
    writeFileSync(join(repoPath, ".slp/ACCEPTANCE_DOC.md"), "## Summary\nHistoric acceptance");
    const legacyLog = { ts: "2026-01-01", runId: "run-1", taskId: "api", from: "lead", to: "peer", kind: "test", summary: "historic", outcome: "delivered" };
    // A truncated final append must not prevent valid history from being imported.
    writeFileSync(join(repoPath, ".slp/comm-log.jsonl"), `${JSON.stringify(legacyLog)}\n{truncated`);
    const originalStateText = readFileSync(legacyPath, "utf8");
    const store = openStore(); store.load();
    expect(store.require("run-1").masterSpec).toBe("Original architecture");
    expect(store.require("run-1").tasks.api.acceptanceReport?.report).toContain("Historic acceptance");
    expect(store.findCallerByToken("preserved-token")?.run.id).toBe("run-1");
    expect(store.tailLog("run-1", 10)).toHaveLength(1);
    expect(readFileSync(legacyPath, "utf8")).toBe(originalStateText);
  });

  // Reloads must not replay stale JSON over decisions made after the first import.
  it("imports once and keeps later SQLite changes on subsequent reloads", async () => {
    const { openStore } = await legacyFixture();
    const store = openStore(); store.load();
    store.mutate("run-1", (run) => { run.title = "New SQLite title"; });
    const reloadedStore = openStore(); reloadedStore.load();
    expect(reloadedStore.require("run-1").title).toBe("New SQLite title");
  });

  it.each(["{broken", ""])("fails on corrupt JSON (%j) and permits a corrected migration retry", async (corruptState) => {
    const { legacyPath, openStore } = await legacyFixture();
    const validLegacyText = readFileSync(legacyPath, "utf8");
    writeFileSync(legacyPath, corruptState);
    expect(() => openStore().load()).toThrow();
    // No migration marker is committed on failure, so the repaired source can be imported normally.
    writeFileSync(legacyPath, validLegacyText);
    const repairedStore = openStore(); repairedStore.load();
    expect(repairedStore.list()).toHaveLength(1);
  });
});
