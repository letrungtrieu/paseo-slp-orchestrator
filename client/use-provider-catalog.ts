import { useMemo } from "react";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import { getPaseoClient, usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";

export interface ProviderModelChoice {
  value: string;
  label: string;
  detail: string;
  model: AgentModelDefinition;
}

export interface ProviderPermissionModeChoice {
  value: string;
  label: string;
  detail: string;
}

export interface ProviderPermissionCatalog {
  options: ProviderPermissionModeChoice[];
  fullAccessModeId: string | null;
  defaultModeId: string | null;
}

// Snapshot polling avoids the event wait helper's AbortSignal compatibility dependency in embedded runtimes.
async function loadReadyProviderSnapshot(
  paseo: ReturnType<typeof usePaseo>,
  repositoryPath: string,
  requestSignal: AbortSignal,
) {
  const startedAt = Date.now();
  const timeoutMs = 60_000;
  let providerSnapshot = await paseo.providers.snapshot({ cwd: repositoryPath || undefined });

  // Provider discovery may be lazy, so an initial loading snapshot is not treated as an empty catalog.
  while (providerSnapshot.entries.some((providerEntry) => providerEntry.status === "loading")) {
    if (requestSignal.aborted) {
      const cancellationError = new Error("Paseo provider catalog request was cancelled");
      cancellationError.name = "AbortError";
      throw cancellationError;
    }
    // Stop retrying at the same sixty-second limit used by Paseo's wait helper.
    if (Date.now() - startedAt >= timeoutMs) {
      const loadingProviders = providerSnapshot.entries
        .filter((providerEntry) => providerEntry.status === "loading")
        .map((providerEntry) => providerEntry.provider)
        .join(", ");
      throw new Error(`Timed out waiting for Paseo providers: ${loadingProviders}`);
    }

    // A short delay allows the daemon to finish discovery without requiring native event observation.
    await new Promise((resolve) => setTimeout(resolve, 500));
    providerSnapshot = await paseo.providers.snapshot({ cwd: repositoryPath || undefined });
  }

  return providerSnapshot;
}

// The daemon catalog matches the provider/model list used when creating a chat agent.
export function useProviderCatalog(repositoryPath: string, selectedHostId?: string) {
  const defaultPaseo = usePaseo();
  // Resolve the selected host's PaseoApi client when available, falling back to the current surface's Paseo client.
  const targetPaseo = useMemo(() => {
    if (!selectedHostId) return defaultPaseo;
    try {
      return getPaseoClient(selectedHostId);
    } catch {
      return defaultPaseo;
    }
  }, [defaultPaseo, selectedHostId]);

  const catalogQuery = useQuery({
    // Catalogs can depend on both the target host and workspace context, so include both in the cache key.
    queryKey: ["slp", "provider-catalog", selectedHostId ?? "default", repositoryPath],
    queryFn: ({ signal }) => loadReadyProviderSnapshot(targetPaseo, repositoryPath, signal),
    // Polling prevents a transient empty menu while Paseo is still discovering providers.
    staleTime: 5 * 60_000,
  });

  // Unavailable providers and hidden models must not appear as choices the daemon will reject.
  const modelChoices = useMemo<ProviderModelChoice[]>(() => {
    const readyProviders = (catalogQuery.data?.entries ?? []).filter(
      (providerEntry) => providerEntry.enabled && providerEntry.status === "ready",
    );
    return readyProviders.flatMap((providerEntry) =>
      (providerEntry.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          // Paseo agent creation expects the provider and model joined by the first slash.
          value: `${providerEntry.provider}/${model.id}`,
          label: model.label,
          detail: `${providerEntry.label ?? providerEntry.provider} · ${providerEntry.provider}/${model.id}`,
          model,
        })),
    );
  }, [catalogQuery.data]);

  // Provider modes have different IDs, so use Paseo's manifest to identify its unattended mode safely.
  const permissionModesByProvider = useMemo<Record<string, ProviderPermissionCatalog>>(() => {
    const readyProviders = (catalogQuery.data?.entries ?? []).filter(
      (providerEntry) => providerEntry.enabled && providerEntry.status === "ready",
    );
    return Object.fromEntries(readyProviders.map((providerEntry): [string, ProviderPermissionCatalog] => {
      const providerModes = providerEntry.modes ?? [];
      const manifestFullAccessModeId = getUnattendedModeId(providerEntry.provider);
      const fullAccessModeId = providerModes.find((providerMode) => providerMode.id === manifestFullAccessModeId)?.id ??
        providerModes.find((providerMode) => /full[\s_-]?access|bypass|allow[\s_-]?all|yolo/i.test(`${providerMode.id} ${providerMode.label}`))?.id ??
        null;
      return [providerEntry.provider, {
        options: providerModes.map((providerMode) => ({
          value: providerMode.id,
          label: providerMode.id === fullAccessModeId ? "Full Access" : providerMode.label,
          detail: [providerMode.description, providerMode.id].filter(Boolean).join(" · "),
        })),
        fullAccessModeId,
        defaultModeId: providerEntry.defaultModeId ?? null,
      }];
    }));
  }, [catalogQuery.data]);

  return { ...catalogQuery, modelChoices, permissionModesByProvider };
}
