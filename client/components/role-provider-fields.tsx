import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentSelectOption } from "@getpaseo/protocol/agent-types";
import type { UiStyles } from "../styles";
import type { ProviderModelChoice, ProviderPermissionCatalog } from "../use-provider-catalog";
import { SelectField, type SelectOption } from "./select-field";
import { PROVIDER_ROLES, type ProviderRole, type RoleProviderSelection, type RoleProviderSelections } from "../../shared/settings";
import {
  buildModelSelectOptions,
  resolvePermissionModeId,
  resolveProviderModel,
  resolveThinkingOptionId,
} from "../models/provider-selection";

const ROLE_LABELS: Record<ProviderRole, string> = {
  supervisor: "Supervisor",
  lead: "Lead",
  peer: "Peers",
};

interface RoleProviderFieldsProps {
  styles: UiStyles;
  theme: PluginTheme;
  modelChoices: readonly ProviderModelChoice[];
  permissionModesByProvider: Record<string, ProviderPermissionCatalog>;
  selections: RoleProviderSelections;
  isLoading: boolean;
  onSelectionChange: (role: ProviderRole, selection: RoleProviderSelection) => void;
}

export function RoleProviderFields({
  styles,
  theme,
  modelChoices,
  permissionModesByProvider,
  selections,
  isLoading,
  onSelectionChange,
}: RoleProviderFieldsProps) {
  // The parent owns these values because the Start run action must submit the exact visible selections.
  return (
    <View style={styles.stack}>
      <Text style={styles.sectionTitle}>Agent settings</Text>
      {/* Fixed role order follows the pipeline so users can compare shared role settings quickly. */}
      {PROVIDER_ROLES.map((providerRole) => (
        <RoleProviderField
          key={providerRole}
          role={providerRole}
          styles={styles}
          theme={theme}
          modelChoices={modelChoices}
          permissionModesByProvider={permissionModesByProvider}
          selection={selections[providerRole]}
          isLoading={isLoading}
          onSelectionChange={onSelectionChange}
        />
      ))}
    </View>
  );
}

interface RoleProviderFieldProps extends Omit<RoleProviderFieldsProps, "selections"> {
  role: ProviderRole;
  selection: RoleProviderSelection;
}

function RoleProviderField({
  role,
  styles,
  theme,
  modelChoices,
  permissionModesByProvider,
  selection,
  isLoading,
  onSelectionChange,
}: RoleProviderFieldProps) {
  // The selected model owns the thinking choices; unrelated provider options must never be mixed in.
  const selectedModel = resolveProviderModel(selection, modelChoices);
  // A model with no list lets its own provider configuration determine the reasoning behavior.
  const thinkingOptions = selectedModel?.model.thinkingOptions ?? [];
  const selectedThinkingOptionId = resolveThinkingOptionId(selection, selectedModel);
  const selectedPermissionModeId = resolvePermissionModeId(selection, selectedModel, permissionModesByProvider);
  const providerPermissionOptions = selectedModel
    ? permissionModesByProvider[selectedModel.model.provider]?.options ?? []
    : [];
  // Expose provider ID, model ID and aliases as search keywords and render the `Provider · provider/model` subtitle.
  const modelSelectOptions = buildModelSelectOptions(modelChoices);
  // Use Paseo's option labels so saved thinking IDs match the chat model's supported settings.
  const thinkingSelectOptions: SelectOption[] = thinkingOptions.map((thinkingOption: AgentSelectOption) => ({
    value: thinkingOption.id,
    label: thinkingOption.label,
    detail: thinkingOption.description,
  }));
  // Keep catalog details available for model search without displaying explanatory lines in the compact controls.
  const permissionSelectOptions: SelectOption[] = providerPermissionOptions.map((permissionMode) => ({
    value: permissionMode.value,
    label: permissionMode.label,
    detail: permissionMode.detail,
  }));

  return (
    <View style={styles.providerRoleCard}>
      <Text style={styles.bodyText}>{ROLE_LABELS[role]}</Text>
      <View style={styles.providerSettingsRow}>
        <View style={styles.providerSettingColumn}>
          {/* A role may fall back to Paseo's default model until the user chooses another one. */}
          <SelectField
            styles={styles}
            theme={theme}
            dense
            showDetails
            label="Model"
            value={selectedModel?.value ?? null}
            options={modelSelectOptions}
            placeholder={isLoading ? "Loading Paseo models…" : "No models available"}
            searchable
            searchPlaceholder="Search model, provider, or ID (e.g. codex/gpt-6-luna)…"
            disabled={isLoading}
            onValueChange={(providerModel) =>
              // Model changes invalidate reasoning IDs; permission mode survives only within the same provider.
              onSelectionChange(role, {
                providerModel,
                thinkingOptionId: null,
                permissionModeId: selectedModel?.model.provider === providerModel.split("/", 1)[0]
                  ? selectedPermissionModeId
                  : null,
              })
            }
          />
        </View>
        <View style={styles.providerSettingColumn}>
          {/* Models without thinking controls remain visible but disabled in this aligned row. */}
          <SelectField
            styles={styles}
            theme={theme}
            dense
            showDetails={false}
            label="Thinking"
            value={selectedThinkingOptionId}
            options={thinkingSelectOptions}
            placeholder={thinkingOptions.length === 0 ? "Not supported" : "Paseo default"}
            disabled={isLoading || thinkingOptions.length === 0}
            onValueChange={(thinkingOptionId) =>
              onSelectionChange(role, { ...selection, thinkingOptionId })
            }
          />
        </View>
        <View style={styles.providerSettingColumn}>
          {/* Providers expose different native mode IDs, so only their catalog choices are submitted. */}
          <SelectField
            styles={styles}
            theme={theme}
            dense
            showDetails={false}
            label="Permission"
            value={selectedPermissionModeId}
            options={permissionSelectOptions}
            placeholder={permissionSelectOptions.length === 0 ? "Provider default" : "Full Access"}
            disabled={isLoading || permissionSelectOptions.length === 0}
            onValueChange={(permissionModeId) =>
              onSelectionChange(role, { ...selection, permissionModeId })
            }
          />
        </View>
      </View>
    </View>
  );
}
