import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";
import { AgentDefaultSettings } from "./components/agent-default-settings";
import { useUiStyles } from "./styles";
import { useProviderCatalog } from "./use-provider-catalog";
import { useSlpSettings } from "./use-slp-settings";

export function SlpSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const styles = useUiStyles(theme, layout.compact);
  // Global settings use the host catalog; the run form resolves choices again in the selected project's context.
  const catalog = useProviderCatalog("");
  const settings = useSlpSettings(catalog);
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
      <AgentDefaultSettings styles={styles} theme={theme} catalog={catalog} settings={settings} />
    </ScrollView>
  );
}
