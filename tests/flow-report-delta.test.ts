import { describe, expect, it } from "vitest";
import { useFlowFixture } from "./helpers/flow-fixture";
import { TWO_PEER_PIPELINE, currentStage, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

async function stageWithFirstRoundReviewed() {
  const flow = await createFlow({ mode: "FULL_AUTO" });
  const { runId, pipelineId } = await startedRunWithPipeline(flow, TWO_PEER_PIPELINE);
  const stage = currentStage(flow, runId, pipelineId);
  const coordinatorId = flow.agentId(runId, "forked_lead", stage.id);
  const reviewerId = flow.agentId(runId, "reviewer", stage.id);
  const architectId = flow.agentId(runId, "architect", stage.id);
  await reportPeer(flow, runId, pipelineId, "reviewer", "FIRST-ROUND reviewer finding about retries.");
  await reportPeer(flow, runId, pipelineId, "architect", "FIRST-ROUND architect design notes.");
  const reviewMails = () => flow.mailTo(runId, coordinatorId).filter((queuedMail) => queuedMail.awaitTool === "slp_approve_stage");
  return { flow, runId, pipelineId, coordinatorId, reviewerId, architectId, reviewMails };
}

describe("coordinator review mail", () => {
  it("sends the full stage briefing for the first review and only new evidence after a rework", async () => {
    const { flow, runId, pipelineId, coordinatorId, reviewerId, reviewMails } = await stageWithFirstRoundReviewed();
    const firstReview = reviewMails().at(-1)!.text;
    expect(firstReview).toContain("Submitted Stage Peer Reports");
    expect(firstReview).toContain("FIRST-ROUND reviewer finding");
    expect(firstReview).toContain("FIRST-ROUND architect design");

    // The Lead reads the first review, then asks the reviewer for another pass.
    await flow.deliverMail(runId);
    expect(reviewMails()).toHaveLength(0);
    const rework = await flow.callAs(coordinatorId, "slp_stage_rework", { agentIds: [reviewerId], feedback: "Cover the timeout path too." });
    expect(rework.isError).toBe(false);
    await reportPeer(flow, runId, pipelineId, "reviewer", "SECOND-ROUND reviewer verified the timeout path.");

    const secondReview = reviewMails().at(-1)!.text;
    expect(secondReview).toContain("New Peer Report(s)");
    expect(secondReview).toContain("SECOND-ROUND reviewer verified");
    expect(secondReview).toContain("3 total");
    // The coordinator already holds round one, so neither the briefing nor its reports are resent.
    expect(secondReview).not.toContain("FIRST-ROUND");
    expect(secondReview).not.toContain("Submitted Stage Peer Reports");
    expect(secondReview).toContain("slp_get_pipeline");
    expect(currentStage(flow, runId, pipelineId).coordinatorSeenReports).toBe(3);
  });

  it("falls back to the full briefing when the previous review mail was never delivered", async () => {
    const { flow, runId, pipelineId, coordinatorId, reviewerId, architectId, reviewMails } = await stageWithFirstRoundReviewed();
    await flow.deliverMail(runId);
    await flow.callAs(coordinatorId, "slp_stage_rework", { agentIds: [reviewerId], feedback: "Second pass please." });
    await reportPeer(flow, runId, pipelineId, "reviewer", "SECOND-ROUND reviewer note.");
    expect(reviewMails()).toHaveLength(1);

    // A third report arrives while the delta is still queued; replacing it with another delta would drop SECOND-ROUND.
    await flow.callAs(coordinatorId, "slp_stage_rework", { agentIds: [architectId], feedback: "Address the review." });
    await reportPeer(flow, runId, pipelineId, "architect", "THIRD-ROUND architect fix.");
    expect(reviewMails()).toHaveLength(1);
    const mergedReview = reviewMails()[0].text;
    expect(mergedReview).toContain("Submitted Stage Peer Reports");
    for (const marker of ["FIRST-ROUND reviewer", "SECOND-ROUND reviewer", "THIRD-ROUND architect"]) expect(mergedReview).toContain(marker);
  });
});
