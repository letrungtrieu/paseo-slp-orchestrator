import type { CommLogEntry } from "../../shared/state";

// Timestamp and optional diagnostics are supplied by SQLite, keeping every caller's audit shape consistent.
export type CommLogInput = Omit<CommLogEntry, "ts" | "reason" | "durationMs"> &
  Partial<Pick<CommLogEntry, "reason" | "durationMs">>;
