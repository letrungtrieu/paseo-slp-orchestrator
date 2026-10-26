import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PipelineDefinition } from "../shared/pipeline";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, SAMPLE_BRIEF, approveCurrentStage, askAndAnswer, commitPipelineWork, completePipeline, currentStage, delegateToLead, eventually, localSlpBranches, SAMPLE_PRODUCT_SPEC, reportPeer, startedRunWithPipeline, verifyAndReportFromQaLead } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("pipeline completion and integration", () => {
  it("creates a fresh cohort per stage, retires the advisors after planning, and archives the developer on integration", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const advisorCohort = [...firstStage.peerAgentIds];
    for (const assignment of firstStage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    const secondStage = currentStage(flow, runId, pipelineId);
    expect(secondStage.id).not.toBe(firstStage.id);
    expect(secondStage.peerAgentIds.some((agentId) => advisorCohort.includes(agentId))).toBe(false);
    // Advisors shaped the brief; they are retired so they cannot steer the build, and the developer reads the brief instead.
    await eventually(() => {
      for (const advisorAgentId of advisorCohort) expect(flow.gateway.archivedAgentIds).toContain(advisorAgentId);
    });
    const secondStageBriefing = flow.mailTo(runId, secondStage.peerAgentIds[0]).at(-1)?.text ?? "";
    expect(secondStageBriefing).toContain("Locked Brief");
    expect(secondStageBriefing).not.toContain("Prior Stage Peers");
    expect(secondStage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId].projectRole)).toEqual(["developer"]);

    await completePipeline(flow, runId, pipelineId);
    const owningLeadId = flow.pipeline(runId, pipelineId)!.stages.at(-1)!.forkedLeadAgentId!;
    const developerId = secondStage.peerAgentIds[0];
    // The developer stays alive while the Lead prepares to merge, so merge conflicts can still be explained.
    expect(flow.gateway.archivedAgentIds).not.toContain(developerId);
    expect(flow.mailTo(runId, owningLeadId).at(-1)?.awaitTool).toBe("slp_finalize_pipeline");
    // Flushing the mailbox must deliver slp_finalize_pipeline to the Lead while pipeline.status is 'completed'.
    const deliveredFinalizeCount = await flow.deliverMail(runId);
    expect(deliveredFinalizeCount).toBeGreaterThanOrEqual(1);
    expect(flow.run(runId).agents[owningLeadId].awaitingTool).toBe("slp_finalize_pipeline");

    const finalization = await flow.callAs(owningLeadId, "slp_finalize_pipeline", {
      summary: "Lead verified and merged the completed pipeline.",
    });
    expect(finalization.isError).toBe(false);
    expect(flow.gateway.archivedAgentIds).toContain(developerId);
    // The merge ends the feature Lead's duty; the QA Lead now owes its QA pipeline instead of the Lead owing a report.
    expect(flow.run(runId).agents[owningLeadId].awaitingTool).toBeNull();
    expect(flow.run(runId).masterLeadAgentId).toBe(flow.run(runId).qaLeadAgentId);
    expect(flow.mailTo(runId, flow.run(runId).qaLeadAgentId).at(-1)?.awaitTool).toBe("slp_define_pipeline");
  });

  it("accepts and integrates a completed Lead-authored pipeline and deletes its local slp/* branch after merge", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const definition: PipelineDefinition = { ...DEFAULT_PIPELINE, name: "integrated-pipeline" };
    const { runId, pipelineId } = await startedRunWithPipeline(flow, definition);
    const activePipelineBranch = flow.pipeline(runId, pipelineId)!.branch!;
    // While the pipeline is running, its slp/* branch is bound to a non-pushable local remote so it cannot be pushed to origin.
    const configuredPushRemote = execFileSync("git", ["config", `branch.${activePipelineBranch}.pushRemote`], {
      cwd: flow.repoPath,
      encoding: "utf8",
    }).trim();
    expect(configuredPushRemote).toBe("slp-local-only");
    commitPipelineWork(flow, runId, pipelineId);
    await completePipeline(flow, runId, pipelineId);

    const finalization = await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", {
      pipelineId,
      summary: "All declared stages were approved and integrated.",
    });
    expect(finalization.isError).toBe(false);
    expect(flow.pipeline(runId, pipelineId)).toMatchObject({ status: "integrated", finalReport: "All declared stages were approved and integrated." });
    // The feature branch landed on the QA branch, which the QA Lead now owns.
    const mergedRun = flow.run(runId);
    expect(execFileSync("git", ["log", "--format=%s", "-1"], { cwd: mergedRun.devCwd, encoding: "utf8" }).trim())
      .toBe("SLP: merge pipeline integrated-pipeline");
    expect(mergedRun.masterLeadAgentId).toBe(mergedRun.qaLeadAgentId);
    // The feature slp/* branch is deleted after merge; only the QA branch survives because QA still runs on it.
    expect(localSlpBranches(flow)).toEqual([mergedRun.integrationBranch]);
  });

  it("rejects integration until every declared stage is approved", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const response = await flow.callAsRole(runId, "master_lead", null, "slp_finalize_pipeline", {
      pipelineId,
      summary: "Too early",
    });

    expect(response).toMatchObject({ isError: true });
    expect(response.text).toContain("stage must be completed");
    expect(flow.pipeline(runId, pipelineId)!.status).not.toBe("integrated");
  });

  it("lets Forked Leads consult Peers and sibling Forked Leads on merge conflicts, hand consolidated summaries to Master Lead, and auto-merge into baseBranch", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId: firstPipelineId } = await startedRunWithPipeline(flow, {
      name: "feature-auth",
      version: "1.0.0",
      worktree: "pending",
      description: "Authentication feature pipeline",
      brief: SAMPLE_BRIEF,
      stages: [{ name: "impl", goal: "Implement auth config", peers: [{ role: "developer", task: "Add auth setting" }] }],
    });
    // Define a second concurrent feature pipeline touching the same shared file to trigger a merge conflict.
    const secondWorktree = JSON.parse(
      (await flow.callAsRole(runId, "master_lead", null, "slp_create_worktree", { name: "feature-billing" })).text,
    ) as { cwd: string };
    const secondDefined = JSON.parse(
      (
        await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
          pipeline: {
            name: "feature-billing",
            version: "1.0.0",
            worktree: secondWorktree.cwd,
            description: "Billing feature pipeline",
            brief: SAMPLE_BRIEF,
            stages: [{ name: "impl", goal: "Implement billing config", peers: [{ role: "developer", task: "Add billing setting" }] }],
          },
        })
      ).text,
    ) as { pipelineId: string };
    const secondPipelineId = secondDefined.pipelineId;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Commit conflicting edits to shared-config.txt in both pipeline worktrees.
    const firstPipeline = flow.pipeline(runId, firstPipelineId)!;
    const secondPipeline = flow.pipeline(runId, secondPipelineId)!;
    writeFileSync(join(firstPipeline.worktree, "shared-config.txt"), "mode=auth-only\n", "utf8");
    execFileSync("git", ["add", "shared-config.txt"], { cwd: firstPipeline.worktree });
    execFileSync("git", ["commit", "-m", "Add auth config"], { cwd: firstPipeline.worktree });

    writeFileSync(join(secondPipeline.worktree, "shared-config.txt"), "mode=billing-only\n", "utf8");
    execFileSync("git", ["add", "shared-config.txt"], { cwd: secondPipeline.worktree });
    execFileSync("git", ["commit", "-m", "Add billing config"], { cwd: secondPipeline.worktree });

    await completePipeline(flow, runId, firstPipelineId);
    await completePipeline(flow, runId, secondPipelineId);

    const firstForkedLeadId = flow.pipeline(runId, firstPipelineId)!.stages[0].forkedLeadAgentId!;
    const secondForkedLeadId = flow.pipeline(runId, secondPipelineId)!.stages[0].forkedLeadAgentId!;
    const secondDeveloperPeerId = flow.pipeline(runId, secondPipelineId)!.stages[0].peerAgentIds[0];

    // First Forked Lead merges cleanly into integrationBranch; its Forked Lead stays alive while the second pipeline is still unintegrated.
    const firstMerge = await flow.callAs(firstForkedLeadId, "slp_finalize_pipeline", {
      summary: "Auth feature merged with mode=auth-only.",
    });
    expect(firstMerge.isError).toBe(false);
    expect(flow.gateway.archivedAgentIds).not.toContain(firstForkedLeadId);

    // Second Forked Lead attempts to merge and hits a conflict with the first pipeline's changes.
    const conflictAttempt = await flow.callAs(secondForkedLeadId, "slp_finalize_pipeline", {
      summary: "Attempt billing merge.",
    });
    expect(conflictAttempt.isError).toBe(true);
    expect(conflictAttempt.text).toContain("shared-config.txt");
    expect(conflictAttempt.text).toContain(secondDeveloperPeerId);
    expect(conflictAttempt.text).toContain(firstForkedLeadId);

    // Second Forked Lead asks its developer Peer why mode=billing-only was written, and also consults the first Forked Lead.
    const ownPeerExchange = await askAndAnswer(
      flow,
      secondForkedLeadId,
      secondDeveloperPeerId,
      "Why did you set mode=billing-only in shared-config.txt?",
      "Billing needs billing enabled; we can combine it as mode=auth+billing.",
    );
    expect(ownPeerExchange.askOutcome.isError).toBe(false);
    expect(ownPeerExchange.askOutcome.text).toContain("mode=auth+billing");
    expect(flow.store.questions.require(ownPeerExchange.questionId).scope).toBe("merge");

    const siblingLeadExchange = await askAndAnswer(
      flow,
      secondForkedLeadId,
      firstForkedLeadId,
      "Can we combine our shared-config.txt modes into mode=auth+billing?",
      "Confirmed, mode=auth+billing preserves auth behavior.",
    );
    expect(siblingLeadExchange.askOutcome.isError).toBe(false);
    expect(siblingLeadExchange.askOutcome.text).toContain("Confirmed");

    // Second Forked Lead resolves the conflict in its worktree by merging integrationBranch and committing the combined config.
    const integrationBranch = flow.run(runId).integrationBranch;
    try {
      execFileSync("git", ["merge", integrationBranch], { cwd: secondPipeline.worktree });
    } catch {
      // Expected conflict during git merge; resolve and commit below.
    }
    writeFileSync(join(secondPipeline.worktree, "shared-config.txt"), "mode=auth+billing\n", "utf8");
    execFileSync("git", ["add", "shared-config.txt"], { cwd: secondPipeline.worktree });
    execFileSync("git", ["commit", "-m", "Resolve conflict between auth and billing"], { cwd: secondPipeline.worktree });

    const secondMerge = await flow.callAs(secondForkedLeadId, "slp_finalize_pipeline", {
      summary: "Billing feature merged and conflict resolved with mode=auth+billing.",
    });
    expect(secondMerge.isError).toBe(false);

    // Every feature Lead is retired once all branches are merged; the QA Lead receives both summaries.
    expect(flow.gateway.archivedAgentIds).toContain(firstForkedLeadId);
    await eventually(() => expect(flow.gateway.archivedAgentIds).toContain(secondForkedLeadId));
    const qaLeadHandover = flow.mailTo(runId, flow.run(runId).qaLeadAgentId).at(-1);
    expect(qaLeadHandover?.awaitTool).toBe("slp_define_pipeline");
    expect(qaLeadHandover?.text).toContain("Auth feature merged");
    expect(qaLeadHandover?.text).toContain("Billing feature merged");

    // The QA Lead verifies and reports, and Supervisor's slp_present_to_manager merges the QA branch into baseBranch.
    await verifyAndReportFromQaLead(flow, runId, "Auth and billing features verified together on the QA branch.");
    const firstCycleMasterLeadId = flow.run(runId).masterLeadAgentId;
    const supervisorAccept = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", {
      report: "Đã kiểm tra nhánh tích hợp và tự động merge vào nhánh gốc.",
    });
    expect(supervisorAccept.isError).toBe(false);
    expect(flow.run(runId).status).toBe("completed");
    // The resolved conflict reached the human's base branch through the QA branch.
    expect(execFileSync("git", ["show", "HEAD:shared-config.txt"], { cwd: flow.repoPath, encoding: "utf8" })).toBe("mode=auth+billing\n");
    // Only the Supervisor remains alive after completion; the first cycle's Master Lead, Forked Leads and Peers are all archived.
    expect(flow.gateway.archivedAgentIds).not.toContain(flow.run(runId).supervisorAgentId);
    expect(flow.gateway.archivedAgentIds).toContain(firstCycleMasterLeadId);
    // Only owned pipeline peer worktree workspaces are archived; the shared Supervisor/Master Lead workspace stays open.
    expect(flow.paseo.archivedWorkspaceIds).not.toContain(flow.run(runId).supervisorWorkspaceId);
    expect(flow.paseo.archivedWorkspaceIds.length).toBeGreaterThanOrEqual(3);

    // Follow-up requirements in the same session automatically spawn a fresh Master Lead and a fresh QA Lead.
    const followUpDelegate = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Add audit logging for combined auth and billing actions.",
      productSpec: SAMPLE_PRODUCT_SPEC,
    });
    expect(followUpDelegate.isError).toBe(false);
    const secondCycleMasterLeadId = flow.run(runId).masterLeadAgentId;
    expect(secondCycleMasterLeadId).not.toBe(firstCycleMasterLeadId);
    expect(flow.gateway.archivedAgentIds).not.toContain(secondCycleMasterLeadId);
    expect(flow.run(runId).status).toBe("planning");
    expect(flow.mailTo(runId, secondCycleMasterLeadId).at(-1)?.awaitTool).toBe("slp_define_pipeline");
    expect(flow.run(runId).agents[flow.run(runId).qaLeadAgentId].role).toBe("qa_lead");
    expect(flow.run(runId).qaLeadAgentId).not.toBe(firstCycleMasterLeadId);
  });

  it("lets Master Lead split a spec into parallel tasks, forks one dedicated Forked Lead per task reused across stages, and serializes concurrent merges", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);

    // Master Lead decomposes the spec into two parallel planning -> implement pipelines in a single tool call without pre-creating worktrees.
    const batchDefine = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
      pipelines: [
        {
          name: "parallel-task-api",
          description: "Build API endpoints",
          stages: [
            { name: "plan", goal: "Plan API", peers: [{ role: "architect", task: "Design API endpoints" }] },
            { name: "implement", goal: "Implement API", peers: [{ role: "developer", task: "Write API endpoints" }] },
          ],
        },
        {
          name: "parallel-task-ui",
          description: "Build UI components",
          stages: [
            { name: "plan", goal: "Plan UI", peers: [{ role: "architect", task: "Design UI views" }] },
            { name: "implement", goal: "Implement UI", peers: [{ role: "developer", task: "Write UI views" }] },
          ],
        },
      ],
    });
    expect(batchDefine.isError).toBe(false);
    const { pipelineIds } = JSON.parse(batchDefine.text) as { pipelineIds: string[] };
    expect(pipelineIds).toHaveLength(2);
    const [apiPipelineId, uiPipelineId] = pipelineIds;

    // Wait until both parallel pipelines have provisioned their worktrees and started Stage 1 concurrently.
    await eventually(() => {
      const apiPipeline = flow.pipeline(runId, apiPipelineId);
      const uiPipeline = flow.pipeline(runId, uiPipelineId);
      if (apiPipeline?.status !== "running" || uiPipeline?.status !== "running") {
        throw new Error("parallel pipelines are still starting stage 1");
      }
    });

    const apiStage1LeadId = currentStage(flow, runId, apiPipelineId).forkedLeadAgentId!;
    const uiStage1LeadId = currentStage(flow, runId, uiPipelineId).forkedLeadAgentId!;
    expect(apiStage1LeadId).not.toBe(uiStage1LeadId);
    expect(apiStage1LeadId).toBe(flow.run(runId).masterLeadAgentId);
    expect(flow.run(runId).agents[uiStage1LeadId].parentAgentId).toBe(flow.run(runId).masterLeadAgentId);

    // Advance both pipelines to Stage 2 and verify each task reuses its dedicated Forked Lead rather than spawning a second Forked Lead.
    await reportPeer(flow, runId, apiPipelineId, "architect", "API designed");
    await reportPeer(flow, runId, uiPipelineId, "architect", "UI designed");
    await approveCurrentStage(flow, runId, apiPipelineId, "API plan approved");
    await approveCurrentStage(flow, runId, uiPipelineId, "UI plan approved");

    expect(currentStage(flow, runId, apiPipelineId).forkedLeadAgentId).toBe(apiStage1LeadId);
    expect(currentStage(flow, runId, uiPipelineId).forkedLeadAgentId).toBe(uiStage1LeadId);

    // Commit distinct files in each worktree, finish Stage 2 in parallel, and invoke slp_finalize_pipeline concurrently from both Forked Leads.
    commitPipelineWork(flow, runId, apiPipelineId, "src/api.ts");
    commitPipelineWork(flow, runId, uiPipelineId, "src/ui.ts");
    await completePipeline(flow, runId, apiPipelineId);
    await completePipeline(flow, runId, uiPipelineId);

    // Simulate an extra local slp/<runId8>/* helper branch created during the run to verify full cleanup after merge.
    execFileSync("git", ["branch", `slp/${runId.slice(0, 8)}/temporary-helper`], { cwd: flow.repoPath });

    const [apiMergeResult, uiMergeResult] = await Promise.all([
      flow.callAs(apiStage1LeadId, "slp_finalize_pipeline", { summary: "API task verified and merged." }),
      flow.callAs(uiStage1LeadId, "slp_finalize_pipeline", { summary: "UI task verified and merged." }),
    ]);
    expect(apiMergeResult.isError).toBe(false);
    expect(uiMergeResult.isError).toBe(false);
    expect(flow.pipeline(runId, apiPipelineId)?.status).toBe("integrated");
    expect(flow.pipeline(runId, uiPipelineId)?.status).toBe("integrated");
    // Feature and helper branches are swept; the QA branch stays because the QA Lead verifies on it next.
    expect(localSlpBranches(flow)).toEqual([flow.run(runId).integrationBranch]);
  });

  it("keeps a Lead's dedicated workspace open during slp_finalize_pipeline and flushes the QA Lead's Supervisor report immediately", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const leadAgentId = flow.run(runId).masterLeadAgentId;
    const pipelineWorkspaceId = flow.pipeline(runId, pipelineId)!.workspaceId!;

    commitPipelineWork(flow, runId, pipelineId);
    await completePipeline(flow, runId, pipelineId);
    await flow.deliverMail(runId);

    // Record the Lead's awaitingSince timestamp before slp_finalize_pipeline runs.
    const finalizeAwaitingSince = flow.run(runId).agents[leadAgentId].awaitingSince;
    expect(finalizeAwaitingSince).toBeTruthy();

    const finalizeResponse = await flow.callAs(leadAgentId, "slp_finalize_pipeline", {
      pipelineId,
      summary: "Pipeline integrated cleanly from Lead worktree.",
    });
    expect(finalizeResponse.isError).toBe(false);

    // The Lead's workspace must NOT be archived mid-turn during slp_finalize_pipeline so Paseo does not cascade-archive the Lead before its reply.
    expect(flow.paseo.archivedWorkspaceIds).not.toContain(pipelineWorkspaceId);
    expect(flow.run(runId).agents[leadAgentId].awaitingTool).toBeNull();
    // The merged feature Lead is retired once idle, so it can neither report nor skip QA.
    await eventually(() => expect(flow.gateway.archivedAgentIds).toContain(leadAgentId));
    const featureLeadReport = await flow.callAs(leadAgentId, "slp_report", { summary: "Trying to skip QA." });
    expect(featureLeadReport.isError).toBe(true);

    // The QA Lead's report queues the Supervisor's notification and delivering mail stamps slp_present_to_manager on Supervisor.
    await verifyAndReportFromQaLead(flow, runId, "All tasks integrated and verified for Supervisor.");
    const supervisorId = flow.run(runId).supervisorAgentId;
    expect(flow.mailTo(runId, supervisorId).at(-1)?.awaitTool).toBe("slp_present_to_manager");
    await flow.deliverMail(runId);
    expect(flow.run(runId).agents[supervisorId].awaitingTool).toBe("slp_present_to_manager");
  });
});
