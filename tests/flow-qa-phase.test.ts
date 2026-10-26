// Verifies the QA phase end to end: the QA Lead is spawned with the feature Leads, every Lead merges into the QA
// branch, QA starts only after the last merge, QA peers fork from the QA Lead in the QA worktree, and only the
// QA Lead reports to the Supervisor once a QA pipeline has closed.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepStageNudges } from "../server/hooks/lifecycle-hooks";
import { decidePermission } from "../server/hooks/permissions";
import { sweepPeerQuestions } from "../server/pipeline/peer-messaging/question-sweep";
import { inferRestoredRunStatus } from "../server/pipeline/run-restore";
import { useFlowFixture, type Flow } from "./helpers/flow-fixture";
import {
  DEFAULT_PIPELINE,
  QA_PIPELINE,
  delegateToLead,
  commitPipelineWork,
  completePipeline,
  eventually,
  startedRunWithPipeline,
  verifyAndReportFromQaLead,
} from "./helpers/flow-steps";
import { commitFiles } from "./helpers/git-fixture";
import { fileWriteRequest, shellRequest } from "./helpers/permission-request";

const createFlow = useFlowFixture();

// Brings a single-feature run to the moment the QA Lead receives the merged QA branch.
async function runMergedIntoQaBranch(flow: Flow): Promise<{ runId: string; featurePipelineId: string }> {
  const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
  commitPipelineWork(flow, runId, pipelineId, "src/feature.ts");
  await completePipeline(flow, runId, pipelineId);
  const featureLeadId = flow.pipeline(runId, pipelineId)!.stages.at(-1)!.forkedLeadAgentId!;
  const merged = await flow.callAs(featureLeadId, "slp_finalize_pipeline", { pipelineId, summary: "Feature merged; needs engine tests." });
  if (merged.isError) throw new Error(merged.text);
  return { runId, featurePipelineId: pipelineId };
}

async function defineQaPipeline(flow: Flow, runId: string, name = QA_PIPELINE.name): Promise<string> {
  const defined = await flow.callAs(flow.run(runId).qaLeadAgentId, "slp_define_pipeline", { pipeline: { ...QA_PIPELINE, name } });
  if (defined.isError) throw new Error(defined.text);
  const { pipelineId } = JSON.parse(defined.text) as { pipelineId: string };
  await eventually(() => {
    if (flow.pipeline(runId, pipelineId)?.status !== "running") throw new Error("QA stage is still starting");
  });
  return pipelineId;
}

