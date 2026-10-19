import { PROVIDER_ROLES, type RoleProviderSelection, type RoleProviderSelections } from "../../shared/settings";
import type { ProviderModelChoice, ProviderPermissionCatalog } from "../use-provider-catalog";

// Paseo's default model is the safest initial choice; the first catalog model is a fallback for custom providers.
export function resolveProviderModel(
  roleSelection: RoleProviderSelection,
  availableModels: readonly ProviderModelChoice[],
): ProviderModelChoice | null {
  // Keep an explicit user choice only while Paseo still reports it as selectable.
  const selectedModel = availableModels.find(
    (modelChoice) => modelChoice.value === roleSelection.providerModel,
  );
  return selectedModel ?? availableModels.find((modelChoice) => modelChoice.model.isDefault) ?? availableModels[0] ?? null;
}

// A stale option from a previous model is ignored so agents never receive an invalid reasoning ID.
export function resolveThinkingOptionId(
  roleSelection: RoleProviderSelection,
  selectedModel: ProviderModelChoice | null,
): string | null {
  const thinkingOptions = selectedModel?.model.thinkingOptions ?? [];
  // A provider may remove a setting after catalog refresh, so stale IDs must fall through to a valid default.
  const chosenThinkingOption = thinkingOptions.find(
    (thinkingOption) => thinkingOption.id === roleSelection.thinkingOptionId,
  );
  if (chosenThinkingOption) return chosenThinkingOption.id;

  // A catalog refresh can change a default, so validate it against this model's current option list.
  const declaredDefaultId = selectedModel?.model.defaultThinkingOptionId;
  if (declaredDefaultId && thinkingOptions.some((thinkingOption) => thinkingOption.id === declaredDefaultId)) {
    return declaredDefaultId;
  }
  // If the model has options but no declared default, use its marked default instead of guessing by position.
  return thinkingOptions.find((thinkingOption) => thinkingOption.isDefault)?.id ?? null;
}

// Full access is the initial choice when the selected provider exposes an unattended permission mode.
export function resolvePermissionModeId(
  roleSelection: RoleProviderSelection,
  selectedModel: ProviderModelChoice | null,
  permissionModesByProvider: Record<string, ProviderPermissionCatalog>,
): string | null {
  const providerPermissions = selectedModel
    ? permissionModesByProvider[selectedModel.model.provider]
    : undefined;
  const availableModeIds = providerPermissions?.options.map((permissionMode) => permissionMode.value) ?? [];
  // Keep a saved choice only while it remains part of this provider's current mode list.
  if (roleSelection.permissionModeId && availableModeIds.includes(roleSelection.permissionModeId)) {
    return roleSelection.permissionModeId;
  }
  if (providerPermissions?.fullAccessModeId && availableModeIds.includes(providerPermissions.fullAccessModeId)) {
    return providerPermissions.fullAccessModeId;
  }
  // Providers without unattended mode support retain their declared default instead of receiving a guessed ID.
  if (providerPermissions?.defaultModeId && availableModeIds.includes(providerPermissions.defaultModeId)) {
    return providerPermissions.defaultModeId;
  }
  return availableModeIds[0] ?? null;
}

export function resolveRoleProviderSelection(
  selection: RoleProviderSelection, availableModels: readonly ProviderModelChoice[],
  permissionModesByProvider: Record<string, ProviderPermissionCatalog>,
): RoleProviderSelection {
  const selectedModel = resolveProviderModel(selection, availableModels);
  // Persist the whole visible choice together so a thinking/permission edit also pins its model.
  return {
    providerModel: selectedModel?.value ?? selection.providerModel,
    thinkingOptionId: resolveThinkingOptionId(selection, selectedModel),
    permissionModeId: resolvePermissionModeId(selection, selectedModel, permissionModesByProvider),
  };
}

export function materializeRoleDefaults(
  selections: RoleProviderSelections, availableModels: readonly ProviderModelChoice[],
  permissionModesByProvider: Record<string, ProviderPermissionCatalog>,
): RoleProviderSelections {
  let completedSelections = selections;
  for (const role of PROVIDER_ROLES) {
    const savedSelection = selections[role];
    const visibleSelection = resolveRoleProviderSelection(savedSelection, availableModels, permissionModesByProvider);
    // Project-specific catalogs may hide a globally selected model; never replace that saved preference on load.
    if (savedSelection.providerModel && savedSelection.providerModel !== visibleSelection.providerModel) continue;
    const completedSelection = {
      providerModel: savedSelection.providerModel ?? visibleSelection.providerModel,
      thinkingOptionId: savedSelection.thinkingOptionId ?? visibleSelection.thinkingOptionId,
      permissionModeId: savedSelection.permissionModeId ?? visibleSelection.permissionModeId,
    };
    if (completedSelection.providerModel === savedSelection.providerModel &&
        completedSelection.thinkingOptionId === savedSelection.thinkingOptionId &&
        completedSelection.permissionModeId === savedSelection.permissionModeId) continue;
    // Preserve identity for unchanged selections, allowing the controller to skip redundant settings writes.
    completedSelections = { ...completedSelections, [role]: completedSelection };
  }
  return completedSelections;
}

export interface SelectOption {
  value: string;
  label: string;
  detail?: string;
  keywords?: readonly string[];
}

// Keep provider label, `provider/model` code, raw model ID and aliases attached to each option
// so the modal displays the exact model code (e.g. `codex/gpt-6-luna`) and search matches any part of it.
export function buildModelSelectOptions(
  modelChoices: readonly ProviderModelChoice[],
): SelectOption[] {
  return modelChoices.map((modelChoice) => ({
    value: modelChoice.value,
    label: modelChoice.label,
    detail: modelChoice.detail,
    keywords: [
      modelChoice.model.provider,
      modelChoice.model.id,
      ...(modelChoice.model.aliases ?? []),
    ],
  }));
}

// Match every whitespace-separated search term against the combined label, `provider/model` code,
// detail line and aliases so queries like `codex/gpt-6-luna`, `gpt-6-luna` or `codex luna` all succeed.
export function filterSelectOptions(
  availableOptions: readonly SelectOption[],
  rawSearchQuery: string,
): readonly SelectOption[] {
  const searchTerms = rawSearchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (searchTerms.length === 0) return availableOptions;
  return availableOptions.filter((candidateOption) => {
    const searchableOptionText = [
      candidateOption.label,
      candidateOption.value,
      candidateOption.detail ?? "",
      ...(candidateOption.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return searchTerms.every((searchTerm) => searchableOptionText.includes(searchTerm));
  });
}

