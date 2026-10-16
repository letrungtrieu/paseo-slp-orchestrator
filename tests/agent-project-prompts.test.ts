import { afterEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../server/runtime/agent-gateway";
import type { PaseoHolder } from "../server/runtime/paseo-holder";
import { RunStore } from "../server/store/run-store";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { buildRun } from "./helpers/run-factory";

const openedStores: RunStore[] = [];
afterEach(() => { for (const store of openedStores.splice(0)) store.close(); });

describe("gateway project workflow injection", () => {
  it("passes the selected project workflow to Paseo and stores its separate business identity", async () => {
    const configuration = defaultProjectPrompts();
    configuration.peers.push(parseRoleMarkdown("---\nrole: Performance\ndescription: Inspect rendering latency.\nmodel: claude/performance-model\nthinking: high\n---\nMeasure frame times before proposing a fix.", ".slp/peers/PERFORMANCE.md"));
    const store = new RunStore(":memory:");
    openedStores.push(store);
    store.insert(buildRun({ promptConfig: configuration }));
    let createdConfiguration: { systemPrompt: string; provider: string; thinkingOptionId?: string } | undefined;
    let createdLabels: Record<string, string> = {};
    // Capture the actual SDK boundary, not a fake pipeline implementation of createAgent.
    const workspace = { refresh: async () => undefined, agents: { create: async (creation: {
      agentId: string; config: { systemPrompt: string; provider: string; thinkingOptionId?: string }; labels: Record<string, string>;
    }) => {
      expect(store.findAgent(creation.agentId)?.agentRecord.projectRole).toBe("performance");
      createdConfiguration = creation.config; createdLabels = creation.labels;
    } } };
    const holder = { get: async () => ({ workspaces: { ref: () => workspace } }) } as unknown as PaseoHolder;
    const gateway = new AgentGateway(holder, store, async () => 1234);
    const agent = await gateway.createAgent({ runId: "run-1", role: "security", projectRole: "performance",
      taskId: "api", provider: "claude/test", thinkingOptionId: "medium", workspaceId: "ws-task", title: "Performance", awaitTool: "slp_verdict" });
    expect(agent.role).toBe("security");
    expect(createdConfiguration?.systemPrompt).toContain("Measure frame times before proposing a fix.");
    expect(createdConfiguration?.systemPrompt).toContain("READ-ONLY reviewer");
    expect(createdLabels["slp.peer-role"]).toBe("performance");
    // Assert the real Paseo creation boundary receives both overrides, not merely the rendered prompt text.
    expect(createdConfiguration?.provider).toBe("claude/performance-model");
    expect(createdConfiguration?.thinkingOptionId).toBe("high");
  });
});
