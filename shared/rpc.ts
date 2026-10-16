// RPC contracts between the app UI and the daemon-side orchestrator.
// Both runtimes import these so the Zod schemas validate every call on both ends.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RunModeSchema } from "./roles";
import { CommLogEntrySchema, RunSchema, RunStatusSchema } from "./state";

// Compact row for the run picker; the full Run is only fetched for the selected run.
// Carries only what the picker renders, so a 3 s poll of many runs does not ship whole task tables.
export const RunSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  repoPath: z.string(),
  status: RunStatusSchema,
  mode: RunModeSchema,
  taskCount: z.number(),
  mergedTaskCount: z.number(),
  openGateCount: z.number(),
  supervisorAgentId: z.string(),
  supervisorWorkspaceId: z.string(),
  updatedAt: z.string(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const listRunsRpc = defineRpc({
  name: "slp.run.list",
  input: z.object({}),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});

export const getRunRpc = defineRpc({
  name: "slp.run.get",
  input: z.object({ runId: z.string() }),
  // Nullable instead of an error: a run may legitimately vanish (state reset) while the UI still polls its id.
  output: z.object({ run: RunSchema.nullable() }),
});

export const startRunRpc = defineRpc({
  name: "slp.run.start",
  input: z.object({
    // min(1) rejects an empty path on both ends before any worktree is created.
    repoPath: z.string().min(1),
    title: z.string().optional(),
    baseBranch: z.string().optional(),
    // STEP_BY_STEP_DEBUG is the safest default for callers that omit the mode, such as the CLI helper.
    mode: RunModeSchema.default("STEP_BY_STEP_DEBUG"),
    supervisorProvider: z.string().optional(),
    leadProvider: z.string().optional(),
    peerProvider: z.string().optional(),
  }),
  output: z.object({
    runId: z.string(),
    supervisorAgentId: z.string(),
    supervisorWorkspaceId: z.string(),
  }),
});

export const setRunModeRpc = defineRpc({
  name: "slp.run.set_mode",
  input: z.object({ runId: z.string(), mode: RunModeSchema }),
  output: z.object({ ok: z.boolean() }),
});

// Approves the gate of one task, or the run level gate when taskId is omitted.
export const approveGateRpc = defineRpc({
  name: "slp.gate.approve",
  // note is optional and currently unused by the UI; it is kept so approvals can later carry a reason in the audit log.
  input: z.object({ runId: z.string(), taskId: z.string().optional(), note: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// Resumes a paused task (circuit breaker or repeated scope violations) with optional guidance.
export const resumeTaskRpc = defineRpc({
  name: "slp.task.resume",
  input: z.object({ runId: z.string(), taskId: z.string(), guidance: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// The Supreme Manager's final button: merge the integration branch into the base branch.
export const approveMainRpc = defineRpc({
  name: "slp.run.approve_main",
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const abortRunRpc = defineRpc({
  name: "slp.run.abort",
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const tailLogRpc = defineRpc({
  name: "slp.log.tail",
  // Bounded by 500 so one request cannot read an unbounded log file; the UI asks for 200.
  input: z.object({ runId: z.string(), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ entries: z.array(CommLogEntrySchema) }),
});
