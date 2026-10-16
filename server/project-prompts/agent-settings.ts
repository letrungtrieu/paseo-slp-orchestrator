// Project files override individual model settings while the SLP form remains the fallback for each unset field.
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import type { SlpRole } from "../../shared/roles";
import type { ProjectPromptConfig } from "../../shared/project-prompts";
import type { ProviderChoices } from "../../shared/state";
import { defaultProjectPrompts, peerRole } from "./defaults";

export interface AgentModelSettings {
  provider: string;
  thinkingOptionId?: string;
  permissionModeId?: string;
}

export function resolveAgentSettings(
  configuration: ProjectPromptConfig | null | undefined, role: SlpRole,
  projectRoleId: string | undefined, defaults: AgentModelSettings,
): AgentModelSettings {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const definition = role === "supervisor" ? projectPrompts.supervisor
    : role === "master_lead" || role === "forked_lead" ? projectPrompts.lead
    : peerRole(projectPrompts, projectRoleId ?? role);
  const defaultProviderId = defaults.provider.split("/", 1)[0];
  // Full provider/model IDs can switch providers; a short model ID keeps the provider selected in the form.
  const provider = definition.model
    ? definition.model.includes("/") ? definition.model : `${defaultProviderId}/${definition.model}`
    : defaults.provider;
  const selectedProviderId = provider.split("/", 1)[0];
  let permissionModeId = defaults.permissionModeId;
  if (selectedProviderId !== defaultProviderId) {
    // Native permission IDs differ by provider. Preserve Full Access intent without passing another provider's ID.
    if (permissionModeId && permissionModeId !== getUnattendedModeId(defaultProviderId)) {
      throw new Error(`${definition.sourcePath}: model switches to '${selectedProviderId}', but permission mode '${permissionModeId}' belongs to '${defaultProviderId}'. Select compatible provider permissions in SLP.`);
    }
    permissionModeId = getUnattendedModeId(selectedProviderId);
  }
  return { provider, permissionModeId,
    // Resolve independently: setting just thinking must not replace the chosen model, and vice versa.
    thinkingOptionId: definition.thinking ?? defaults.thinkingOptionId };
}

export function validateProjectAgentSettings(configuration: ProjectPromptConfig, providers: ProviderChoices): void {
  const supervisorDefaults = { provider: providers.supervisor, thinkingOptionId: providers.supervisorThinkingOptionId ?? undefined,
    permissionModeId: providers.supervisorPermissionModeId ?? undefined };
  const leadDefaults = { provider: providers.lead, thinkingOptionId: providers.leadThinkingOptionId ?? undefined,
    permissionModeId: providers.leadPermissionModeId ?? undefined };
  const peerDefaults = { provider: providers.peer, thinkingOptionId: providers.peerThinkingOptionId ?? undefined,
    permissionModeId: providers.peerPermissionModeId ?? undefined };
  // Catch incompatible provider permission overrides before a run creates any worktree or session.
  resolveAgentSettings(configuration, "supervisor", undefined, supervisorDefaults);
  resolveAgentSettings(configuration, "master_lead", undefined, leadDefaults);
  for (const peer of configuration.peers) resolveAgentSettings(configuration, "peer", peer.role, peerDefaults);
}
