// Verifies the mockup-first flow: the Product Agent shapes one git-tracked file per feature outside any Run,
// the human approves it at a commit, and a Run then starts from the prepared ticket.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BusCaller, BusToolOutcome } from "../server/bus/http-mcp";
import { approveBoardMockup, sendMockupFeedback } from "../server/pipeline/mockup-tools";
import { bundleMockupHtmlPreview } from "../server/pipeline/mockup-files";
import { buildSpecWorkPrompt, STANDALONE_PRODUCT_AGENT_TOOLS } from "../server/pipeline/product-agent";
import { createBusDispatcher } from "../server/pipeline/tool-handlers";
import { upgradeLegacyTicketPayload } from "../server/store/board-mockup";
import { BoardTicketSchema, BOARD_COLUMNS, describeTicketRunBlocker, type BoardTicket } from "../shared/board";
import { StageStateSchema } from "../shared/pipeline";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import { SAMPLE_PRODUCT_SPEC } from "./helpers/flow-steps";
import { runGitSync } from "./helpers/git-fixture";

const createFlow = useFlowFixture();
const MOCKUP_FILE = ".slp/mockup/checkout.html";

// A standalone session authenticates like production: no Run, explicit allow-list, repository from its session.
function callAsProductAgent(flow: Flow, toolName: string, toolArguments: unknown): Promise<BusToolOutcome> {
  const productAgentCaller: BusCaller = {
    runId: "",
    agentId: "product-agent-1",
    role: "supervisor",
    projectRole: "product-agent",
    taskId: null,
    repoPath: flow.repoPath,
    allowedTools: STANDALONE_PRODUCT_AGENT_TOOLS,
  };
  return createBusDispatcher(flow.ctx).dispatch(productAgentCaller, toolName, toolArguments);
}

// Writes the layout the Product Agent is told to use: an index that only loads core and feature files.
async function writeCheckoutMockup(flow: Flow, buttonLabel = "Thanh toán"): Promise<void> {
  const mockupRoot = join(flow.repoPath, ".slp", "mockup");
  await mkdir(join(mockupRoot, "core"), { recursive: true });
  await mkdir(join(mockupRoot, "features", "checkout"), { recursive: true });
  await writeFile(join(mockupRoot, "core", "core.css"), ".btn { background: #2563eb; }", "utf8");
  await writeFile(join(mockupRoot, "core", "core.js"), "window.__slpCore = true;", "utf8");
  await writeFile(join(mockupRoot, "features", "checkout", "checkout.css"), ".pay { color: white; }", "utf8");
  await writeFile(join(mockupRoot, "features", "checkout", "cart.js"), "window.__slpCartReady = true;", "utf8");
  await writeFile(
    join(flow.repoPath, MOCKUP_FILE),
    `<!doctype html><html><head><link rel="stylesheet" href="./core/core.css"><link rel="stylesheet" href="./features/checkout/checkout.css"></head><body><button id="pay" class="btn pay">${buttonLabel}</button><script src="./core/core.js"></script><script src="./features/checkout/cart.js"></script></body></html>`,
    "utf8",
  );
}

function commitMockups(flow: Flow): string {
  runGitSync(flow.repoPath, ["add", ".slp/mockup"]);
  runGitSync(flow.repoPath, ["commit", "-m", "Add checkout mockup"]);
  return runGitSync(flow.repoPath, ["rev-parse", "HEAD"]).trim();
}

async function createMockupTicket(flow: Flow): Promise<string> {
  await writeCheckoutMockup(flow);
  const linkOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", {
    title: "Thanh toán",
    file: "checkout.html",
    summary: "Màn hình thanh toán",
  });
  expect(linkOutcome.isError).toBe(false);
  return (JSON.parse(linkOutcome.text) as { ticketKey: string }).ticketKey;
}

// Brings a ticket to the state a Run can start from.
async function prepareReadyTicket(flow: Flow): Promise<string> {
  const ticketKey = await createMockupTicket(flow);
  commitMockups(flow);
  await approveBoardMockup(flow.ctx, { repoPath: flow.repoPath, ticketIdOrKey: ticketKey });
  const specOutcome = await callAsProductAgent(flow, "slp_board_save_spec", {
    ticketId: ticketKey,
    spec: SAMPLE_PRODUCT_SPEC,
    summary: "Spec mỏng từ mockup",
  });
  expect(specOutcome.isError).toBe(false);
  return ticketKey;
}

