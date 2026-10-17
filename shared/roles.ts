// Runtime roles shared by the daemon-side orchestrator and the app UI.
// Business peer roles are loaded from .slp and therefore do not belong in this enum.
import { z } from "zod";

// This list deliberately contains orchestration roles only; a Lead-created pipeline can use any
// project role without requiring a source change or turning that role into a capability enum.
export const SLP_ROLES = [
  "supervisor",
  "master_lead",
  "forked_lead",
  "peer",
] as const;
export const SlpRoleSchema = z.enum(SLP_ROLES);
export type SlpRole = z.infer<typeof SlpRoleSchema>;

// Name under which the plugin-hosted MCP server is registered inside every agent session.
export const BUS_SERVER_NAME = "slp-bus";

// Fixed-task limits are defined in legacy-tasks.ts; these aliases keep old test and UI imports
// readable while the dynamic runtime stays independent from the retired task engine.
export { FIX_LOOP_LIMIT, HANDSHAKE_ROUND_LIMIT, SCOPE_VIOLATION_LIMIT } from "./legacy-tasks";

// How often an agent is re-prompted when it ends a turn without calling its expected tool.
// Kept small: each nudge costs a full model turn, and an agent that ignores two reminders is stuck, not forgetful.
export const NUDGE_LIMIT = 2;

// The three operating modes of spec section 5.
export const RUN_MODES = ["STEP_BY_STEP_DEBUG", "SEMI_AUTO", "FULL_AUTO"] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

// Human readable role names used in cards, logs and prompts.
// Record over SlpRole forces a label whenever a role is added.
export const ROLE_LABELS: Record<SlpRole, string> = {
  supervisor: "Supervisor",
  master_lead: "Master Lead",
  forked_lead: "Forked Lead",
  peer: "Peer",
};
