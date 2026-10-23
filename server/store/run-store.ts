// The pipeline keeps live object identities; SQLite commits each mutation before acknowledging it.
import type { DatabaseSync } from "node:sqlite";
import { CommLogEntrySchema, type AgentRecord, type CommLogEntry, type Run } from "../../shared/state";
import type { CommLogInput } from "./comm-log";
import { openDatabase, transaction } from "./database";
import { importLegacyState } from "./legacy-import";
import { QuestionStore } from "./question-store";
import { readRuns, writeRun } from "./run-repository";

export interface CallerLookup { run: Run; agentRecord: AgentRecord }

export class RunStore {
  private runs: Record<string, Run> = {};
  private connection: DatabaseSync | null = null;
  private closed = false;
  // Shares this store's lifecycle: the ledger resolves the connection lazily and so fails once the store is closed.
  readonly questions = new QuestionStore(() => this.database());

  constructor(private readonly databasePath: string, private readonly legacyStatePath?: string) {}

  private database(): DatabaseSync {
    // A closed store cannot reopen during a detached shutdown callback.
    if (this.closed) throw new Error("SLP store is closed");
    return this.connection ??= openDatabase(this.databasePath);
  }

  load(): void {
    const database = this.database();
    try {
      if (this.legacyStatePath) importLegacyState(database, this.legacyStatePath);
      this.runs = Object.fromEntries(readRuns(database).map((run) => [run.id, run]));
    } catch (loadError) {
      // A failed plugin contribution has no cleanup callback, so release its connection immediately.
      database.close();
      this.connection = null;
      throw loadError;
    }
  }

  list(): Run[] { return Object.values(this.runs); }
  // RPC callers can submit arbitrary IDs; an inherited key is never a persisted run.
  find(runId: string): Run | undefined { return Object.hasOwn(this.runs, runId) ? this.runs[runId] : undefined; }

  require(runId: string): Run {
    const run = this.find(runId);
    // Unknown run IDs must fail before any SQL or agent action is attempted.
    if (!run) throw new Error(`Unknown SLP run: ${runId}`);
    return run;
  }

  insert(run: Run): void {
    transaction(this.database(), () => writeRun(this.database(), run));
    this.runs[run.id] = run;
  }

  mutate<Outcome>(runId: string, mutator: (run: Run) => Outcome): Outcome {
    const run = this.require(runId);
    const beforeMutation = structuredClone(run);
    try {
      const mutationOutcome = mutator(run);
      run.updatedAt = new Date().toISOString();
      // Preserve the live run object because in-flight pipeline steps already reference it.
      transaction(this.database(), () => writeRun(this.database(), run));
      return mutationOutcome;
    } catch (mutationError) {
      Object.assign(run, beforeMutation);
      throw mutationError;
    }
  }

  findCallerByToken(token: string): CallerLookup | null {
    for (const run of this.list()) {
      for (const agentRecord of Object.values(run.agents)) {
        // Roles always come from persisted ownership, never an agent's tool arguments.
        if (agentRecord.token === token) return { run, agentRecord };
      }
    }
    return null;
  }

  findAgent(agentId: string): CallerLookup | null {
    for (const run of this.list()) {
      const agentRecord = run.agents[agentId];
      if (agentRecord) return { run, agentRecord };
    }
    return null;
  }

  appendLog(input: CommLogInput): void {
    const logEntry = { ts: new Date().toISOString(), reason: null, durationMs: null, ...input };
    this.database().prepare("INSERT INTO comm_logs(run_id, ts, payload) VALUES (?, ?, ?)")
      .run(logEntry.runId, logEntry.ts, JSON.stringify(logEntry));
  }

  tailLog(runId: string, limit: number): CommLogEntry[] {
    // Query only the requested tail; an old run's entire history need not enter memory.
    return this.database().prepare("SELECT payload FROM comm_logs WHERE run_id = ? ORDER BY ts DESC, log_id DESC LIMIT ?")
      .all(runId, Math.max(1, Math.min(1000, Math.trunc(limit))))
      .reverse().map((logRow) => CommLogEntrySchema.parse(JSON.parse(String(logRow.payload))));
  }

  // Writes are synchronous and durable, but callers may still await this lifecycle boundary.
  flush(): Promise<void> { return Promise.resolve(); }

  close(): void {
    this.connection?.close();
    this.connection = null;
    this.closed = true;
  }
}
