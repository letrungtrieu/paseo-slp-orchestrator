import { describe, expect, it } from "vitest";
import { WaitRegistry } from "../server/pipeline/peer-messaging/wait-registry";

describe("WaitRegistry", () => {
  it("resolves a wait as soon as the agent is woken instead of at the timeout", async () => {
    const registry = new WaitRegistry();
    const pendingWait = registry.wait("agent-a", "question-1", 5_000);
    expect(registry.isWaiting("agent-a")).toBe(true);
    expect(registry.isWaitingOn("agent-a", "question-1")).toBe(true);
    expect(registry.isWaitingOn("agent-a", "question-2")).toBe(false);

    registry.wakeAgent("agent-a");
    // A 5 s timeout would fail the test run if the wake-up were ignored.
    await expect(pendingWait).resolves.toBe("wake");
    expect(registry.isWaiting("agent-a")).toBe(false);
  });

  it("times out and forgets the wait so a later wake-up is not spent on it", async () => {
    const registry = new WaitRegistry();
    await expect(registry.wait("agent-a", "question-1", 10)).resolves.toBe("timeout");
    expect(registry.isWaiting("agent-a")).toBe(false);
  });

  it("releases a wait when the caller's connection is aborted", async () => {
    const registry = new WaitRegistry();
    const connection = new AbortController();
    const pendingWait = registry.wait("agent-a", "question-1", 5_000, connection.signal);
    connection.abort();
    await expect(pendingWait).resolves.toBe("aborted");
    expect(registry.isWaiting("agent-a")).toBe(false);
  });

  it("does not register a wait for a connection that is already closed", async () => {
    const registry = new WaitRegistry();
    const closedConnection = new AbortController();
    closedConnection.abort();
    await expect(registry.wait("agent-a", "question-1", 5_000, closedConnection.signal)).resolves.toBe("aborted");
    expect(registry.isWaiting("agent-a")).toBe(false);
  });

  it("wakes every wait of one agent and leaves other agents asleep", async () => {
    const registry = new WaitRegistry();
    const firstWait = registry.wait("agent-a", "question-1", 5_000);
    const secondWait = registry.wait("agent-a", "question-2", 5_000);
    const otherAgentWait = registry.wait("agent-b", "question-3", 30);
    registry.wakeAgent("agent-a");
    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual(["wake", "wake"]);
    await expect(otherAgentWait).resolves.toBe("timeout");
  });
});
