// Waiting helpers. A single waitForFinish call returns early with "permission" when a prompt
// is pending, and the sweeper answers those prompts in the background, so keep waiting.
import type { PipelineContext } from "./context";

const WAIT_SLICE_MS = 30_000;

export async function waitUntilIdle(ctx: PipelineContext, agentId: string, totalTimeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const sliceResult = await ctx.gateway.waitForIdle(agentId, Math.min(WAIT_SLICE_MS, deadline - Date.now()));
    if (sliceResult.status === "idle") return true;
    // an errored turn leaves the agent usable; callers decide what to do with the failure
    if (sliceResult.status === "error") return false;
  }
  return false;
}
