// Project files override individual model settings while the SLP form remains the fallback for each unset field.
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import type { SlpRole } from "../../shared/roles";
import type { ProjectPromptConfig } from "../../shared/project-prompts";
import type { ProviderChoices } from "../../shared/state";
import { defaultProjectPrompts, peerRole, qaLeadDefinition } from "./defaults";

export interface AgentModelSettings {
  provider: string;
  thinkingOptionId?: string;
  permissionModeId?: string;
}

export interface ProviderModelCatalogEntry {
  id: string;
  provider?: string;
  aliases?: readonly string[];
}

// Built-in plugin providers such as Antigravity declare unattended modes in their live catalog
// rather than @getpaseo/protocol's static manifest, so include their native full-access mode here.
export function unattendedModeForProvider(providerId: string): string | undefined {
  return getUnattendedModeId(providerId) ?? (providerId === "antigravity" ? "full-access" : undefined);
}

// Well-known model-id prefixes identify when a short model name in .slp/peers belongs to a foreign
// provider family (for example `gpt-5.4` under a `claude` base_peer) even before querying a live catalog.
function inferModelProviderFamily(shortModelId: string): string | null {
  const normalizedModelId = shortModelId.trim().toLowerCase();
  if (/^(?:claude(?:[-_.]|$)|sonnet(?:[-_.]|$)|opus(?:[-_.]|$)|haiku(?:[-_.]|$))/.test(normalizedModelId)) {
    return "claude";
  }
  if (/^(?:gpt[-_.]|o[134](?:[-_.]|$)|codex(?:[-_.]|$)|chatgpt[-_.])/.test(normalizedModelId)) {
    return "codex";
  }
  if (/^(?:gemini(?:[-_.]|$)|antigravity(?:[-_.]|$))/.test(normalizedModelId)) {
    return "antigravity";
  }
  return null;
}

// Stage peers fork from base_peer, so a peer model override is valid only when it belongs to
// base_peer's provider family and (when a provider model catalog is supplied) exists in that catalog.
function isModelSupportedByBaseProvider(
  candidateModelId: string,
  basePeerProviderId: string,
  availableProviderModels?: readonly ProviderModelCatalogEntry[],
): boolean {
  const normalizedCandidateId = candidateModelId.trim();
  if (!normalizedCandidateId) return false;
  if (normalizedCandidateId === "default") return true;

  const inferredProviderFamily = inferModelProviderFamily(normalizedCandidateId);
  // Kiro CLI exposes Claude model IDs (e.g. claude-sonnet-4.5) under the 'kiro' provider namespace.
  const acceptsClaudeFamilyModels =
    basePeerProviderId === "claude" || basePeerProviderId === "kiro" || basePeerProviderId === "kiro-cli";
  if (
    inferredProviderFamily &&
    inferredProviderFamily !== basePeerProviderId &&
    !(inferredProviderFamily === "claude" && acceptsClaudeFamilyModels)
  ) {
    return false;
  }

  if (!availableProviderModels || availableProviderModels.length === 0) {
    return true;
  }

  // Filter to catalog entries that either omit provider (already scoped) or match basePeerProviderId.
  const matchingProviderCatalog = availableProviderModels.filter(
    (catalogEntry) => !catalogEntry.provider || catalogEntry.provider === basePeerProviderId,
  );
  if (matchingProviderCatalog.length === 0) {
    return true;
  }

  const normalizedLookup = normalizedCandidateId.toLowerCase();
  const qualifiedLookup = `${basePeerProviderId}/${normalizedCandidateId}`.toLowerCase();
  return matchingProviderCatalog.some((catalogEntry) => {
    const entryIdLower = catalogEntry.id.toLowerCase();
    if (entryIdLower === normalizedLookup || entryIdLower === qualifiedLookup) return true;
    return Boolean(
      catalogEntry.aliases?.some((aliasName) => aliasName.toLowerCase() === normalizedLookup),
    );
  });
}

// Resolves a .slp/peers/*.md model string against base_peer's provider, returning null when the
// requested model belongs to another provider or cannot be found for base_peer's provider.
export function resolvePeerModelForBasePeerProvider(
  configuredPeerModel: string,
  basePeerProviderId: string,
  availableProviderModels?: readonly ProviderModelCatalogEntry[],
): string | null {
  const trimmedPeerModel = configuredPeerModel.trim();
  if (!trimmedPeerModel) return null;

  if (trimmedPeerModel.includes("/")) {
    const [explicitProviderId, ...remainingModelParts] = trimmedPeerModel.split("/");
    const explicitModelId = remainingModelParts.join("/").trim();
    // A peer file that names a different provider than base_peer cannot fork base_peer's session on that provider.
    if (explicitProviderId !== basePeerProviderId || !explicitModelId) {
      return null;
    }
    if (!isModelSupportedByBaseProvider(explicitModelId, basePeerProviderId, availableProviderModels)) {
      return null;
    }
    return `${basePeerProviderId}/${explicitModelId}`;
  }

  if (!isModelSupportedByBaseProvider(trimmedPeerModel, basePeerProviderId, availableProviderModels)) {
    return null;
  }
  return `${basePeerProviderId}/${trimmedPeerModel}`;
}

