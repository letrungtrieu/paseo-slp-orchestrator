// Verifies the product spec phase: the Supervisor must pass a human-approved spec for every feature, and that spec
// reaches each Lead as a contract and the QA Lead as the source of its test scenarios.
import { describe, expect, it } from "vitest";
import { systemPromptFor } from "../server/prompts/system-prompts";
import { useFlowFixture } from "./helpers/flow-fixture";
import { SAMPLE_PRODUCT_SPEC, delegateToLead } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

const AUTH_SPEC = `${SAMPLE_PRODUCT_SPEC}\nAUTH-ONLY: Given a wrong password When the user signs in Then an inline error appears under the field.`;
const CHECKOUT_SPEC = `${SAMPLE_PRODUCT_SPEC}\nCHECKOUT-ONLY: Given an empty cart When the user opens checkout Then the Pay button is disabled.`;

describe("product spec phase", () => {
  it("rejects delegation without a human-approved product spec and spawns nobody", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();

    const withoutSpec = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
    });
    expect(withoutSpec.isError).toBe(true);
    expect(withoutSpec.text).toContain("productSpec");

    // One feature missing its spec is enough to reject the whole parallel delegation.
    const partialSpecs = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [
        { name: "auth", acceptanceCriteria: "Sign-in validates credentials.", productSpec: AUTH_SPEC },
        { name: "checkout", acceptanceCriteria: "Checkout blocks empty carts." },
      ],
    });
    expect(partialSpecs.isError).toBe(true);
    expect(Object.values(flow.run(runId).agents).map((agent) => agent.role)).toEqual(["supervisor"]);
  });

  it("hands the approved spec to the Lead as a contract and to the QA Lead as test scenarios", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const delegatedRun = flow.run(runId);

    expect(delegatedRun.productSpec).toBe(SAMPLE_PRODUCT_SPEC);
    expect(delegatedRun.agents[delegatedRun.masterLeadAgentId].featureSpec).toBe(SAMPLE_PRODUCT_SPEC);
    const leadBriefing = flow.mailTo(runId, delegatedRun.masterLeadAgentId).at(-1)?.text ?? "";
    expect(leadBriefing).toContain("Human-Approved Product Spec");
    expect(leadBriefing).toContain("Given a valid CSV When the user clicks Import");
    const qaBriefing = flow.mailTo(runId, delegatedRun.qaLeadAgentId).at(-1)?.text ?? "";
    expect(qaBriefing).toContain("Given a valid CSV When the user clicks Import");
    expect(qaBriefing).toContain("turn every Given/When/Then scenario");

    // Any agent can re-read the contract after its briefing scrolls out of context.
    const runRead = JSON.parse((await flow.callAs(delegatedRun.qaLeadAgentId, "slp_get_run", {})).text) as { productSpec: string };
    expect(runRead.productSpec).toBe(SAMPLE_PRODUCT_SPEC);
  });

  it("gives each parallel Lead only its own spec while the QA Lead and run keep all of them", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const delegation = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      tasks: [
        { name: "auth", acceptanceCriteria: "Sign-in validates credentials.", productSpec: AUTH_SPEC },
        { name: "checkout", acceptanceCriteria: "Checkout blocks empty carts.", productSpec: CHECKOUT_SPEC },
      ],
    });
    expect(delegation.isError).toBe(false);
    const delegatedRun = flow.run(runId);
    const featureLeads = Object.values(delegatedRun.agents).filter((agent) => agent.role === "master_lead");
    const authLead = featureLeads.find((agent) => agent.featureName === "auth")!;
    const authBriefing = flow.mailTo(runId, authLead.agentId).at(-1)?.text ?? "";
    expect(authBriefing).toContain("AUTH-ONLY");
    expect(authBriefing).not.toContain("CHECKOUT-ONLY");

    expect(delegatedRun.productSpec).toContain("## auth");
    expect(delegatedRun.productSpec).toContain("CHECKOUT-ONLY");
    const qaBriefing = flow.mailTo(runId, delegatedRun.qaLeadAgentId).at(-1)?.text ?? "";
    expect(qaBriefing).toContain("AUTH-ONLY");
    expect(qaBriefing).toContain("CHECKOUT-ONLY");
  });

  it("tells the Supervisor to get explicit human approval of the five-section spec before delegating", () => {
    const supervisorPrompt = systemPromptFor("supervisor");
    expect(supervisorPrompt).toContain("Product spec before delegation");
    expect(supervisorPrompt).toContain("explicitly approves");
    expect(supervisorPrompt).toContain("Given <context> When <user action> Then <visible result>");
  });
});