describe("QA phase", () => {
  it("lets the QA Lead prepare alongside the feature Leads but rejects QA and reporting until every branch is merged", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const delegatedRun = flow.run(runId);
    const qaLeadId = delegatedRun.qaLeadAgentId;
    // Each side is introduced to the other, and the feature Lead learns that the QA branch is its merge target.
    const featureBriefing = flow.mailTo(runId, delegatedRun.masterLeadAgentId).at(-1)?.text ?? "";
    expect(featureBriefing).toContain(qaLeadId);
    expect(featureBriefing).toContain(delegatedRun.integrationBranch);
    expect(flow.mailTo(runId, qaLeadId).at(-1)?.text).toContain(delegatedRun.masterLeadAgentId);

    const earlyQaPipeline = await flow.callAs(qaLeadId, "slp_define_pipeline", { pipeline: QA_PIPELINE });
    expect(earlyQaPipeline.isError).toBe(true);
    expect(earlyQaPipeline.text).toContain("still being merged");

    const earlyReport = await flow.callAs(qaLeadId, "slp_report", { summary: "Nothing verified yet." });
    expect(earlyReport.isError).toBe(true);
  });

  it("runs QA in place on the QA branch with peers forked from the QA Lead and blocks the report until QA closes", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId } = await runMergedIntoQaBranch(flow);
    const handedOverRun = flow.run(runId);
    const qaLeadId = handedOverRun.qaLeadAgentId;

    const qaPipelineId = await defineQaPipeline(flow, runId);
    const qaPipeline = flow.pipeline(runId, qaPipelineId)!;
    // QA reuses the QA worktree and branch instead of opening yet another checkout.
    expect(qaPipeline).toMatchObject({ kind: "qa", worktree: handedOverRun.devCwd, branch: handedOverRun.integrationBranch, leadAgentId: qaLeadId });
    const qaPeerId = qaPipeline.stages[0].peerAgentIds[0];
    const qaPeerSpec = flow.gateway.createdAgents.find(({ record }) => record.agentId === qaPeerId)!.spec;
    expect(qaPeerSpec.peerWorktreePath).toBe(handedOverRun.devCwd);
    expect(qaPeerSpec.parentAgentId).toBe(qaLeadId);
    // With the default policy the grader starts clean (no fork), so it judges only what its briefing lists.
    expect(qaPeerSpec.extraOptions).toBeUndefined();

    // A fix made on the QA branch (by a verify-stage developer) is committed there directly.
    commitFiles(handedOverRun.devCwd, { "src/qa-fix.ts": "export const qaFixed = true;\n" }, "QA fix");
    await completePipeline(flow, runId, qaPipelineId);
    const prematureReport = await flow.callAs(qaLeadId, "slp_report", { summary: "Skipping closure." });
    expect(prematureReport.isError).toBe(true);
    expect(prematureReport.text).toContain("QA pipeline");

    const closed = await flow.callAs(qaLeadId, "slp_finalize_pipeline", { pipelineId: qaPipelineId, summary: "Suites green." });
    expect(closed.isError).toBe(false);
    expect(flow.gateway.archivedAgentIds).toContain(qaPeerId);
    expect(flow.run(runId).agents[qaLeadId].awaitingTool).toBe("slp_report");

    const report = await flow.callAs(qaLeadId, "slp_report", { summary: "Merged build verified." });
    expect(report.isError).toBe(false);
    const accepted = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", { report: "Đã xác minh." });
    expect(accepted.isError).toBe(false);
    // Both the feature work and the QA fix reach the base branch through the single QA branch merge.
    const baseFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: flow.repoPath, encoding: "utf8" });
    expect(baseFiles).toContain("src/feature.ts");
    expect(baseFiles).toContain("src/qa-fix.ts");
    expect(flow.run(runId).integrationBranch).toBe(flow.run(runId).baseBranch);
  });

  it("refuses to close a QA pipeline while QA fixes are uncommitted", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId } = await runMergedIntoQaBranch(flow);
    const qaPipelineId = await defineQaPipeline(flow, runId);
    await completePipeline(flow, runId, qaPipelineId);
    writeFileSync(join(flow.run(runId).devCwd, "uncommitted-fix.ts"), "export const lost = true;\n", "utf8");

    const closed = await flow.callAs(flow.run(runId).qaLeadAgentId, "slp_finalize_pipeline", { pipelineId: qaPipelineId, summary: "Done." });
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain("uncommitted or untracked");
  });

  it("routes Supervisor rework to the QA Lead for a fresh fix and re-verification pipeline", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId } = await runMergedIntoQaBranch(flow);
    await verifyAndReportFromQaLead(flow, runId);
    const qaLeadId = flow.run(runId).qaLeadAgentId;

    const rework = await flow.callAsRole(runId, "supervisor", null, "slp_request_rework", { feedback: "The save dialog still freezes on large files." });
    expect(rework.isError).toBe(false);
    expect(flow.run(runId).status).toBe("planning");
    const reworkMail = flow.mailTo(runId, qaLeadId).at(-1);
    expect(reworkMail?.awaitTool).toBe("slp_define_pipeline");
    expect(reworkMail?.text).toContain("save dialog still freezes");
    // No new feature Lead or worktree is opened; fixes happen on the QA branch.
    expect(flow.gateway.createdAgentsOfRole("master_lead")).toHaveLength(1);

    const secondPassId = await defineQaPipeline(flow, runId, "qa-fix-round-2");
    await completePipeline(flow, runId, secondPassId);
    expect((await flow.callAs(qaLeadId, "slp_finalize_pipeline", { pipelineId: secondPassId, summary: "Fixed." })).isError).toBe(false);
    expect((await flow.callAs(qaLeadId, "slp_report", { summary: "Freeze fixed and re-verified." })).isError).toBe(false);
    expect(flow.run(runId).status).toBe("reporting");
  });

  it("never turns a preparing QA Lead's unanswered question into a pipeline obligation", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);
    const { qaLeadAgentId, masterLeadAgentId } = flow.run(runId);
    // Nobody answers: the blocking call returns a pending notice after its wait window instead of hanging.
    const asked = await flow.callAs(qaLeadAgentId, "slp_ask", {
      toAgentId: masterLeadAgentId,
      question: "Which engine tests cover the save flow?",
    });
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain("slp_await_answer");
    // Let the question outlive its lifetime so the sweeper expires it and tells the asker to carry on.
    flow.ctx.questionTiming.questionTtlMs = 0;
    flow.gateway.markEveryAgentIdle();
    sweepPeerQuestions(flow.ctx, runId, await flow.gateway.liveStatuses(runId));
    sweepStageNudges(flow.ctx, runId, await flow.gateway.liveStatuses(runId));

    const qaLeadRecord = flow.run(runId).agents[qaLeadAgentId];
    // Expiry is plain information mail: it owes no pipeline tool, so a preparing QA Lead is never nudged into slp_define_pipeline.
    expect(qaLeadRecord.awaitingTool).toBeNull();
    const expiryMail = flow.mailTo(runId, qaLeadAgentId).at(-1);
    expect(expiryMail?.awaitTool).toBeNull();
    expect(expiryMail?.text).toContain("expired");
    expect(flow.store.questions.listForRun(runId, 5)[0]).toMatchObject({ status: "expired", expireReason: "timeout" });
  });

  it("restores a run archived right after the QA handover into planning so the QA Lead owes its pipeline", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId } = await runMergedIntoQaBranch(flow);
    expect(inferRestoredRunStatus(flow.run(runId))).toBe("planning");
    // Once the QA pipeline runs, the run resumes as running instead.
    await defineQaPipeline(flow, runId);
    expect(inferRestoredRunStatus(flow.run(runId))).toBe("running");
  });

  it("keeps the QA Lead read-only so every fix comes from a spawned peer", () => {
    const qaLeadContext = {
      role: "qa_lead" as const,
      agentCwd: "/work/qa",
      writableScope: [],
      pipelineId: "qa-pipeline",
      stageId: "verify",
      stageActive: true,
      archived: false,
    };
    expect(decidePermission(fileWriteRequest("src/fix.ts"), qaLeadContext).behavior).toBe("deny");
    expect(decidePermission(shellRequest("git commit -am fix"), qaLeadContext).behavior).toBe("deny");
    // Read-only inspection stays available so the QA Lead can review its peers' evidence.
    expect(decidePermission(shellRequest("git log --oneline -5"), qaLeadContext).behavior).toBe("allow");
  });
});
