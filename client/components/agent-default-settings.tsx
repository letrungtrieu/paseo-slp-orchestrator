import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { UiStyles } from "../styles";
import type { useProviderCatalog } from "../use-provider-catalog";
import type { useSlpSettings } from "../use-slp-settings";
import { ActionButton } from "./action-button";
import { RoleProviderFields } from "./role-provider-fields";

interface AgentDefaultSettingsProps {
  styles: UiStyles;
  theme: PluginTheme;
  catalog: ReturnType<typeof useProviderCatalog>;
  settings: ReturnType<typeof useSlpSettings>;
}

export function AgentDefaultSettings({ styles, theme, catalog, settings }: AgentDefaultSettingsProps) {
  // Both the run form and Paseo Settings edit the same document through the same controls; execution mode is always autonomous.
  const disabled = !settings.isEditable;
  return (
    <View style={styles.stack}>
      <RoleProviderFields styles={styles} theme={theme} modelChoices={catalog.modelChoices}
        permissionModesByProvider={catalog.permissionModesByProvider} selections={settings.configuration.roles}
        isLoading={catalog.isPending || disabled} onSelectionChange={settings.changeRoleSelection} />
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
