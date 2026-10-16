import { useMemo } from "react";
import { Text, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import type { UiStyles } from "../styles";
import { ActionButton } from "./action-button";
import { SelectField } from "./select-field";

interface RepositoryFolderPickerProps {
  styles: UiStyles;
  theme: PluginTheme;
  selectedRepositoryPath: string;
  onSelectRepositoryPath: (folderPath: string) => void;
}

// The plugin API lists Paseo projects but cannot open the app's native folder dialog.
export function RepositoryFolderPicker({
  styles,
  theme,
  selectedRepositoryPath,
  onSelectRepositoryPath,
}: RepositoryFolderPickerProps) {
  const paseo = usePaseo();
  const projectQuery = useQuery({
    // A stable key avoids another daemon request when only the run title or mode changes.
    queryKey: ["slp", "paseo-projects"],
    queryFn: () => paseo.projects.list(),
    // The explicit refresh button is the user's signal that they opened another folder in Paseo.
    staleTime: 60_000,
  });

  // Runs require git, so non-git folders that Paseo remembers are not offered here.
  const repositoryOptions = useMemo(
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

  return (
    <View style={styles.stack}>
      <SelectField
        styles={styles}
        theme={theme}
        label="Repository folder"
        value={selectedRepositoryPath || null}
        options={repositoryOptions}
        placeholder={projectQuery.isLoading ? "Loading Paseo projects…" : "Select an open Paseo project"}
        onValueChange={onSelectRepositoryPath}
        disabled={projectQuery.isLoading}
      />
      {/* Project additions happen outside this plugin, so refresh is deliberate instead of continuous polling. */}
      <ActionButton
        styles={styles}
        label={projectQuery.isFetching ? "Refreshing projects…" : "Refresh project list"}
        disabled={projectQuery.isFetching}
        onPress={() => void projectQuery.refetch()}
      />
      {/* Do not turn an RPC failure into the misleading empty-project message below. */}
      {projectQuery.error ? (
        <Text style={styles.dangerText}>
          Could not load Paseo projects: {projectQuery.error.message}
        </Text>
      ) : null}
      {!projectQuery.isLoading && repositoryOptions.length === 0 ? (
        <Text style={styles.mutedText}>
          Open a git repository with Paseo’s Open Project Folder, then refresh this list.
        </Text>
      ) : null}
    </View>
  );
}
