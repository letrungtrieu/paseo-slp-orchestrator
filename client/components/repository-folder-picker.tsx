// Host and Git repository folder picker that queries open Paseo projects scoped to the selected host.
import type { PluginTheme } from "@getpaseo/plugin";
import { getPaseoClient, useHosts, usePaseo } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { UiStyles } from "../styles";
import { SelectField, type SelectOption } from "./select-field";

interface RepositoryFolderPickerProps {
  styles: UiStyles;
  theme: PluginTheme;
  selectedRepositoryPath: string;
  onSelectRepositoryPath: (folderPath: string) => void;
  currentHost?: { id: string; label: string };
  selectedHostId?: string;
  onSelectHostId?: (nextHostId: string) => void;
}

// Allows selecting a configured Paseo host first and then picking one of that host's open Git repositories.
export function RepositoryFolderPicker({
  styles,
  theme,
  selectedRepositoryPath,
  onSelectRepositoryPath,
  currentHost,
  selectedHostId,
  onSelectHostId,
}: RepositoryFolderPickerProps) {
  const defaultPaseo = usePaseo();
  const configuredHosts = useHosts();
  const queryClient = useQueryClient();

  // Default to the current screen's host or the first online host when no explicit host selection has been made yet.
  const defaultHostId =
    currentHost?.id ||
    configuredHosts.find((hostEntry) => hostEntry.status === "online")?.serverId ||
    configuredHosts[0]?.serverId ||
    "local";

  const [internalHostId, setInternalHostId] = useState<string>(defaultHostId);
  const effectiveHostId = selectedHostId || internalHostId || defaultHostId;
  const updateSelectedHostId = onSelectHostId ?? setInternalHostId;

  // Build dropdown options from live configured hosts, falling back to the surface's active host if useHosts is empty.
  const hostOptions = useMemo<SelectOption[]>(() => {
    if (configuredHosts.length === 0) {
      return [
        {
          value: currentHost?.id || "local",
          label: currentHost?.label || "Local Host",
          detail: "Active Paseo host",
        },
      ];
    }
    return configuredHosts.map((hostSummary) => ({
      value: hostSummary.serverId,
      label: hostSummary.label,
      detail: `${hostSummary.status} · ${hostSummary.serverId}`,
    }));
  }, [configuredHosts, currentHost?.id, currentHost?.label]);

  const selectedHostSummary = configuredHosts.find(
    (hostSummary) => hostSummary.serverId === effectiveHostId,
  );
  const isSelectedHostOffline =
    selectedHostSummary !== undefined && selectedHostSummary.status !== "online";

  // Borrow the selected host's PaseoApi client when online; fall back to the surface's default Paseo client for the active host.
  const targetHostPaseoClient = useMemo(() => {
    if (!effectiveHostId || effectiveHostId === currentHost?.id) {
      return defaultPaseo;
    }
    try {
      return getPaseoClient(effectiveHostId);
    } catch {
      return defaultPaseo;
    }
  }, [currentHost?.id, defaultPaseo, effectiveHostId]);

  const projectQuery = useQuery({
    // Include effectiveHostId in the query key so switching hosts fetches that specific host's project list.
    queryKey: ["slp", "paseo-projects", effectiveHostId],
    queryFn: () => targetHostPaseoClient.projects.list(),
    enabled: !isSelectedHostOffline,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Subscribe to project list updates on the currently selected host so newly opened folders appear automatically.
  useEffect(() => {
    if (isSelectedHostOffline) return undefined;
    return targetHostPaseoClient.projects.subscribe(() => {
      void queryClient.invalidateQueries({
        queryKey: ["slp", "paseo-projects", effectiveHostId],
      });
    });
  }, [effectiveHostId, isSelectedHostOffline, queryClient, targetHostPaseoClient]);

  // Runs require git, so non-git folders that Paseo remembers are excluded from the repository picker.
  const repositoryOptions = useMemo<SelectOption[]>(
    () =>
      (projectQuery.data?.projects ?? [])
        .filter((project) => project.projectKind === "git")
        .map((project) => ({
          value: project.projectRootPath,
          // Paseo custom names are optional, while the path remains visible as disambiguating detail.
          label: project.projectCustomName || project.projectDisplayName,
          detail: project.projectRootPath,
        })),
    [projectQuery.data],
  );

  // Switching to another host clears the previous host's project path so only valid paths on the new host can be chosen.
  const handleHostChange = (nextHostId: string) => {
    if (nextHostId !== effectiveHostId) {
      onSelectRepositoryPath("");
    }
    updateSelectedHostId(nextHostId);
  };

  return (
    <View style={styles.stack}>
      {/* Side-by-side row: Repository folder on the left (auto-refreshes when opened), Host on the right. */}
      <View style={[styles.row, { alignItems: "flex-start", gap: 12 }]}>
        <SelectField
          styles={styles}
          theme={theme}
          label="Repository folder"
          value={selectedRepositoryPath || null}
          options={repositoryOptions}
          placeholder={
            isSelectedHostOffline
              ? "Selected host is offline"
              : projectQuery.isLoading
                ? "Loading Paseo projects…"
                : "Select an open Paseo project"
          }
          onValueChange={onSelectRepositoryPath}
          disabled={isSelectedHostOffline || projectQuery.isLoading}
          onOpenMenu={() => void projectQuery.refetch()}
        />

        <SelectField
          styles={styles}
          theme={theme}
          label="Host"
          value={effectiveHostId}
          options={hostOptions}
          placeholder="Select a Paseo host"
          onValueChange={handleHostChange}
        />
      </View>

      {isSelectedHostOffline ? (
        <Text style={styles.warningText}>
          Host &quot;{selectedHostSummary?.label ?? effectiveHostId}&quot; is currently{" "}
          {selectedHostSummary?.status}. Connect to this host to list its projects.
        </Text>
      ) : null}

      {/* Do not turn an RPC failure into the misleading empty-project message below. */}
      {projectQuery.error ? (
        <Text style={styles.dangerText}>
          Could not load Paseo projects: {projectQuery.error.message}
        </Text>
      ) : null}

      {!isSelectedHostOffline && !projectQuery.isLoading && repositoryOptions.length === 0 ? (
        <Text style={styles.mutedText}>
          Open a git repository on this host with Paseo’s Open Project Folder, then refresh this list.
        </Text>
      ) : null}
    </View>
  );
}
