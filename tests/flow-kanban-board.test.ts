// Verifies the project-scoped Kanban Spec & Brief board:
// 1. Human Spec edits on the Kanban UI compute Git-style unified diffs and notify the Supervisor, who notifies the Lead.
// 2. Lead can pause child stage peers (slp_pause_peers), blocking their file writes while updating the Brief (slp_board_update_brief), and resume them (slp_resume_peers).
// 3. Mutable Brief revisions preserve pass scores on unchanged bullets while resetting modified bullets and computing unified Brief diffs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { handlePermissionRequest } from "../server/hooks/permission-handler";
import { registerRpcHandlers } from "../server/rpc-handlers";
import {
  listBoardTicketsRpc,
  readBoardMockupPreviewRpc,
  reviewBoardMockupFromUiRpc,
  saveBoardSpecFromUiRpc,
} from "../shared/rpc";
import type { BoardTicket } from "../shared/board";
import { useFlowFixture } from "./helpers/flow-fixture";
import {
  SAMPLE_BRIEF,
  SAMPLE_PRODUCT_SPEC,
  SINGLE_DEVELOPER_PIPELINE,
  currentStage,
  delegateToLead,
  eventually,
  startedRunWithPipeline,
} from "./helpers/flow-steps";

const createFlow = useFlowFixture();

