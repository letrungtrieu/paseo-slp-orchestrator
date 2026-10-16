// In-memory run state with atomic JSON persistence. Plugin events are best effort and
// the subprocess can restart at any time, so every decision the pipeline makes is written here.
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StateFileSchema, type AgentRecord, type Run, type StateFile } from "../../shared/state";

export interface CallerLookup {
  run: Run;
  agentRecord: AgentRecord;
}

export class RunStore {
  private stateFile: StateFile = { version: 1, runs: {} };
  // writes are chained so concurrent mutations never interleave partial files
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly stateFilePath: string) {}

  // Synchronous on purpose: the plugin entry must return its cleanup function immediately,
  // and every RPC handler needs the state to be present before the first call arrives.
  load(): void {
    let rawState: string;
    try {
      rawState = readFileSync(this.stateFilePath, "utf8");
    } catch (readError) {
      // first start: nothing persisted yet
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") return;
      throw readError;
    }
    // a corrupt file must not wipe history silently, so surface the parse error to the caller
    this.stateFile = StateFileSchema.parse(JSON.parse(rawState));
  }

  list(): Run[] {
    return Object.values(this.stateFile.runs);
  }

  find(runId: string): Run | undefined {
    return this.stateFile.runs[runId];
  }

  require(runId: string): Run {
    const run = this.find(runId);
    if (!run) throw new Error(`Unknown SLP run: ${runId}`);
    return run;
  }

  insert(run: Run): void {
    this.stateFile.runs[run.id] = run;
    this.scheduleWrite();
  }

  // Mutations are synchronous on purpose: JS is single threaded, so a mutator can never
  // observe another flow halfway through its own update.
  mutate<Outcome>(runId: string, mutator: (run: Run) => Outcome): Outcome {
    const run = this.require(runId);
    const mutationOutcome = mutator(run);
    run.updatedAt = new Date().toISOString();
    this.scheduleWrite();
    return mutationOutcome;
  }

  // Bus requests carry only a token; this resolves it to the run and agent that own it.
  findCallerByToken(token: string): CallerLookup | null {
    for (const run of this.list()) {
      for (const agentRecord of Object.values(run.agents)) {
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

  flush(): Promise<void> {
    return this.pendingWrite;
  }

  private scheduleWrite(): void {
    this.pendingWrite = this.pendingWrite.then(() => this.writeAtomically()).catch((writeError) => {
      // a failed write is logged but must not break the chain for later writes
      console.error("[slp] failed to persist state", writeError);
    });
  }

  private async writeAtomically(): Promise<void> {
    await mkdir(dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = `${this.stateFilePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.stateFile, null, 2), "utf8");
    // rename is atomic on one filesystem, so readers never see a half written state
    await rename(temporaryPath, this.stateFilePath);
  }
}
