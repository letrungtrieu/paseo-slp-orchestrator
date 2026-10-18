import { describe, expect, it } from "vitest";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
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

  // LEAD.md governs both the Master Lead's model and the session family used by its temporary forks unless FORKED_LEAD.md overrides them.
  it.each(["supervisor", "master_lead", "forked_lead"] as const)("applies root model settings to %s", (role) => {
    const configuration = defaultProjectPrompts();
    const definition = role === "supervisor" ? configuration.supervisor : configuration.lead;
    definition.model = "claude/project-root"; definition.thinking = "high";
    expect(resolveAgentSettings(configuration, role, undefined, runDefaults)).toMatchObject({ provider: "claude/project-root", thinkingOptionId: "high" });
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

  it("keeps the form's provider when a file specifies a short model ID", () => {
    const configuration = defaultProjectPrompts();
    configuration.peers.find((peer) => peer.role === "qa-engineer")!.model = "fast-model";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults).provider).toBe("claude/fast-model");
  });

  it("maps Full Access to the new provider's native permission ID", () => {
    const configuration = defaultProjectPrompts();
    configuration.peers.find((peer) => peer.role === "qa-engineer")!.model = "codex/role-model";
    expect(resolveAgentSettings(configuration, "peer", "qa-engineer", runDefaults).permissionModeId).toBe(getUnattendedModeId("codex"));
  });

  // A provider change must never silently replace a deliberately restricted permission choice with Full Access.
  it("rejects an incompatible restricted permission override with its configuration path", () => {
    const configuration = defaultProjectPrompts();
    configuration.peers.find((peer) => peer.role === "qa-engineer")!.model = "codex/role-model";
    expect(() => resolveAgentSettings(configuration, "peer", "qa-engineer", { ...runDefaults, permissionModeId: "restricted-mode" }))
      .toThrow(/\.slp\/peers\/QA_ENGINEER.md: model switches/);
  });
});