// Builds an in-memory RPC harness wired to the same orchestrator context as the flow fixture.
function createBoardRpcHarness(flowCtx: Parameters<typeof registerRpcHandlers>[1]) {
  const registeredHandlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>();
  const mockServer = {
    handle: (rpcContract: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => {
      registeredHandlers.set(rpcContract.name, handler);
    },
  } as unknown as PluginServerContext;
  registerRpcHandlers(mockServer, flowCtx);

  const invokeRpc = async <Output>(rpcContract: { name: string }, inputPayload: unknown): Promise<Output> => {
    const rpcHandler = registeredHandlers.get(rpcContract.name);
    if (!rpcHandler) throw new Error(`Missing RPC handler for ${rpcContract.name}`);
    return (await rpcHandler(inputPayload, { paseo: {} })) as Output;
  };
  return { invokeRpc };
}

describe("Kanban Spec & Brief board workflow", () => {
  it("tracks Spec -> Brief -> Score -> Rework on a project-scoped ticket and computes Git-style unified diffs when the human edits Spec", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { invokeRpc } = createBoardRpcHarness(flow.ctx);
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const activeRun = flow.run(runId);

    // Delegation and pipeline definition automatically create and sync ticket SLP-1 in the BRIEF column.
    const initialBoardResponse = await invokeRpc<{ repoPath: string; tickets: BoardTicket[] }>(
      listBoardTicketsRpc,
      { runId },
    );
    expect(initialBoardResponse.tickets).toHaveLength(1);
    const initialTicket = initialBoardResponse.tickets[0];
    expect(initialTicket.ticketKey).toBe("SLP-1");
    expect(initialTicket.column).toBe("brief");
    expect(initialTicket.currentSpecRev).toBe(1);
    expect(initialTicket.currentBriefRev).toBe(1);
    expect(initialTicket.activeAgents.length).toBeGreaterThan(0);

    // Human edits the Spec directly on the Kanban UI and clicks Apply; this must record Spec v2 with a unified diff and notify the Supervisor.
    const updatedSpecText = `${activeRun.productSpec}\n6. New Requirement: Export failed CSV rows as a downloadable JSON report.`;
    const savedSpecResponse = await invokeRpc<{ ticket: BoardTicket; notifiedSupervisor: boolean }>(
      saveBoardSpecFromUiRpc,
      {
        repoPath: activeRun.repoPath,
        runId,
        ticketId: "SLP-1",
        title: initialTicket.title,
        specContent: updatedSpecText,
        summary: "Add JSON error export requirement",
      },
    );
    expect(savedSpecResponse.notifiedSupervisor).toBe(true);
    expect(savedSpecResponse.ticket.currentSpecRev).toBe(2);
    expect(savedSpecResponse.ticket.lastSyncedSpecRev).toBe(1);
    const secondSpecRevision = savedSpecResponse.ticket.specRevisions.at(-1)!;
    expect(secondSpecRevision.author).toBe("human");
    expect(secondSpecRevision.diff).toContain("+ 6. New Requirement: Export failed CSV rows as a downloadable JSON report.");

    // Verify the Supervisor received the Kanban Spec update notification in its mailbox.
    const supervisorMailText = flow.mailTo(runId, activeRun.supervisorAgentId).at(-1)?.text ?? "";
    expect(supervisorMailText).toContain("Human Updated Spec on Kanban Board");
    expect(supervisorMailText).toContain("SLP-1");
    expect(supervisorMailText).toContain("slp_board_notify_lead");

    // Supervisor notifies the Lead about the Spec update using slp_board_notify_lead.
    const notifyLeadCall = await flow.callAs(activeRun.supervisorAgentId, "slp_board_notify_lead", {
      ticketId: "SLP-1",
      message: "Human added JSON error export to Spec v2. Please pause peers and update the Brief.",
    });
    expect(notifyLeadCall.isError).toBe(false);
    const activeStage = currentStage(flow, runId, pipelineId);
    const stageLeadAgentId = activeStage.forkedLeadAgentId ?? activeRun.masterLeadAgentId;
    const leadMailText = flow.mailTo(runId, stageLeadAgentId).at(-1)?.text ?? "";
    expect(leadMailText).toContain("Spec Update Notification from Supervisor — Ticket `SLP-1` (Spec v2)");
    expect(leadMailText).toContain("slp_pause_peers");
  });

  it("lets the Lead pause child peers, blocks peer file writes while paused, updates Brief bullets with unified diffs on conflict, and resumes peers", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { invokeRpc } = createBoardRpcHarness(flow.ctx);
    const { runId, pipelineId } = await startedRunWithPipeline(flow, SINGLE_DEVELOPER_PIPELINE);
    const activeStage = currentStage(flow, runId, pipelineId);
    const leadAgentId = flow.agentId(runId, "forked_lead", activeStage.id);
    const developerPeerId = flow.agentId(runId, "developer", activeStage.id);

    // Score bullet C1 as passing before the Lead revises the Brief so we can verify unchanged bullets keep their score.
    const initialScoreCall = await flow.callAs(leadAgentId, "slp_board_score_item", {
      ticketId: "SLP-1",
      scorecard: [
        {
          criterionId: "C1",
          status: "pass",
          reason: "Streaming CSV parser already verified.",
          evidence: "csv.test.ts:18",
        },
      ],
    });
    expect(initialScoreCall.isError).toBe(false);

    // Lead pauses child peers because implementation hit a conflict requiring a technical pivot.
    const pauseCall = await flow.callAs(leadAgentId, "slp_pause_peers", {
      pipelineId,
      reason: "Switching error export format after library conflict; hold all edits while Brief is updated.",
    });
    expect(pauseCall.isError).toBe(false);
    expect(pauseCall.text).toContain(developerPeerId);

    // Paused peer record must carry pausedAt and pausedReason, and appear as paused on the Kanban board.
    const pausedPeerRecord = flow.run(runId).agents[developerPeerId];
    expect(pausedPeerRecord.pausedAt).toBeTruthy();
    expect(pausedPeerRecord.pausedReason).toContain("Switching error export format");
    const boardDuringPause = await invokeRpc<{ repoPath: string; tickets: BoardTicket[] }>(
      listBoardTicketsRpc,
      { runId },
    );
    const pausedAgentOnCard = boardDuringPause.tickets[0].activeAgents.find(
      (agentActivity) => agentActivity.agentId === developerPeerId,
    );
    expect(pausedAgentOnCard?.pausedAt).toBeTruthy();

    // While paused by Lead, permission handler must block file writes and mutating shell commands from the peer.
    await handlePermissionRequest(flow.ctx, developerPeerId, {
      id: "perm-paused-write",
      name: "Write",
      kind: "edit",
      input: { file_path: `${flow.pipeline(runId, pipelineId)!.worktree}/src/index.ts` },
    } as never);
    const blockedWriteResponse = flow.gateway.permissionResponses.find(
      (entry) => entry.requestId === "perm-paused-write",
    );
    expect(blockedWriteResponse?.response).toMatchObject({
      behavior: "deny",
    });

    // Lead updates the Brief: keeps C1 unchanged, modifies S1, and adds C2 for the new technical approach.
    const updateBriefCall = await flow.callAs(leadAgentId, "slp_board_update_brief", {
      ticketId: "SLP-1",
      pipelineId,
      reason: "Switched from streaming writer to buffered batch export due to stream lock conflict",
      approach: "Parse CSV rows and batch-flush invalid rows into a JSON report.",
      items: [
        {
          id: "C1",
          requirement: SAMPLE_BRIEF.criteria[0].requirement,
          verification: SAMPLE_BRIEF.criteria[0].verification,
          scope: "in",
        },
        {
          id: "C2",
          requirement: "Invalid CSV rows are collected in memory and written once at EOF.",
          verification: "npm test -- error-report.test.ts",
          scope: "in",
        },
      ],
    });
    expect(updateBriefCall.isError).toBe(false);

    // Inspect the updated ticket: Brief is now v2 with a unified diff, C1 kept its pass score, and C2 is marked added/todo.
    const ticketResponse = JSON.parse(
      (await flow.callAs(leadAgentId, "slp_board_get_ticket", { ticketId: "SLP-1" })).text,
    ) as BoardTicket;
    expect(ticketResponse.currentBriefRev).toBe(2);
    expect(ticketResponse.briefRevisions).toHaveLength(2);
    expect(ticketResponse.briefRevisions[1].reason).toContain("Switched from streaming writer");
    expect(ticketResponse.briefRevisions[1].diff).toContain("+ - [C2] Invalid CSV rows are collected in memory");

    const preservedBulletC1 = ticketResponse.items.find((bullet) => bullet.id === "C1")!;
    const addedBulletC2 = ticketResponse.items.find((bullet) => bullet.id === "C2")!;
    expect(preservedBulletC1.diffBadge).toBe("unchanged");
    expect(preservedBulletC1.status).toBe("pass");
    expect(preservedBulletC1.score?.status).toBe("pass");
    expect(addedBulletC2.diffBadge).toBe("added");
    expect(addedBulletC2.status).toBe("todo");

    // Lead resumes child peers; pausedAt is cleared and file writes inside the pipeline worktree are allowed again.
    const resumeCall = await flow.callAs(leadAgentId, "slp_resume_peers", {
      pipelineId,
      guidance: "Implement bullet C2 using the buffered batch approach.",
    });
    expect(resumeCall.isError).toBe(false);
    expect(flow.run(runId).agents[developerPeerId].pausedAt).toBeNull();

    await handlePermissionRequest(flow.ctx, developerPeerId, {
      id: "perm-resumed-write",
      name: "Write",
      kind: "edit",
      input: { file_path: `${flow.pipeline(runId, pipelineId)!.worktree}/src/index.ts` },
    } as never);
    const allowedWriteResponse = flow.gateway.permissionResponses.find(
      (entry) => entry.requestId === "perm-resumed-write",
    );
    expect(allowedWriteResponse?.response).toEqual({ behavior: "allow" });

    // Developer marks C2 as implemented via slp_board_update_item.
    const progressCall = await flow.callAs(developerPeerId, "slp_board_update_item", {
      ticketId: "SLP-1",
      itemId: "C2",
      status: "implemented",
      note: "Implemented buffered batch error collector in src/error-report.ts",
    });
    expect(progressCall.isError).toBe(false);
    await eventually(() => {
      const refreshedTicket = flow.ctx.store.board.find("SLP-1", flow.repoPath)!;
      expect(refreshedTicket.items.find((bullet) => bullet.id === "C2")?.status).toBe("implemented");
    });
  });

  it("reuses the pre-saved Kanban Spec ticket when the Supervisor drafts via slp_board_save_spec before slp_delegate", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    const supervisorAgentId = flow.run(runId).supervisorAgentId;

    // Supervisor drafts the 5-section Product Spec onto the Kanban board before human approval and delegation.
    const draftSpecCall = await flow.callAs(supervisorAgentId, "slp_board_save_spec", {
      title: "Fix Swim Colliders & Remove Debug Buttons",
      acceptanceCriteria: "Billing import works end to end and its behavior is independently verified.",
      spec: SAMPLE_PRODUCT_SPEC,
      summary: "Initial 5-section Product Spec draft for review",
    });
    expect(draftSpecCall.isError).toBe(false);
    const savedDraftPayload = JSON.parse(draftSpecCall.text) as { ticketKey: string; currentSpecRev: number };
    expect(savedDraftPayload.ticketKey).toBe("SLP-1");
    expect(savedDraftPayload.currentSpecRev).toBe(1);

    // After human approval, slp_delegate binds the spawned Lead to the existing SLP-1 ticket without creating SLP-2.
    await delegateToLead(flow, runId);
    const projectTickets = flow.ctx.store.board.listByRepo(flow.repoPath);
    expect(projectTickets).toHaveLength(1);
    expect(projectTickets[0].ticketKey).toBe("SLP-1");
    expect(projectTickets[0].title).toBe("Fix Swim Colliders & Remove Debug Buttons");
    expect(projectTickets[0].leadAgentId).toBe(flow.run(runId).masterLeadAgentId);
  });

  it("clones multi-version HTML/CSS/JS mockups under .slp/mockups/<feature>/versions/v<N>/ and supports element-tag review comments", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { invokeRpc } = createBoardRpcHarness(flow.ctx);
    const runId = await flow.startRun();
    const supervisorAgentId = flow.run(runId).supervisorAgentId;

    await flow.callAs(supervisorAgentId, "slp_board_save_spec", {
      title: "Quản lý đơn hàng",
      acceptanceCriteria: "Order management screen with checkout button and interactive cart.",
      spec: SAMPLE_PRODUCT_SPEC,
      summary: "Spec v1 for order management",
    });
    await delegateToLead(flow, runId);
    const leadAgentId = flow.run(runId).masterLeadAgentId;
    const leadWorktree = flow.run(runId).agents[leadAgentId].worktreePath ?? flow.repoPath;

    // Lead and mockup peers write Mockup v1 into .slp/mockups/quan-ly-don-hang/index.html + styles.css + app.js.
    const workingMockupDir = join(leadWorktree, ".slp", "mockups", "quan-ly-don-hang");
    await mkdir(workingMockupDir, { recursive: true });
    await writeFile(join(workingMockupDir, "styles.css"), ".btn-pay { background: #2563eb; }", "utf8");
    await writeFile(join(workingMockupDir, "app.js"), "window.__cartVersion = 1;", "utf8");
    await writeFile(
      join(workingMockupDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><button id="btn-pay" class="btn-pay">Thanh toán v1</button><script src="./app.js"></script></body></html>',
      "utf8",
    );

    const submitV1Call = await flow.callAs(leadAgentId, "slp_submit_mockup", {
      ticketId: "SLP-1",
      summary: "Mockup v1 with blue checkout button",
    });
    expect(submitV1Call.isError).toBe(false);

    // Verify v1 was cloned into .slp/mockups/quan-ly-don-hang/versions/v1/index.html and ticket moved to MOCKUP.
    const archivedV1Html = await readFile(
      join(flow.repoPath, ".slp", "mockups", "quan-ly-don-hang", "versions", "v1", "index.html"),
      "utf8",
    );
    expect(archivedV1Html).toContain("Thanh toán v1");

    // Human requests rework from the Kanban Mockup Preview Studio with a comment attached to `button#btn-pay`.
    const reworkOutcome = await invokeRpc<{ ticket: BoardTicket; notifiedAgentId: string | null }>(
      reviewBoardMockupFromUiRpc,
      {
        repoPath: flow.repoPath,
        runId,
        ticketId: "SLP-1",
        decision: "rework",
        version: 1,
        feedback: "Cập nhật giao diện nút thanh toán",
        elementComments: [
          {
            selector: "button#btn-pay",
            tagName: "button",
            elementText: "Thanh toán v1",
            comment: "Đổi nút sang màu xanh lá (#16a34a) và đổi chữ thành Thanh toán ngay v2",
          },
        ],
      },
    );
    expect(reworkOutcome.notifiedAgentId).toBe(leadAgentId);
    expect(reworkOutcome.ticket.mockupRevisions[0].status).toBe("rework_requested");
    expect(reworkOutcome.ticket.mockupRevisions[0].elementComments).toHaveLength(1);

    // Lead updates the working directory .slp/mockups/quan-ly-don-hang/index.html and submits v2.
    await writeFile(join(workingMockupDir, "styles.css"), ".btn-pay { background: #16a34a; }", "utf8");
    await writeFile(join(workingMockupDir, "app.js"), "window.__cartVersion = 2;", "utf8");
    await writeFile(
      join(workingMockupDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><button id="btn-pay" class="btn-pay">Thanh toán ngay v2</button><script src="./app.js"></script></body></html>',
      "utf8",
    );

    const submitV2Call = await flow.callAs(leadAgentId, "slp_submit_mockup", {
      ticketId: "SLP-1",
      summary: "Mockup v2 with green button per element comment on button#btn-pay",
    });
    expect(submitV2Call.isError).toBe(false);

    // Verify both v1 and v2 are preserved independently and readBoardMockupPreviewRpc bundles CSS + JS + inspector bridge for each.
    const previewV1 = await invokeRpc<{ bundledHtml: string }>(readBoardMockupPreviewRpc, {
      repoPath: flow.repoPath,
      ticketId: "SLP-1",
      version: 1,
    });
    const previewV2 = await invokeRpc<{ bundledHtml: string }>(readBoardMockupPreviewRpc, {
      repoPath: flow.repoPath,
      ticketId: "SLP-1",
      version: 2,
    });
    expect(previewV1.bundledHtml).toContain("Thanh toán v1");
    expect(previewV1.bundledHtml).toContain("background: #2563eb");
    expect(previewV1.bundledHtml).toContain("window.__cartVersion = 1;");
    expect(previewV2.bundledHtml).toContain("Thanh toán ngay v2");
    expect(previewV2.bundledHtml).toContain("background: #16a34a");
    expect(previewV2.bundledHtml).toContain("window.__cartVersion = 2;");
    expect(previewV2.bundledHtml).toContain("data-slp-mockup-inspector=\"true\"");

    // Approve v2 and verify approvedMockupRev is 2.
    const approveOutcome = await invokeRpc<{ ticket: BoardTicket }>(reviewBoardMockupFromUiRpc, {
      repoPath: flow.repoPath,
      runId,
      ticketId: "SLP-1",
      decision: "approve",
      version: 2,
    });
    expect(approveOutcome.ticket.approvedMockupRev).toBe(2);
    expect(approveOutcome.ticket.mockupRevisions[1].status).toBe("approved");
  });
});
