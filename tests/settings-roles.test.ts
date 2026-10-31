// The Product Agent has its own model setting, and settings saved before it existed must keep working.
import { describe, expect, it } from "vitest";
import { productAgentDefaults } from "../server/runtime/run-defaults";
import { PROVIDER_ROLES, SlpSettingsSchema } from "../shared/settings";

describe("Product Agent settings", () => {
  it("lists the Product Agent before the roles of a Run", () => {
    expect(PROVIDER_ROLES).toEqual(["product", "supervisor", "lead", "peer"]);
  });

  it("parses a document saved before the Product Agent existed and gives it empty defaults", () => {
    const olderDocument = { roles: { supervisor: { providerModel: "claude/opus", thinkingOptionId: "high", permissionModeId: "plan" } } };
    const parsedSettings = SlpSettingsSchema.parse(olderDocument);
    expect(parsedSettings.roles.supervisor.providerModel).toBe("claude/opus");
    expect(parsedSettings.roles.product).toEqual({ providerModel: null, thinkingOptionId: null, permissionModeId: null });
  });

  it("borrows the Supervisor's choice until a Product Agent model is picked, then uses its own", () => {
    const supervisorSelection = { providerModel: "claude/opus", thinkingOptionId: "high", permissionModeId: "plan" };
    const settingsWithoutProduct = SlpSettingsSchema.parse({ roles: { supervisor: supervisorSelection } });
    expect(productAgentDefaults(settingsWithoutProduct.roles)).toEqual({
      provider: "claude/opus", thinkingOptionId: "high", permissionModeId: "plan",
    });

    const settingsWithProduct = SlpSettingsSchema.parse({
      roles: {
        supervisor: supervisorSelection,
        product: { providerModel: "claude/sonnet", thinkingOptionId: "low", permissionModeId: "default" },
      },
    });
    expect(productAgentDefaults(settingsWithProduct.roles)).toEqual({
      provider: "claude/sonnet", thinkingOptionId: "low", permissionModeId: "default",
    });
  });
});