describe("mockup-first product flow", () => {
  it("orders the board with MOCKUP before SPEC", () => {
    expect(BOARD_COLUMNS.slice(0, 2)).toEqual(["mockup", "spec"]);
  });

  it("creates a Spec-less ticket from a mockup outside any Run and keeps one card per file", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await createMockupTicket(flow);
    const ticket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(ticket.column).toBe("mockup");
    expect(ticket.currentSpecRev).toBe(0);
    expect(ticket.mockup?.file).toBe(MOCKUP_FILE);

    // Repeating the save without a ticket key must update the same card, not create a duplicate.
    await callAsProductAgent(flow, "slp_board_set_mockup", { file: "checkout.html", summary: "Thêm trạng thái lỗi" });
    expect(flow.ctx.store.board.listByRepo(flow.repoPath)).toHaveLength(1);
  });

  it("rejects mockups outside the shared root and files that were never written", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const outsideOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", { file: "../src/a.html", summary: "x" });
    const coreOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", { file: "core/core.html", summary: "x" });
    const missingOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", { file: "missing.html", summary: "x" });
    expect([outsideOutcome.isError, coreOutcome.isError, missingOutcome.isError]).toEqual([true, true, true]);
  });

  it("does not let a Product Agent reach Run-only tools", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const blockedOutcome = await callAsProductAgent(flow, "slp_delegate", { acceptanceCriteria: "x" });
    expect(blockedOutcome.isError).toBe(true);
  });

  it("previews a feature file with its shared core inlined", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await writeCheckoutMockup(flow);
    const { bundledHtml } = await bundleMockupHtmlPreview(flow.repoPath, MOCKUP_FILE);
    expect(bundledHtml).toContain("background: #2563eb");
    expect(bundledHtml).toContain("window.__slpCore = true;");
    expect(bundledHtml).toContain("color: white;");
    expect(bundledHtml).toContain("window.__slpCartReady = true;");
    expect(bundledHtml).toContain('data-slp-mockup-inspector="true"');
  });

  it("refuses an index that carries inline script or style, and accepts one that only loads files", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    await writeCheckoutMockup(flow);
    const indexPath = join(flow.repoPath, MOCKUP_FILE);
    const loaderOnlyIndex = await readFile(indexPath, "utf8");

    await writeFile(indexPath, loaderOnlyIndex.replace("</body>", "<script>window.__inline = 1;</script></body>"), "utf8");
    const inlineScriptOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", { file: "checkout.html", summary: "x" });
    expect(inlineScriptOutcome.isError).toBe(true);
    expect(inlineScriptOutcome.text).toContain("features/<feature>");

    await writeFile(indexPath, loaderOnlyIndex.replace("</head>", "<style>.pay { color: red; }</style></head>"), "utf8");
    const inlineStyleOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", { file: "checkout.html", summary: "x" });
    expect(inlineStyleOutcome.isError).toBe(true);

    await writeFile(indexPath, loaderOnlyIndex, "utf8");
    const loaderOutcome = await callAsProductAgent(flow, "slp_board_set_mockup", { file: "checkout.html", summary: "x" });
    expect(loaderOutcome.isError).toBe(false);
  });

  it("refuses approval until the mockup is committed, then pins the commit and moves to SPEC", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await createMockupTicket(flow);
    const approveParams = { repoPath: flow.repoPath, ticketIdOrKey: ticketKey };
    await expect(approveBoardMockup(flow.ctx, approveParams)).rejects.toThrow(/not committed/);

    const approvedCommit = commitMockups(flow);
    // A later edit to any shared file counts too, because core changes alter what the feature looks like.
    await writeFile(join(flow.repoPath, ".slp/mockup/core/core.css"), ".btn { background: red; }", "utf8");
    await expect(approveBoardMockup(flow.ctx, approveParams)).rejects.toThrow(/Commit the changes/);

    runGitSync(flow.repoPath, ["checkout", "--", ".slp/mockup"]);
    const approvedTicket = await approveBoardMockup(flow.ctx, approveParams);
    expect(approvedTicket.mockup?.status).toBe("approved");
    expect(approvedTicket.mockup?.approvedCommit).toBe(approvedCommit);
    expect(approvedTicket.column).toBe("spec");
  });

  it("withdraws approval when the mockup changes again", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await prepareReadyTicket(flow);
    await callAsProductAgent(flow, "slp_board_set_mockup", { ticketId: ticketKey, file: "checkout.html", summary: "Đổi nút" });
    const reopenedTicket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(reopenedTicket.mockup?.status).toBe("draft");
    expect(reopenedTicket.mockup?.approvedCommit).toBeNull();
    expect(reopenedTicket.column).toBe("mockup");
  });

  it("keeps the human's notes on the ticket and opens a fresh agent when no session is reachable", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await createMockupTicket(flow);
    const feedbackOutcome = await sendMockupFeedback(flow.ctx, {
      repoPath: flow.repoPath,
      ticketIdOrKey: ticketKey,
      feedback: "Đổi màu nút",
      elementComments: [{ selector: "button#pay", tagName: "BUTTON", elementText: "Thanh toán", comment: "Màu xanh lá" }],
      openProductAgent: async () => "fresh-product-agent",
    });
    expect(feedbackOutcome.productAgentId).toBe("fresh-product-agent");
    expect(feedbackOutcome.ticket.mockup?.elementComments[0].tagName).toBe("button");
    expect(feedbackOutcome.ticket.mockup?.feedback).toBe("Đổi màu nút");
  });

  it("gates Run start on an approved mockup and a written Spec", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await createMockupTicket(flow);
    await expect(flow.startRun(ticketKey)).rejects.toThrow(/Approve the mockup/);
    commitMockups(flow);
    await approveBoardMockup(flow.ctx, { repoPath: flow.repoPath, ticketIdOrKey: ticketKey });
    await expect(flow.startRun(ticketKey)).rejects.toThrow(/Write the Spec/);
    await expect(flow.startRun("SLP-99")).rejects.toThrow(/was not found/);
    // A refused start must leave nothing behind.
    expect(flow.store.list()).toHaveLength(0);
  });

  it("starts a Run from a ticket and hands the Lead the approved mockup on the same card", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await prepareReadyTicket(flow);
    const runId = await flow.startRun(ticketKey);
    const run = flow.run(runId);

    const boundTicket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(boundTicket.activeRunId).toBe(runId);
    expect(run.productSpec).toBe(SAMPLE_PRODUCT_SPEC.trim());
    expect(flow.gateway.promptsTo(run.supervisorAgentId).join("\n")).toContain(ticketKey);
    expect(describeTicketRunBlocker(boundTicket)).toMatch(/already belongs/);

    const delegation = await flow.callAs(run.supervisorAgentId, "slp_delegate", {
      acceptanceCriteria: "Checkout works end to end and its behavior is independently verified.",
      productSpec: SAMPLE_PRODUCT_SPEC,
    });
    expect(delegation.isError).toBe(false);

    const delegatedRun = flow.run(runId);
    const leadMail = flow.mailTo(runId, delegatedRun.masterLeadAgentId).map((message) => message.text).join("\n");
    expect(leadMail).toContain(MOCKUP_FILE);
    expect(leadMail).toContain(boundTicket.mockup?.approvedCommit ?? "missing-commit");
    // Delegation must reuse the prepared card, or the approved mockup would drift away from the delivered feature.
    const projectTickets = flow.ctx.store.board.listByRepo(flow.repoPath);
    expect(projectTickets).toHaveLength(1);
    expect(projectTickets[0].title).toBe("Thanh toán");
    expect(projectTickets[0].leadAgentId).toBe(delegatedRun.masterLeadAgentId);
  });

  it("tells the Supervisor when the Product Agent edits a Spec that is already in a Run, without detaching the ticket", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await prepareReadyTicket(flow);
    const runId = await flow.startRun(ticketKey);
    const supervisorAgentId = flow.run(runId).supervisorAgentId;

    const editOutcome = await callAsProductAgent(flow, "slp_board_save_spec", {
      ticketId: ticketKey,
      spec: `${SAMPLE_PRODUCT_SPEC}\n\nThêm quy tắc hoàn tiền.`,
      summary: "Thêm quy tắc",
    });
    expect(editOutcome.isError).toBe(false);

    const editedTicket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(editedTicket.activeRunId).toBe(runId);
    // The card title is the feature name and must survive a Spec whose first line is just a heading.
    expect(editedTicket.title).toBe("Thanh toán");
    const supervisorMail = [
      ...flow.mailTo(runId, supervisorAgentId).map((message) => message.text),
      ...flow.gateway.promptsTo(supervisorAgentId),
    ].join("\n");
    expect(supervisorMail).toContain("Spec Updated on Kanban Board");
  });

  it("rejects a mockup stage in new pipelines while old runs keep parsing", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
      productSpec: SAMPLE_PRODUCT_SPEC,
    });
    const defineOutcome = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
      pipeline: {
        name: "legacy-shape",
        description: "Retired mockup stage",
        stages: [
          { name: "mockup-stage", kind: "mockup", goal: "Mock it", peers: [{ role: "developer", task: "Mock" }] },
          { name: "implement", kind: "implement", goal: "Build it", peers: [{ role: "developer", task: "Build" }] },
        ],
      },
    });
    expect(defineOutcome.isError).toBe(true);

    // A persisted run may already hold a mockup stage; it must load as planning so its history stays readable.
    expect(StageStateSchema.shape.kind.parse("mockup")).toBe("planning");
  });

  it("keeps the Spec locked while the mockup is a draft and asks for it on approval", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await createMockupTicket(flow);
    const lockedAttempt = await callAsProductAgent(flow, "slp_board_save_spec", {
      ticketId: ticketKey,
      spec: SAMPLE_PRODUCT_SPEC,
      summary: "Viết Spec khi mockup còn nháp",
    });
    // The refusal comes from the store, so every caller of it is covered and nothing is written.
    expect(lockedAttempt.isError).toBe(true);
    expect(lockedAttempt.text).toMatch(/still a draft/);
    expect(flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath).currentSpecRev).toBe(0);

    commitMockups(flow);
    const agentRequests: BoardTicket[] = [];
    const approvedTicket = await approveBoardMockup(flow.ctx, {
      repoPath: flow.repoPath,
      ticketIdOrKey: ticketKey,
      openProductAgent: async (ticketNeedingSpec) => {
        agentRequests.push(ticketNeedingSpec);
        return "fresh-product-agent";
      },
    });
    // No live Product Agent holds the ticket in this test, so approval itself must open one to create the Spec.
    expect(agentRequests).toHaveLength(1);
    expect(buildSpecWorkPrompt(approvedTicket)).toMatch(/soạn Spec mỏng/);

    const unlockedAttempt = await callAsProductAgent(flow, "slp_board_save_spec", {
      ticketId: ticketKey,
      spec: SAMPLE_PRODUCT_SPEC,
      summary: "Spec mỏng từ mockup",
    });
    expect(unlockedAttempt.isError).toBe(false);
    const specifiedTicket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(specifiedTicket.specMockupCommit).toBe(approvedTicket.mockup?.approvedCommit);
  });

  it("relocks the Spec when an approved mockup is edited and reviews it on the next approval", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const ticketKey = await prepareReadyTicket(flow);
    const readyTicket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(describeTicketRunBlocker(readyTicket)).toBeNull();

    await writeCheckoutMockup(flow, "Trả tiền");
    await callAsProductAgent(flow, "slp_board_set_mockup", { ticketId: ticketKey, file: "checkout.html", summary: "Đổi nhãn nút" });
    const editedSpecAttempt = await callAsProductAgent(flow, "slp_board_save_spec", {
      ticketId: ticketKey,
      spec: `${SAMPLE_PRODUCT_SPEC}\n\nThêm quy tắc mới`,
      summary: "Cố giữ Spec khớp bản nháp",
    });
    expect(editedSpecAttempt.isError).toBe(true);
    expect(flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath).currentSpecRev).toBe(1);

    const reapprovalCommit = commitMockups(flow);
    const reapprovedTicket = await approveBoardMockup(flow.ctx, {
      repoPath: flow.repoPath,
      ticketIdOrKey: ticketKey,
      openProductAgent: async () => "fresh-product-agent",
    });
    // The Spec exists, so approval asks for a review rather than a new Spec, and the ticket cannot run until it is done.
    expect(buildSpecWorkPrompt(reapprovedTicket)).toMatch(/rà soát/);
    expect(describeTicketRunBlocker(reapprovedTicket)).toMatch(/Review the Spec/);

    // Saving the unchanged text confirms the review without inventing a revision.
    const confirmation = await callAsProductAgent(flow, "slp_board_save_spec", {
      ticketId: ticketKey,
      spec: SAMPLE_PRODUCT_SPEC,
      summary: "Spec vẫn đúng",
    });
    expect(confirmation.isError).toBe(false);
    const reviewedTicket = flow.ctx.store.board.requireTicket(ticketKey, flow.repoPath);
    expect(reviewedTicket.currentSpecRev).toBe(1);
    expect(reviewedTicket.specMockupCommit).toBe(reapprovalCommit);
    expect(describeTicketRunBlocker(reviewedTicket)).toBeNull();
  });

  it("upgrades tickets saved with versioned mockups so old work stays previewable", () => {
    const legacyPayload = {
      id: "ticket-1",
      ticketKey: "SLP-1",
      repoPath: "/repo",
      title: "Old feature",
      currentMockupRev: 2,
      approvedMockupRev: 2,
      mockupRevisions: [
        { entryHtmlPath: ".slp/mockups/old/versions/v1/index.html", summary: "v1" },
        { entryHtmlPath: ".slp/mockups/old/versions/v2/index.html", summary: "v2", reviewedAt: "2026-01-02T00:00:00.000Z" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const upgradedTicket = BoardTicketSchema.parse(upgradeLegacyTicketPayload(legacyPayload));
    expect(upgradedTicket.mockup?.file).toBe(".slp/mockups/old/versions/v2/index.html");
    expect(upgradedTicket.mockup?.status).toBe("approved");
  });
});
