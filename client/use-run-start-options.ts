// Resolves the Settings-tab role choices into Run options so every way of starting a Run submits the same configuration.
import type { ProviderRole } from "../shared/settings";
import {
  resolvePermissionModeId,
  resolveProviderModel,
  resolveThinkingOptionId,
} from "./models/provider-selection";
import { useProjectPrompts } from "./use-project-prompts";
import { useProviderCatalog } from "./use-provider-catalog";
import { describeRpcError } from "./use-run";
import { useSlpSettings } from "./use-slp-settings";

export function useRunStartOptions(repositoryPath: string, hostId?: string) {
  const providerCatalog = useProviderCatalog(repositoryPath, hostId);
  const settings = useSlpSettings(providerCatalog);
  const { roles: roleSelections } = settings.configuration;
  // Ensure role workflow prompts are initialized for the chosen repository before starting the run.
  const projectPrompts = useProjectPrompts(repositoryPath);

  // Resolve the catalog defaults configured in the Settings tab so submitted run options match persisted agent defaults.
  const providerModelForRole = (providerRole: ProviderRole) =>
    resolveProviderModel(roleSelections[providerRole], providerCatalog.modelChoices);
  const roleProviderModels = {
    supervisor: providerModelForRole("supervisor"),
    lead: providerModelForRole("lead"),
    peer: providerModelForRole("peer"),
  };
  // The Product Agent works before any Run, so a Run's submitted options only cover the three roles inside it.
  const permissionModeForRole = (providerRole: keyof typeof roleProviderModels) =>
    resolvePermissionModeId(
      roleSelections[providerRole],
      roleProviderModels[providerRole],
      providerCatalog.permissionModesByProvider,
    ) ?? undefined;

  // Omit baseBranch and force FULL_AUTO so the daemon auto-detects the project's checked-out branch and runs autonomously.
  const runInput = {
    mode: "FULL_AUTO" as const,
    supervisorProvider: roleProviderModels.supervisor?.value,
    leadProvider: roleProviderModels.lead?.value,
    peerProvider: roleProviderModels.peer?.value,
    supervisorThinkingOptionId:
      resolveThinkingOptionId(roleSelections.supervisor, roleProviderModels.supervisor) ?? undefined,
    leadThinkingOptionId:
      resolveThinkingOptionId(roleSelections.lead, roleProviderModels.lead) ?? undefined,
    peerThinkingOptionId:
      resolveThinkingOptionId(roleSelections.peer, roleProviderModels.peer) ?? undefined,
    supervisorPermissionModeId: permissionModeForRole("supervisor"),
    leadPermissionModeId: permissionModeForRole("lead"),
    peerPermissionModeId: permissionModeForRole("peer"),
  };

  // Missing project or model choices are blocked before a run can leave worktrees behind.
  const isReady =
    settings.isEditable &&
    repositoryPath.trim() !== "" &&
    !providerCatalog.isPending &&
    providerCatalog.modelChoices.length > 0 &&
    !projectPrompts.isFetching &&
    !projectPrompts.isPending &&
    !projectPrompts.isError;

  return {
    runInput,
    isReady,
    settings,
    promptsErrorMessage: describeRpcError(projectPrompts.error),
  };
}
