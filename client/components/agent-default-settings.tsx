import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { DEFAULT_SLP_SETTINGS } from "../../shared/settings";
import { OrchestrationSettingsFields } from "./orchestration-settings-fields";
import type { UiStyles } from "../styles";
import type { useProviderCatalog } from "../use-provider-catalog";
import type { useSlpSettings } from "../use-slp-settings";
import { ActionButton } from "./action-button";
import { RoleProviderFields } from "./role-provider-fields";
import { SelectField, type SelectOption } from "./select-field";

// Preset idle-output durations let users tune how long a peer shell can stay silent before alerting its Forked Lead.
const SHELL_WATCHDOG_OPTIONS: readonly SelectOption[] = [
  {
    value: "off",
    label: "Disabled",
    detail: "Do not monitor peer shell commands for stalled output",
  },
  {
    value: "30",
    label: "30 seconds",
    detail: "Alert Forked Lead after 30s of unchanged shell output",
  },
  {
    value: "60",
    label: "60 seconds",
    detail: "Alert Forked Lead after 60s of unchanged shell output",
  },
  {
    value: "90",
    label: "90 seconds (Default)",
    detail: "Alert Forked Lead after 90s of unchanged shell output",
  },
  {
    value: "120",
    label: "2 minutes (120s)",
    detail: "Alert Forked Lead after 120s of unchanged shell output",
  },
  {
    value: "180",
    label: "3 minutes (180s)",
    detail: "Alert Forked Lead after 180s of unchanged shell output",
  },
  {
    value: "300",
    label: "5 minutes (300s)",
    detail: "Alert Forked Lead after 300s of unchanged shell output",
  },
  {
    value: "600",
    label: "10 minutes (600s)",
    detail: "Alert Forked Lead after 600s of unchanged shell output",
  },
];

interface AgentDefaultSettingsProps {
  styles: UiStyles;
  theme: PluginTheme;
  catalog: ReturnType<typeof useProviderCatalog>;
  settings: ReturnType<typeof useSlpSettings>;
}

export function AgentDefaultSettings({ styles, theme, catalog, settings }: AgentDefaultSettingsProps) {
  // Both the run form and Paseo Settings edit the same document through the same controls; execution mode is always autonomous.
  const disabled = !settings.isEditable;
  const shellWatchdogSettings = settings.configuration.shellWatchdog ?? DEFAULT_SLP_SETTINGS.shellWatchdog;
  const selectedWatchdogValue = shellWatchdogSettings.enabled
    ? String(shellWatchdogSettings.idleTimeoutSeconds)
    : "off";
  // Preserve a custom numeric timeout in the dropdown if it was edited outside the preset list.
  const watchdogSelectOptions: SelectOption[] = SHELL_WATCHDOG_OPTIONS.some((option) => option.value === selectedWatchdogValue)
    ? [...SHELL_WATCHDOG_OPTIONS]
    : [
        ...SHELL_WATCHDOG_OPTIONS,
        {
          value: selectedWatchdogValue,
          label: `${shellWatchdogSettings.idleTimeoutSeconds} seconds`,
          detail: `Alert Forked Lead after ${shellWatchdogSettings.idleTimeoutSeconds}s of unchanged shell output`,
        },
      ];

  return (
    <View style={styles.stack}>
      <RoleProviderFields styles={styles} theme={theme} modelChoices={catalog.modelChoices}
        permissionModesByProvider={catalog.permissionModesByProvider} selections={settings.configuration.roles}
        isLoading={catalog.isPending || disabled} onSelectionChange={settings.changeRoleSelection} />
      <View style={styles.providerRoleCard}>
        <Text style={styles.bodyText}>Shell Watchdog & Heartbeat</Text>
        <SelectField
          styles={styles}
          theme={theme}
          dense
          label="Peer shell idle output timeout (alerts Forked Lead to cancel or wait)"
          value={selectedWatchdogValue}
          options={watchdogSelectOptions}
          placeholder="90 seconds (Default)"
          disabled={disabled}
          onValueChange={(nextWatchdogValue) => {
            if (nextWatchdogValue === "off") {
              settings.changeShellWatchdog({
                enabled: false,
                idleTimeoutSeconds: shellWatchdogSettings.idleTimeoutSeconds,
              });
              return;
            }
            const parsedTimeoutSeconds = Number.parseInt(nextWatchdogValue, 10);
            if (Number.isInteger(parsedTimeoutSeconds) && parsedTimeoutSeconds >= 15) {
              settings.changeShellWatchdog({
                enabled: true,
                idleTimeoutSeconds: parsedTimeoutSeconds,
              });
            }
          }}
        />
      </View>
      <OrchestrationSettingsFields styles={styles} theme={theme} disabled={disabled}
        orchestration={settings.configuration.orchestration ?? DEFAULT_SLP_SETTINGS.orchestration}
        onChange={settings.changeOrchestration} />
      {/* Only actionable failures add text; successful selections remain compact and save automatically. */}
      {settings.error ? (
        <View style={styles.stack}>
          <Text style={styles.dangerText}>{settings.error}</Text>
          <ActionButton styles={styles} label="Reload settings" onPress={() => { void settings.reload(); }} />
        </View>
      ) : null}
      {catalog.error ? <Text style={styles.dangerText}>{catalog.error.message}</Text> : null}
      {!catalog.isPending && catalog.modelChoices.length === 0
        ? <Text style={styles.warningText}>No Paseo models available.</Text> : null}
    </View>
  );
}

