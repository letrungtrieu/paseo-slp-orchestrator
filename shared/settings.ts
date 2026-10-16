// Paseo owns this host-wide document so every project and connected client shares the same SLP defaults.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { RunModeSchema } from "./roles";

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

export const SlpSettingsSchema = z.object({
  // New installations run autonomously; an explicit mode choice is remembered for later runs.
  mode: RunModeSchema.default("FULL_AUTO"),
  roles: z.object({
    supervisor: RoleProviderSelectionSchema.prefault({}),
    lead: RoleProviderSelectionSchema.prefault({}),
    peer: RoleProviderSelectionSchema.prefault({}),
  }).prefault({}),
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
