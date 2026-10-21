// Provides a project-scoped UI control to install or update the `slp-manager` skill inside
// the selected repository (<repoPath>/.agents/skills and <repoPath>/.claude/skills).
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { initSlpManagerSkillRpc } from "../../shared/rpc";
import type { UiStyles } from "../styles";
import { describeRpcError } from "../use-run";
import { ActionButton } from "./action-button";

interface SlpSkillInitializerProps {
  styles: UiStyles;
  repoPath: string;
}

export function SlpSkillInitializer({ styles, repoPath }: SlpSkillInitializerProps) {
  const invokeInitSkill = useRpc(initSlpManagerSkillRpc);
  // Explicit user-triggered mutation writes SKILL.md into the selected project's skill folders.
  const initSkillMutation = useMutation({
    mutationFn: (targetRepositoryPath: string) => invokeInitSkill({ repoPath: targetRepositoryPath }),
  });
  const resetMutationState = initSkillMutation.reset;

  // Switching to another repository clears the previous project's initialization banner.
  useEffect(() => {
    resetMutationState();
  }, [repoPath, resetMutationState]);

  const trimmedRepoPath = repoPath.trim();
  if (!trimmedRepoPath) return null;

  const errorMessage = describeRpcError(initSkillMutation.error);

  return (
    <View style={styles.stack}>
      {/* Allow operators to provision or refresh the slp-manager skill specifically for the selected project. */}
      <ActionButton
        styles={styles}
        label={initSkillMutation.isPending ? "Initializing skill slp-manager…" : "Init skill slp-manager"}
        accessibilityLabel="Init skill slp-manager"
        disabled={initSkillMutation.isPending}
        onPress={() => initSkillMutation.mutate(trimmedRepoPath)}
      />
      {initSkillMutation.data ? (
        // Confirm the exact skill name and project-local paths where providers load it from.
        <Text style={styles.successText}>
          Initialized skill {initSkillMutation.data.skillName}: {initSkillMutation.data.installedPaths.join(", ")}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text style={styles.dangerText}>
          Could not initialize skill slp-manager: {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}
