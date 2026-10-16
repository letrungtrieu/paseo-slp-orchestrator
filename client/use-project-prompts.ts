import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { initializeProjectPromptsRpc } from "../shared/rpc";

export function useProjectPrompts(repositoryPath: string) {
  const initializePrompts = useRpc(initializeProjectPromptsRpc);
  // The picker supplies known projects; selecting one prepares editable files before the run starts.
  return useQuery({
    queryKey: ["slp", "project-prompts", repositoryPath],
    queryFn: () => initializePrompts({ repoPath: repositoryPath }),
    enabled: repositoryPath.trim() !== "",
    // Invalid YAML is an editing error, so surface its path immediately instead of repeatedly retrying it.
    retry: false,
    refetchOnWindowFocus: false,
  });
}
