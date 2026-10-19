import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import type { RunMode } from "../shared/roles";
import {
  DEFAULT_SLP_SETTINGS,
  slpSettings,
  type ProviderRole,
  type RoleProviderSelection,
  type ShellWatchdogSettings,
  type SlpSettings,
} from "../shared/settings";
import type { useProviderCatalog } from "./use-provider-catalog";
import { materializeRoleDefaults, resolveRoleProviderSelection } from "./models/provider-selection";

export function useSlpSettings(catalog: ReturnType<typeof useProviderCatalog>) {
  const settings = useSettings(slpSettings);
  const writeInFlight = useRef(false);
  const isReady = settings.status === "ready";
  const revision = isReady ? settings.revision : null;
  const configuration = isReady ? settings.values : DEFAULT_SLP_SETTINGS;
  const error = settings.status === "error" || settings.status === "invalid" ? settings.error : settings.saveError;
  const catalogIsReady = !catalog.isPending && !catalog.isError && catalog.modelChoices.length > 0;
  const completedRoles = catalogIsReady
    ? materializeRoleDefaults(configuration.roles, catalog.modelChoices, catalog.permissionModesByProvider)
    : configuration.roles;
  // Wait for concrete defaults to save before the user can start a run or submit another settings revision.
  const isEditable = isReady && !settings.saving && completedRoles === configuration.roles && !error;

  function saveConfiguration(nextConfiguration: SlpSettings): void {
    // Native save checks the displayed revision, preventing another client's choices from being silently replaced.
    if (settings.status !== "ready" || settings.saving || writeInFlight.current) return;
    writeInFlight.current = true;
    void settings.save(nextConfiguration, settings.revision).finally(() => { writeInFlight.current = false; });
  }

  useEffect(() => {
    if (settings.status !== "ready" || settings.saving || settings.saveError || completedRoles === configuration.roles) return;
    // A visible catalog fallback is a real default: store it once instead of leaving all three roles as null.
    saveConfiguration({ ...configuration, roles: completedRoles });
  }, [settings.status, settings.saving, settings.saveError, revision, completedRoles, configuration]);

  return {
    configuration, isReady, isEditable, error,
    reload: settings.reload,
    changeMode: (mode: RunMode) => saveConfiguration({ ...configuration, mode }),
    changeRoleSelection: (role: ProviderRole, selection: RoleProviderSelection) => {
      // Every edit saves the effective model, thinking and permission together rather than a partial null selection.
      const resolvedSelection = resolveRoleProviderSelection(selection, catalog.modelChoices, catalog.permissionModesByProvider);
      saveConfiguration({ ...configuration, roles: { ...configuration.roles, [role]: resolvedSelection } });
    },
    changeShellWatchdog: (shellWatchdog: ShellWatchdogSettings) => {
      // Persist the shell heartbeat timeout immediately so running sweepers pick up the updated threshold.
      saveConfiguration({ ...configuration, shellWatchdog });
    },
  };
}

