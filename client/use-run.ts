import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  abortRunRpc,
  approveGateRpc,
  approvePipelineGateRpc,
  approveMainRpc,
  getRunRpc,
  listRunsRpc,
  resumeTaskRpc,
  setRunModeRpc,
  startRunRpc,
  tailLogRpc,
} from "../shared/rpc";

// Poll intervals follow the product brief: the run list is cheap and slow, the selected run
// and the log tail are what the operator is actively watching.
const RUN_LIST_POLL_MS = 3000;
const RUN_DETAIL_POLL_MS = 2000;
const LOG_TAIL_POLL_MS = 1500;
const LOG_TAIL_LIMIT = 200;

export function useRunList() {
  const listRuns = useRpc(listRunsRpc);
  // Polling instead of push: the daemon exposes request/response RPCs only, and the pipeline changes state from many places.
  return useQuery({
    // All keys start with "slp" so one invalidation of that prefix refreshes the list, the detail and the log together.
    queryKey: ["slp", "runs"],
    queryFn: () => listRuns({}),
    refetchInterval: RUN_LIST_POLL_MS,
  });
}

export function useRunDetail(selectedRunId: string | null) {
  const getRun = useRpc(getRunRpc);
  return useQuery({
    queryKey: ["slp", "run", selectedRunId],
    // `enabled` guards the null case, the fallback only satisfies the type.
    queryFn: () => getRun({ runId: selectedRunId ?? "" }),
    enabled: selectedRunId !== null,
    refetchInterval: RUN_DETAIL_POLL_MS,
  });
}

export function useLogTail(monitoredRunId: string | null) {
  const tailLog = useRpc(tailLogRpc);
  return useQuery({
    // The run id is part of the key so switching runs shows the cached tail of that run at once instead of the previous run's rows.
    queryKey: ["slp", "log", monitoredRunId],
    queryFn: () => tailLog({ runId: monitoredRunId ?? "", limit: LOG_TAIL_LIMIT }),
    enabled: monitoredRunId !== null,
    refetchInterval: LOG_TAIL_POLL_MS,
  });
}

// Every control action changes run state, so each mutation invalidates the run queries and
// the operator sees the effect immediately instead of waiting for the next poll tick.
export function useRunActions() {
  const queryClient = useQueryClient();
  const startRun = useRpc(startRunRpc);
  const setRunMode = useRpc(setRunModeRpc);
  const approveGate = useRpc(approveGateRpc);
  const approvePipelineGate = useRpc(approvePipelineGateRpc);
  const resumeTask = useRpc(resumeTaskRpc);
  const approveMain = useRpc(approveMainRpc);
  const abortRun = useRpc(abortRunRpc);
  // Invalidating the shared ["slp"] prefix is deliberately coarse: a gate approval can change the list badge, the task table and the log in one go.
  const refreshRuns = () => queryClient.invalidateQueries({ queryKey: ["slp"] });

  return {
    startRun: useMutation({ mutationFn: startRun, onSuccess: refreshRuns }),
    setRunMode: useMutation({ mutationFn: setRunMode, onSuccess: refreshRuns }),
    approveGate: useMutation({ mutationFn: approveGate, onSuccess: refreshRuns }),
    approvePipelineGate: useMutation({ mutationFn: approvePipelineGate, onSuccess: refreshRuns }),
    resumeTask: useMutation({ mutationFn: resumeTask, onSuccess: refreshRuns }),
    approveMain: useMutation({ mutationFn: approveMain, onSuccess: refreshRuns }),
    abortRun: useMutation({ mutationFn: abortRun, onSuccess: refreshRuns }),
  };
}

// Mutation errors are Error instances from the RPC bridge; anything else is stringified.
export function describeRpcError(failure: unknown): string | null {
  if (failure === null || failure === undefined) return null;
  return failure instanceof Error ? failure.message : String(failure);
}