export function resolveAgentSettings(
  configuration: ProjectPromptConfig | null | undefined,
  role: SlpRole,
  projectRoleId: string | undefined,
  defaults: AgentModelSettings,
  availableProviderModels?: readonly ProviderModelCatalogEntry[],
): AgentModelSettings {
  const projectPrompts = configuration ?? defaultProjectPrompts();
  const defaultProviderId = defaults.provider.split("/", 1)[0];
  const defaultPermissionModeId = defaults.permissionModeId ?? unattendedModeForProvider(defaultProviderId);

  // Stage peers fork directly from their owning Lead in the shared worktree, so .slp/peers model
  // definitions depend on Lead's provider and fall back to global config when mismatched.
  if (role === "peer") {
    const peerDefinition = projectRoleId ? peerRole(projectPrompts, projectRoleId) : projectPrompts.peers[0];
    if (!peerDefinition) throw new Error("No project peer workflow is configured under .slp/peers");

    const leadSettings = resolveAgentSettings(
      projectPrompts,
      "master_lead",
      undefined,
      defaults,
      availableProviderModels,
    );
    const leadProviderId = leadSettings.provider.split("/", 1)[0];
    const globalFallbackSettings: AgentModelSettings = {
      provider: defaults.provider,
      permissionModeId: defaultPermissionModeId,
      thinkingOptionId: peerDefinition.thinking ?? defaults.thinkingOptionId,
    };

    if (!peerDefinition.model) {
      // When no model is set in .slp/peers/*.md, stay on Lead's provider if LEAD.md switched providers;
      // otherwise use the global config model directly.
      if (leadProviderId !== defaultProviderId) {
        return {
          provider: leadSettings.provider,
          permissionModeId: leadSettings.permissionModeId,
          thinkingOptionId: peerDefinition.thinking ?? leadSettings.thinkingOptionId,
        };
      }
      return globalFallbackSettings;
    }

    const matchedProviderModel = resolvePeerModelForBasePeerProvider(
      peerDefinition.model,
      leadProviderId,
      availableProviderModels,
    );
    if (!matchedProviderModel) {
      // Fallback to global config when the peer's model does not match or exist under Lead's provider.
      return globalFallbackSettings;
    }

    return {
      provider: matchedProviderModel,
      permissionModeId: leadSettings.permissionModeId,
      thinkingOptionId: peerDefinition.thinking ?? defaults.thinkingOptionId,
    };
  }

  // Root orchestration roles (supervisor and both Lead kinds) resolve directly against global defaults.
  const definition = role === "supervisor"
    ? projectPrompts.supervisor
    : role === "qa_lead" ? qaLeadDefinition(projectPrompts) : projectPrompts.lead;
  const effectiveModel = definition.model;
  const effectiveThinking = definition.thinking;
  const modelSourcePath = definition.sourcePath;
  // Full provider/model IDs can switch providers for root roles; a short model ID keeps the provider selected in the form.
  const provider = effectiveModel
    ? effectiveModel.includes("/") ? effectiveModel : `${defaultProviderId}/${effectiveModel}`
    : defaults.provider;
  const selectedProviderId = provider.split("/", 1)[0];
  // Missing legacy settings mean Full Access, matching the SLP global default.
  let permissionModeId = defaultPermissionModeId;
  if (selectedProviderId !== defaultProviderId) {
    const defaultUnattendedMode = unattendedModeForProvider(defaultProviderId);
    // Native permission IDs differ by provider. Preserve Full Access intent without passing another provider's ID.
    if (permissionModeId && defaultUnattendedMode && permissionModeId !== defaultUnattendedMode) {
      throw new Error(`${modelSourcePath}: model switches to '${selectedProviderId}', but permission mode '${permissionModeId}' belongs to '${defaultProviderId}'. Select compatible provider permissions in SLP.`);
    }
    permissionModeId = unattendedModeForProvider(selectedProviderId);
  }
  return {
    provider,
    permissionModeId,
    // Resolve independently: setting just thinking must not replace the chosen model, and vice versa.
    thinkingOptionId: effectiveThinking ?? defaults.thinkingOptionId,
  };
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
  // The QA Lead shares the Lead provider choices but may override its model in QA_LEAD.md.
  resolveAgentSettings(configuration, "qa_lead", undefined, leadDefaults);
  for (const peer of configuration.peers) resolveAgentSettings(configuration, "peer", peer.role, peerDefaults);
}
