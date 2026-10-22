import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { ProviderRole } from "../../shared/settings";
import { describeRpcError, useRunActions } from "../use-run";
import { useProviderCatalog } from "../use-provider-catalog";
import { useProjectPrompts } from "../use-project-prompts";
import { useSlpSettings } from "../use-slp-settings";
import type { UiStyles } from "../styles";
import { ActionButton } from "./action-button";
import { LabeledInput } from "./labeled-input";
import { AgentDefaultSettings } from "./agent-default-settings";
import { RepositoryFolderPicker } from "./repository-folder-picker";
import { SlpSkillInitializer } from "./slp-skill-initializer";
import { resolvePermissionModeId, resolveProviderModel, resolveThinkingOptionId } from "../models/provider-selection";

interface StartRunFormProps {
  styles: UiStyles;
  theme: PluginTheme;
  onRunStarted: (startedRunId: string, supervisorAgentId: string) => void;
}

export function StartRunForm({ styles, theme, onRunStarted }: StartRunFormProps) {
  const { startRun } = useRunActions();
  // Project and session fields belong to this run; reusable agent defaults come from Paseo settings.
  const [repoPath, setRepoPath] = useState("");
  const [runName, setRunName] = useState("");
  const providerCatalog = useProviderCatalog(repoPath);
  const settings = useSlpSettings(providerCatalog);
  const { roles: roleSelections } = settings.configuration;
  const projectPrompts = useProjectPrompts(repoPath);

  // Resolve the catalog defaults once so the visible selection and submitted settings cannot diverge.
  const providerModelForRole = (providerRole: ProviderRole) =>
    resolveProviderModel(roleSelections[providerRole], providerCatalog.modelChoices);
  const roleProviderModels = {
    supervisor: providerModelForRole("supervisor"),
    lead: providerModelForRole("lead"),
    peer: providerModelForRole("peer"),
  };
  const roleThinkingOptionIds = {
    supervisor: resolveThinkingOptionId(roleSelections.supervisor, roleProviderModels.supervisor),
    lead: resolveThinkingOptionId(roleSelections.lead, roleProviderModels.lead),
    peer: resolveThinkingOptionId(roleSelections.peer, roleProviderModels.peer),
  };
  const rolePermissionModeIds = {
    supervisor: resolvePermissionModeId(roleSelections.supervisor, roleProviderModels.supervisor, providerCatalog.permissionModesByProvider),
    lead: resolvePermissionModeId(roleSelections.lead, roleProviderModels.lead, providerCatalog.permissionModesByProvider),
    peer: resolvePermissionModeId(roleSelections.peer, roleProviderModels.peer, providerCatalog.permissionModesByProvider),
  };

  // Trimmed here because a pasted path often carries a trailing newline that git would reject.
  // Omit baseBranch and force FULL_AUTO so the daemon auto-detects the project's checked-out branch and runs autonomously.
  const submitRun = () => {
    startRun.mutate(
      {
        repoPath: repoPath.trim(),
        name: runName.trim(),
        mode: "FULL_AUTO",
        supervisorProvider: roleProviderModels.supervisor?.value,
        leadProvider: roleProviderModels.lead?.value,
        peerProvider: roleProviderModels.peer?.value,
        supervisorThinkingOptionId: roleThinkingOptionIds.supervisor ?? undefined,
        leadThinkingOptionId: roleThinkingOptionIds.lead ?? undefined,
        peerThinkingOptionId: roleThinkingOptionIds.peer ?? undefined,
        supervisorPermissionModeId: rolePermissionModeIds.supervisor ?? undefined,
        leadPermissionModeId: rolePermissionModeIds.lead ?? undefined,
        peerPermissionModeId: rolePermissionModeIds.peer ?? undefined,
      },
      // The Supervisor is the human's control point; pass its id so the client can open that chat after creation.
      { onSuccess: (startedRun) => onRunStarted(startedRun.runId, startedRun.supervisorAgentId) },
    );
  };

  // Daemon-side failures (not a git repo, detached HEAD) arrive as thrown RPC errors and are shown inline under the button.
  const startErrorMessage = describeRpcError(startRun.error);
  const isStartDisabled =
    !settings.isEditable ||
    repoPath.trim() === "" ||
    runName.trim() === "" ||
    providerCatalog.isPending ||
    providerCatalog.modelChoices.length === 0 ||
    projectPrompts.isFetching || projectPrompts.isPending || projectPrompts.isError ||
    startRun.isPending;
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Start run</Text>
      <RepositoryFolderPicker
        styles={styles}
        theme={theme}
        selectedRepositoryPath={repoPath}
        onSelectRepositoryPath={setRepoPath}
      />
      {repoPath ? (
        <View style={styles.stack}>
          {/* Showing the path makes the generated configuration useful before the first agent is created. */}
          <Text style={styles.mutedText}>{projectPrompts.data
            ? `Role workflows: ${projectPrompts.data.directory} · ${projectPrompts.data.peers.length} peer roles`
            : projectPrompts.isError ? "Project role workflows need correction" : "Loading project role workflows..."}</Text>
          <ActionButton styles={styles} label={projectPrompts.isFetching ? "Loading workflows..." : "Reload role workflows"}
            disabled={projectPrompts.isFetching} onPress={() => { void projectPrompts.refetch(); }} />
          {/* Project-scoped skill initialization appears only after a repository is selected. */}
          <SlpSkillInitializer styles={styles} repoPath={repoPath} />
          {projectPrompts.error ? <Text style={styles.dangerText}>{describeRpcError(projectPrompts.error)}</Text> : null}
        </View>
      ) : null}
      <LabeledInput styles={styles} theme={theme} label="Name" value={runName} onChangeText={setRunName} />
      <AgentDefaultSettings styles={styles} theme={theme} catalog={providerCatalog} settings={settings} />
      <ActionButton
        styles={styles}
        tone="primary"
        label={startRun.isPending ? "Starting..." : "Start run"}
        accessibilityLabel="Start SLP run"
        // Missing project or model choices are blocked before a run can leave worktrees behind.
        disabled={isStartDisabled}
        onPress={submitRun}
      />
      {startErrorMessage ? <Text style={styles.dangerText}>{startErrorMessage}</Text> : null}
    </View>
  );
}
