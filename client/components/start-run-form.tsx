// Focused "SLP" tab form for starting a new SLP run with only project selection and session name.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, View } from "react-native";
import type { ProviderRole } from "../../shared/settings";
import {
  resolvePermissionModeId,
  resolveProviderModel,
  resolveThinkingOptionId,
} from "../models/provider-selection";
import type { UiStyles } from "../styles";
import { useProjectPrompts } from "../use-project-prompts";
import { useProviderCatalog } from "../use-provider-catalog";
import { describeRpcError, useRunActions } from "../use-run";
import { useSlpSettings } from "../use-slp-settings";
import { ActionButton } from "./action-button";
import { LabeledInput } from "./labeled-input";
import { RepositoryFolderPicker } from "./repository-folder-picker";

interface StartRunFormProps {
  styles: UiStyles;
  theme: PluginTheme;
  onRunStarted: (startedRunId: string, supervisorAgentId: string) => void;
  selectedRepositoryPath?: string;
  onSelectRepositoryPath?: (nextRepositoryPath: string) => void;
  currentHost?: { id: string; label: string };
  selectedHostId?: string;
  onSelectHostId?: (nextHostId: string) => void;
}

export function StartRunForm({
  styles,
  theme,
  onRunStarted,
  selectedRepositoryPath,
  onSelectRepositoryPath,
  currentHost,
  selectedHostId,
  onSelectHostId,
}: StartRunFormProps) {
  const { startRun } = useRunActions();
  // Support controlled repository selection shared across tabs while keeping local state as a fallback.
  const [internalRepoPath, setInternalRepoPath] = useState("");
  const effectiveRepoPath = selectedRepositoryPath ?? internalRepoPath;
  const handleSelectRepoPath = onSelectRepositoryPath ?? setInternalRepoPath;

  const [runName, setRunName] = useState("");
  const providerCatalog = useProviderCatalog(effectiveRepoPath, selectedHostId);
  const settings = useSlpSettings(providerCatalog);
  const { roles: roleSelections } = settings.configuration;
  // Ensure role workflow prompts are initialized for the chosen repository before starting the run.
  const projectPrompts = useProjectPrompts(effectiveRepoPath);

  // Resolve the catalog defaults configured in the Settings tab so submitted run options match persisted agent defaults.
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
    supervisor: resolvePermissionModeId(
      roleSelections.supervisor,
      roleProviderModels.supervisor,
      providerCatalog.permissionModesByProvider,
    ),
    lead: resolvePermissionModeId(
      roleSelections.lead,
      roleProviderModels.lead,
      providerCatalog.permissionModesByProvider,
    ),
    peer: resolvePermissionModeId(
      roleSelections.peer,
      roleProviderModels.peer,
      providerCatalog.permissionModesByProvider,
    ),
  };

  // Trimmed here because a pasted path often carries a trailing newline that git would reject.
  // Omit baseBranch and force FULL_AUTO so the daemon auto-detects the project's checked-out branch and runs autonomously.
  const submitRun = () => {
    startRun.mutate(
      {
        repoPath: effectiveRepoPath.trim(),
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
  const startErrorMessage =
    describeRpcError(startRun.error) ?? describeRpcError(projectPrompts.error);
  const isStartDisabled =
    !settings.isEditable ||
    effectiveRepoPath.trim() === "" ||
    runName.trim() === "" ||
    providerCatalog.isPending ||
    providerCatalog.modelChoices.length === 0 ||
    projectPrompts.isFetching ||
    projectPrompts.isPending ||
    projectPrompts.isError ||
    startRun.isPending;

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Start SLP</Text>
      <RepositoryFolderPicker
        styles={styles}
        theme={theme}
        selectedRepositoryPath={effectiveRepoPath}
        onSelectRepositoryPath={handleSelectRepoPath}
        currentHost={currentHost}
        selectedHostId={selectedHostId}
        onSelectHostId={onSelectHostId}
      />
      <LabeledInput
        styles={styles}
        theme={theme}
        label="Name"
        value={runName}
        onChangeText={setRunName}
      />
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
