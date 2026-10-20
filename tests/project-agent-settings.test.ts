import { describe, expect, it } from "vitest";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import { buildModelSelectOptions, filterSelectOptions } from "../client/models/provider-selection";
import type { ProviderModelChoice } from "../client/use-provider-catalog";
import { defaultProjectPrompts } from "../server/project-prompts/defaults";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { resolveAgentSettings } from "../server/project-prompts/agent-settings";

const runDefaults = { provider: "claude/form-model", thinkingOptionId: "medium", permissionModeId: getUnattendedModeId("claude") };

describe("project model and thinking overrides", () => {
  it.each(["", "model:\nthinking:", 'model: ""\nthinking: "  "'])
    ("inherits form settings when YAML choices are absent or blank: %j", (settingsYaml) => {
      const configuration = defaultProjectPrompts();
      configuration.peers[0] = parseRoleMarkdown(`---\nrole: Custom\ndescription: Domain specialist\n${settingsYaml}\n---\nApply the domain workflow.`, ".slp/peers/CUSTOM.md");
      // Independent empty fields must not clear an explicitly selected model or reasoning level from SLP.
      expect(resolveAgentSettings(configuration, "peer", "custom", runDefaults)).toEqual(runDefaults);
    });

  it("overrides just the model and inherits the form's thinking", () => {
    const configuration = defaultProjectPrompts();
    const qa = configuration.peers.find((peer) => peer.role === "qa-engineer")!;
    qa.model = "claude/role-model";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults)).toMatchObject({ provider: "claude/role-model", thinkingOptionId: "medium" });
  });

  it("overrides just thinking and inherits the form's model", () => {
    const configuration = defaultProjectPrompts();
    configuration.peers.find((peer) => peer.role === "qa-engineer")!.thinking = "high";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults)).toMatchObject({ provider: "claude/form-model", thinkingOptionId: "high" });
  });

  // Root orchestration roles govern their own model family; BASE_PEER.md governs the base session from which stage peers fork.
  it.each(["supervisor", "master_lead", "forked_lead", "base_peer"] as const)("applies root model settings to %s", (role) => {
    const configuration = defaultProjectPrompts();
    const definition =
      role === "supervisor"
        ? configuration.supervisor
        : role === "base_peer"
          ? configuration.basePeer!
          : configuration.lead;
    definition.model = "claude/project-root";
    definition.thinking = "high";
    expect(resolveAgentSettings(configuration, role, undefined, runDefaults)).toMatchObject({
      provider: "claude/project-root",
      thinkingOptionId: "high",
    });
  });

  it("allows FORKED_LEAD.md to override model or thinking independently of LEAD.md", () => {
    const configuration = defaultProjectPrompts();
    configuration.lead.model = "claude/master-lead-model";
    configuration.lead.thinking = "high";
    configuration.forkedLead!.model = "claude/forked-lead-model";
    expect(resolveAgentSettings(configuration, "forked_lead", undefined, runDefaults)).toMatchObject({
      provider: "claude/forked-lead-model",
      thinkingOptionId: "high",
    });
  });

  it("keeps base_peer's provider when a .slp/peers file specifies a compatible short model ID", () => {
    const configuration = defaultProjectPrompts();
    configuration.peers.find((peer) => peer.role === "qa-engineer")!.model = "fast-model";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults).provider).toBe("claude/fast-model");
  });

  it("resolves .slp/peers models under BASE_PEER.md's provider when BASE_PEER.md switches provider", () => {
    const configuration = defaultProjectPrompts();
    configuration.basePeer!.model = "codex/gpt-5.4";
    configuration.peers.find((peer) => peer.role === "developer")!.model = "gpt-5.4-mini";
    // Because stage peers fork from base_peer, short models in .slp/peers resolve against base_peer's codex provider.
    expect(resolveAgentSettings(configuration, "peer", "developer", runDefaults)).toMatchObject({
      provider: "codex/gpt-5.4-mini",
      permissionModeId: getUnattendedModeId("codex"),
      thinkingOptionId: "medium",
    });
  });

  it("falls back to global config when a .slp/peers model does not match base_peer's provider or catalog", () => {
    const configuration = defaultProjectPrompts();
    const qaPeer = configuration.peers.find((peer) => peer.role === "qa-engineer")!;
    // Foreign provider prefix (`codex/...` while base_peer is `claude`) falls back to global runDefaults.
    qaPeer.model = "codex/role-model";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults)).toEqual(runDefaults);

    // Foreign model-family prefix (`gpt-5.4` while base_peer is `claude`) falls back to global runDefaults.
    qaPeer.model = "gpt-5.4";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults)).toEqual(runDefaults);

    // Model absent from the supplied base_peer provider catalog falls back to global runDefaults.
    qaPeer.model = "claude-nonexistent-99";
    const claudeCatalog = [{ id: "claude-sonnet-4-6", provider: "claude" }];
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults, claudeCatalog)).toEqual(runDefaults);
  });

  it("maps Full Access to the new provider's native permission ID for root roles such as BASE_PEER.md", () => {
    const configuration = defaultProjectPrompts();
    configuration.basePeer!.model = "codex/role-model";
    expect(resolveAgentSettings(configuration, "base_peer", undefined, runDefaults).permissionModeId).toBe(
      getUnattendedModeId("codex"),
    );
  });

  // A provider change on a root role must never silently replace a deliberately restricted permission choice with Full Access.
  it("rejects an incompatible restricted permission override with its configuration path", () => {
    const configuration = defaultProjectPrompts();
    configuration.basePeer!.model = "codex/role-model";
    expect(() =>
      resolveAgentSettings(configuration, "base_peer", undefined, {
        ...runDefaults,
        permissionModeId: "restricted-mode",
      }),
    ).toThrow(/\.slp\/BASE_PEER\.md: model switches/);
  });
});

describe("model picker options and search", () => {
  const sampleCatalogChoices: ProviderModelChoice[] = [
    {
      value: "claude/claude-opus-5-5",
      label: "Opus 5.5",
      detail: "Claude · claude/claude-opus-5-5",
      model: { provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5" },
    },
    {
      value: "codex/gpt-6-luna",
      label: "GPT-6-Luna",
      detail: "Codex · codex/gpt-6-luna",
      model: { provider: "codex", id: "gpt-6-luna", label: "GPT-6-Luna", aliases: ["luna-latest"] },
    },
  ];

  // Showing the `Provider · provider/model` subtitle lets operators distinguish models that share a short display name.
  it("includes provider and full provider/model code in each model option", () => {
    const selectOptions = buildModelSelectOptions(sampleCatalogChoices);
    expect(selectOptions[1]).toEqual({
      value: "codex/gpt-6-luna",
      label: "GPT-6-Luna",
      detail: "Codex · codex/gpt-6-luna",
      keywords: ["codex", "gpt-6-luna", "luna-latest"],
    });
  });

  // Operators search by full `provider/model` code, raw model ID, provider name, or multi-word combinations.
  it.each([
    ["codex/gpt-6-luna", ["codex/gpt-6-luna"]],
    ["gpt-6-luna", ["codex/gpt-6-luna"]],
    ["codex", ["codex/gpt-6-luna"]],
    ["codex luna", ["codex/gpt-6-luna"]],
    ["luna-latest", ["codex/gpt-6-luna"]],
    ["claude opus 5.5", ["claude/claude-opus-5-5"]],
  ])("matches model options for search query %j", (searchQuery, expectedValues) => {
    const selectOptions = buildModelSelectOptions(sampleCatalogChoices);
    expect(filterSelectOptions(selectOptions, searchQuery).map((option) => option.value)).toEqual(expectedValues);
  });
});

