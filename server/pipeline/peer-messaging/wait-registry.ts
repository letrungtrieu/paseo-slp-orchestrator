// In-process wake-up channel for agents blocked inside slp_ask / slp_await_answer. The SQLite ledger holds
// the truth; this only lets an answer reach a blocked agent immediately instead of on its next poll.

// Every blocking call must finish inside the shortest MCP tool timeout among supported providers
// (Codex defaults to 60 s), so a question is awaited in short windows and resumed with slp_await_answer.
export interface QuestionTiming {
  waitWindowMs: number;
  // Total lifetime of an unanswered question before the asker is told to proceed on an assumption.
  questionTtlMs: number;
  // Quiet time after delivery (or the previous reminder) before the recipient is reminded.
  reminderAfterMs: number;
  maxReminders: number;
  // A hard cap stops one confused agent from flooding the ledger and the recipients' inboxes.
  maxOpenQuestionsPerAsker: number;
}

export const DEFAULT_QUESTION_TIMING: QuestionTiming = {
  waitWindowMs: 40_000,
  questionTtlMs: 600_000,
  reminderAfterMs: 60_000,
  maxReminders: 2,
  maxOpenQuestionsPerAsker: 3,
};

export type WaitEnd = "wake" | "timeout" | "aborted";

interface ActiveWait {
  questionId: string;
  wake(): void;
}

export class WaitRegistry {
  private readonly waitsByAgent = new Map<string, Set<ActiveWait>>();

  // Registration happens synchronously inside the Promise executor. A caller that inspects the ledger and
  // then calls wait() in the same tick therefore cannot miss a wake-up that fires in between.
  wait(agentId: string, questionId: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<WaitEnd> {
    return new Promise<WaitEnd>((resolveWait) => {
      const agentWaits = this.waitsByAgent.get(agentId) ?? new Set<ActiveWait>();
      this.waitsByAgent.set(agentId, agentWaits);
      const finishWait = (waitEnd: WaitEnd) => {
        clearTimeout(timeoutTimer);
        abortSignal?.removeEventListener("abort", onAbort);
        agentWaits.delete(activeWait);
        // An empty set would keep the agent looking "busy waiting" forever.
        if (agentWaits.size === 0) this.waitsByAgent.delete(agentId);
        resolveWait(waitEnd);
      };
      const activeWait: ActiveWait = { questionId, wake: () => finishWait("wake") };
      const onAbort = () => finishWait("aborted");
      const timeoutTimer = setTimeout(() => finishWait("timeout"), Math.max(0, timeoutMs));
      // A dropped HTTP connection must release its wait, otherwise a later wake would be spent on a caller that is gone.
      if (abortSignal?.aborted) return finishWait("aborted");
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      agentWaits.add(activeWait);
    });
  }

  isWaiting(agentId: string): boolean {
    return (this.waitsByAgent.get(agentId)?.size ?? 0) > 0;
  }

  isWaitingOn(agentId: string, questionId: string): boolean {
    return [...(this.waitsByAgent.get(agentId) ?? [])].some((activeWait) => activeWait.questionId === questionId);
  }

  // Wakes every wait of the agent; each one re-reads the ledger and goes back to sleep if nothing is for it.
  wakeAgent(agentId: string): void {
    for (const activeWait of [...(this.waitsByAgent.get(agentId) ?? [])]) activeWait.wake();
  }
}
