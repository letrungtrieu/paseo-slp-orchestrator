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
    const agent = await gateway.createAgent({ runId: "run-1", role: "peer", projectRole: "performance",
      pipelineId: "pipeline-1", stageId: "stage-1", stagePeerId: "0", taskId: null,
      provider: "claude/test", thinkingOptionId: "medium", workspaceId: "ws-task", title: "Performance", awaitTool: "slp_stage_report" });
    expect(agent.role).toBe("peer");
    expect(createdConfiguration?.systemPrompt).toContain("Measure frame times before proposing a fix.");
    expect(createdConfiguration?.systemPrompt).toContain("PROJECT ROLE: Performance (performance)");
    expect(createdConfiguration?.systemPrompt).not.toContain("ROLE CONTRACT:");
    expect(createdLabels["slp.peer-role"]).toBe("performance");
    // Assert the real Paseo creation boundary receives both overrides, not merely the rendered prompt text.
    expect(createdConfiguration?.provider).toBe("claude/performance-model");
    expect(createdConfiguration?.thinkingOptionId).toBe("high");
  });

  it("omits toolPolicy upfront for antigravity and retries without toolPolicy when a provider rejects permission.tool_policy", async () => {
    const store = new RunStore(":memory:");
    openedStores.push(store);
    store.insert(buildRun({ promptConfig: defaultProjectPrompts() }));
    const createdConfigs: Array<{ provider: string; modeId?: string; toolPolicy?: unknown }> = [];
    let customProviderAttempts = 0;
    const workspace = {
      refresh: async () => undefined,
      agents: {
        create: async (creation: {
          agentId: string;
          config: { provider: string; modeId?: string; toolPolicy?: unknown };
        }) => {
          // Simulate a plugin provider that lacks the permission.tool_policy capability on first open.
          if (creation.config.provider.startsWith("custom-cli/") && creation.config.toolPolicy) {
            customProviderAttempts += 1;
            throw new Error("Provider does not support permission.tool_policy");
          }
          if (creation.config.provider.startsWith("custom-cli/")) {
            customProviderAttempts += 1;
          }
          createdConfigs.push(creation.config);
        },
      },
    };
    const holder = { get: async () => ({ workspaces: { ref: () => workspace } }) } as unknown as PaseoHolder;
    const gateway = new AgentGateway(holder, store, async () => 1234);

    // Antigravity is known not to support permission.tool_policy, so it creates in one call with full-access mode.
    await gateway.createAgent({
      runId: "run-1",
      role: "supervisor",
      taskId: null,
      provider: "antigravity/gemini-2.5-pro",
      workspaceId: "ws-sup",
      title: "Supervisor",
      awaitTool: null,
    });
    expect(createdConfigs[0]?.provider).toBe("antigravity/gemini-2.5-pro");
    expect(createdConfigs[0]?.modeId).toBe("full-access");
    expect(createdConfigs[0]?.toolPolicy).toBeUndefined();

    // Unknown providers that reject permission.tool_policy fall back to omitting toolPolicy and cache that capability.
    await gateway.createAgent({
      runId: "run-1",
      role: "master_lead",
      taskId: null,
      provider: "custom-cli/model-a",
      workspaceId: "ws-lead",
      title: "Master Lead",
      awaitTool: null,
    });
    expect(customProviderAttempts).toBe(2);
    expect(createdConfigs[1]?.provider).toBe("custom-cli/model-a");
    expect(createdConfigs[1]?.toolPolicy).toBeUndefined();
  });
});
