// Orchestration knobs shared by host settings and the per-run snapshot, so a run keeps the policy it started with.
import { z } from "zod";

export const OrchestrationSettingsSchema = z.object({
  // Off by default: a peer briefed only with the locked brief carries none of the Lead's exploratory context,
  // which keeps it on scope; the toggle exists to measure whether forking actually helps.
  forkPeers: z.boolean().default(false),
  // Rework rounds a Lead may request per stage before the decision goes to the human through the Supervisor.
  maxReworkRounds: z.number().int().min(1).max(10).default(3),
});
export type OrchestrationSettings = z.infer<typeof OrchestrationSettingsSchema>;

export const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = OrchestrationSettingsSchema.parse({});

// Runs created before these settings existed always forked peers, so they keep doing so after an upgrade.
const LEGACY_RUN_ORCHESTRATION: OrchestrationSettings = { forkPeers: true, maxReworkRounds: 3 };

export function runOrchestration(run: { orchestration?: OrchestrationSettings | null }): OrchestrationSettings {
  return run.orchestration ?? LEGACY_RUN_ORCHESTRATION;
}
