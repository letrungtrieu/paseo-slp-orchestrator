// Paseo owns this host-wide document so every project and connected client shares the same SLP defaults.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { RunModeSchema } from "./roles";
import { OrchestrationSettingsSchema } from "./orchestration";

export const PROVIDER_ROLES = ["supervisor", "lead", "peer"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

const RoleProviderSelectionSchema = z.object({
  // Null is uninitialized (or unsupported); the client pins visible catalog defaults once discovery finishes.
  providerModel: z.string().nullable().default(null),
  thinkingOptionId: z.string().nullable().default(null),
  permissionModeId: z.string().nullable().default(null),
});
export type RoleProviderSelection = z.infer<typeof RoleProviderSelectionSchema>;
export type RoleProviderSelections = Record<ProviderRole, RoleProviderSelection>;

export const ShellWatchdogSettingsSchema = z.object({
  // Enabled by default so hung peer shell commands are surfaced to their Forked Lead automatically.
  enabled: z.boolean().default(true),
  // Seconds a running peer shell tool call can produce zero new output before alerting the Forked Lead.
  idleTimeoutSeconds: z.number().int().min(15).max(3600).default(90),
});
export type ShellWatchdogSettings = z.infer<typeof ShellWatchdogSettingsSchema>;

export const SlpSettingsSchema = z.object({
  // New installations run autonomously; an explicit mode choice is remembered for later runs.
  mode: RunModeSchema.default("FULL_AUTO"),
  roles: z.object({
    supervisor: RoleProviderSelectionSchema.prefault({}),
    lead: RoleProviderSelectionSchema.prefault({}),
    peer: RoleProviderSelectionSchema.prefault({}),
  }).prefault({}),
  // Heartbeat watchdog configuration for detecting silent/hung peer shell commands without burning model tokens.
  shellWatchdog: ShellWatchdogSettingsSchema.prefault({}),
  // Peer forking and the rework cap are snapshotted into each run when it starts.
  orchestration: OrchestrationSettingsSchema.prefault({}),
});
export type SlpSettings = z.infer<typeof SlpSettingsSchema>;

export const slpSettings = defineSettings({
  id: "slp",
  scope: "host",
  version: 1,
  // Shared validation keeps native settings storage and both client surfaces on the same contract.
  schema: SlpSettingsSchema,
});
export const DEFAULT_SLP_SETTINGS = SlpSettingsSchema.parse({});

