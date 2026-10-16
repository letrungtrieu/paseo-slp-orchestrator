// Role vocabulary shared by the daemon-side orchestrator and the app UI.
// Keeping it in shared/ guarantees both runtimes agree on role names and limits.
import { z } from "zod";

// Order is the pipeline's order of appearance; the const tuple feeds both the zod enum and the label table so they cannot drift.
export const SLP_ROLES = [
  "supervisor",
  "master_lead",
  "forked_lead",
  "implementer",
  "qa",
  "security",
  "doc",
] as const;
export const SlpRoleSchema = z.enum(SLP_ROLES);
export type SlpRole = z.infer<typeof SlpRoleSchema>;

// Peers that inspect finished work; the pipeline wakes them during the verification stage.
export const VERIFIER_ROLES = ["qa", "security"] as const;
export const VerifierRoleSchema = z.enum(VERIFIER_ROLES);
export type VerifierRole = z.infer<typeof VerifierRoleSchema>;

// Name under which the plugin-hosted MCP server is registered inside every agent session.
export const BUS_SERVER_NAME = "slp-bus";

// Spec section 4, rule 3: more than three rejected rounds trips the circuit breaker.
// Counted in rejected rounds: the breaker trips on the round after this limit, matching spec rule 3 ('more than three').
export const FIX_LOOP_LIMIT = 3;

// Handshake clarification rounds before the Forked Lead must escalate to the Master Lead.
// Bounded so a Forked Lead and Implementer cannot loop on wording forever; the last unresolved round becomes an escalation.
export const HANDSHAKE_ROUND_LIMIT = 4;

// Scope violations tolerated per task before the pipeline pauses and calls for a human.
export const SCOPE_VIOLATION_LIMIT = 3;

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
  implementer: "Implementer",
  qa: "QA Peer",
  security: "Security Peer",
  doc: "Doc Peer",
};
