// React Query hooks for polling the project Kanban board and saving human Spec edits from the UI.
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listBoardTicketsRpc, saveBoardSpecFromUiRpc } from "../shared/rpc";

// Poll at 2 s so realtime agent badges, Lead pause states and Brief bullet scores update live on the board.
const BOARD_POLL_INTERVAL_MS = 2_000;

export function useBoardTickets(params: { repoPath?: string | null; runId?: string | null }) {
  const listBoardTickets = useRpc(listBoardTicketsRpc);
  const effectiveRepoPath = params.repoPath?.trim() || undefined;
  const effectiveRunId = params.runId?.trim() || undefined;
  const isQueryEnabled = Boolean(effectiveRepoPath || effectiveRunId);

  return useQuery({
    // Shares the ["slp"] root key so run or board mutations refresh both views together.
    queryKey: ["slp", "board", effectiveRepoPath ?? "", effectiveRunId ?? ""],
    queryFn: () => listBoardTickets({ repoPath: effectiveRepoPath, runId: effectiveRunId }),
    enabled: isQueryEnabled,
    refetchInterval: BOARD_POLL_INTERVAL_MS,
  });
}

export function useBoardActions() {
  const queryClient = useQueryClient();
  const saveBoardSpecFromUi = useRpc(saveBoardSpecFromUiRpc);
  // Invalidate all ["slp"] queries so the Kanban card, diff viewer and Supervisor mailbox reflect the new Spec revision immediately.
  const refreshBoardAndRuns = () => queryClient.invalidateQueries({ queryKey: ["slp"] });

  return {
    saveBoardSpec: useMutation({
      mutationFn: saveBoardSpecFromUi,
      onSuccess: refreshBoardAndRuns,
    }),
  };
}
