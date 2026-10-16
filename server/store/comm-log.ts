// Audit trail of every inter-agent message and pipeline decision: .slp/comm-log.jsonl inside
// the target repository (spec section 5, "black box"). Append only, one JSON object per line.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CommLogEntrySchema, type CommLogEntry } from "../../shared/state";

export type CommLogInput = Omit<CommLogEntry, "ts" | "reason" | "durationMs"> &
  Partial<Pick<CommLogEntry, "reason" | "durationMs">>;

export function commLogPath(repoPath: string): string {
  return join(repoPath, ".slp", "comm-log.jsonl");
}

export async function appendCommLog(repoPath: string, input: CommLogInput): Promise<void> {
  const logEntry: CommLogEntry = {
    ts: new Date().toISOString(),
    reason: null,
    durationMs: null,
    ...input,
  };
  try {
    await mkdir(join(repoPath, ".slp"), { recursive: true });
    await appendFile(commLogPath(repoPath), `${JSON.stringify(logEntry)}\n`, "utf8");
  } catch (appendError) {
    // logging is diagnostic; a read-only repo must never stop the pipeline
    console.error("[slp] comm-log append failed", appendError);
  }
}

export async function tailCommLog(
  repoPath: string,
  runId: string,
  limit: number,
): Promise<CommLogEntry[]> {
  let logText: string;
  try {
    logText = await readFile(commLogPath(repoPath), "utf8");
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw readError;
  }
  const runEntries: CommLogEntry[] = [];
  for (const logLine of logText.split("\n")) {
    if (!logLine.trim()) continue;
    const parsedLine = CommLogEntrySchema.safeParse(safeJson(logLine));
    // skip foreign runs and any truncated line left by a crash mid-write
    if (parsedLine.success && parsedLine.data.runId === runId) runEntries.push(parsedLine.data);
  }
  // appends are fire and forget and can land out of order; the timestamp is the true order
  runEntries.sort((first, second) => first.ts.localeCompare(second.ts));
  return runEntries.slice(-limit);
}

function safeJson(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}
