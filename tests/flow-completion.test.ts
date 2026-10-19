import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PipelineDefinition } from "../shared/pipeline";
import { useFlowFixture } from "./helpers/flow-fixture";
import { DEFAULT_PIPELINE, approveCurrentStage, commitPipelineWork, completePipeline, currentStage, delegateToLead, eventually, reportPeer, startedRunWithPipeline } from "./helpers/flow-steps";

const createFlow = useFlowFixture();

describe("pipeline completion and integration", () => {
  it("creates a fresh peer cohort per stage, keeps prior peers alive across stages and merge consultation, and archives all cohorts on integration", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId } = await startedRunWithPipeline(flow, DEFAULT_PIPELINE);
    const firstStage = currentStage(flow, runId, pipelineId);
    const firstCohort = [...firstStage.peerAgentIds, firstStage.forkedLeadAgentId!];
    for (const assignment of firstStage.peers) await reportPeer(flow, runId, pipelineId, assignment.role);
    await approveCurrentStage(flow, runId, pipelineId);

    const secondStage = currentStage(flow, runId, pipelineId);
    expect(secondStage.id).not.toBe(firstStage.id);
    expect(secondStage.peerAgentIds.some((agentId) => firstCohort.includes(agentId))).toBe(false);
    // Stage 1 peers remain alive during Stage 2 for cross-stage consultation, and are listed in Stage 2's briefing.
    for (const peerAgentId of firstStage.peerAgentIds) {
      expect(flow.gateway.archivedAgentIds).not.toContain(peerAgentId);
    }
    const secondStageBriefing = flow.mailTo(runId, secondStage.peerAgentIds[0]).at(-1)?.text ?? "";
    expect(secondStageBriefing).toContain("Prior Stage Peers");
    expect(secondStageBriefing).toContain(firstStage.peerAgentIds[0]);
    expect(secondStage.peerAgentIds.map((agentId) => flow.run(runId).agents[agentId].projectRole)).toEqual(["developer"]);

    await completePipeline(flow, runId, pipelineId);
    const finalForkedLeadId = flow.pipeline(runId, pipelineId)!.stages.at(-1)!.forkedLeadAgentId!;
    // Peers remain alive while the Forked Lead prepares to merge the completed pipeline branch.
    for (const peerAgentId of firstStage.peerAgentIds) {
      expect(flow.gateway.archivedAgentIds).not.toContain(peerAgentId);
    }
    expect(flow.mailTo(runId, finalForkedLeadId).at(-1)?.awaitTool).toBe("slp_finalize_pipeline");
    // Flushing the mailbox must deliver slp_finalize_pipeline to the Forked Lead while pipeline.status is 'completed'.
    const deliveredFinalizeCount = await flow.deliverMail(runId);
    expect(deliveredFinalizeCount).toBeGreaterThanOrEqual(1);
    expect(flow.run(runId).agents[finalForkedLeadId].awaitingTool).toBe("slp_finalize_pipeline");

    const finalization = await flow.callAs(finalForkedLeadId, "slp_finalize_pipeline", {
      summary: "Forked Lead verified and merged the completed pipeline.",
    });
    expect(finalization.isError).toBe(false);
    for (const agentId of firstCohort) expect(flow.gateway.archivedAgentIds).toContain(agentId);
    expect(flow.gateway.archivedAgentIds).toContain(finalForkedLeadId);
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
    expect(flow.run(runId).agents[flow.run(runId).masterLeadAgentId].awaitingTool).toBe("slp_report");
    expect(flow.mailTo(runId, flow.run(runId).masterLeadAgentId)).toEqual([]);
    // Once finalized, the temporary local slp/* branch and worktree are removed so only the merged base branch remains.
    const remainingSlpBranches = execFileSync("git", ["branch", "--list", "slp/*"], {
      cwd: flow.repoPath,
      encoding: "utf8",
    }).trim();
    expect(remainingSlpBranches).toBe("");
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

  it("lets Forked Leads consult Peers and sibling Forked Leads on merge conflicts, hand consolidated summaries to Master Lead, run an End-User UAT pipeline, and auto-merge into baseBranch", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const { runId, pipelineId: firstPipelineId } = await startedRunWithPipeline(flow, {
      name: "feature-auth",
      version: "1.0.0",
      worktree: "pending",
      description: "Authentication feature pipeline",
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
    const askOwnPeer = await flow.callAs(secondForkedLeadId, "slp_send_peer_message", {
      toAgentId: secondDeveloperPeerId,
      message: "Why did you set mode=billing-only in shared-config.txt?",
      waitForReply: true,
    });
    expect(askOwnPeer.isError).toBe(false);
    expect(await flow.deliverMail(runId)).toBeGreaterThanOrEqual(1);
    const peerReply = await flow.callAs(secondDeveloperPeerId, "slp_send_peer_message", {
      toAgentId: secondForkedLeadId,
      message: "Billing needs billing enabled; we can combine it as mode=auth+billing.",
      waitForReply: false,
    });
    expect(peerReply.isError).toBe(false);
    expect(await flow.deliverMail(runId)).toBeGreaterThanOrEqual(1);

    const askSiblingLead = await flow.callAs(secondForkedLeadId, "slp_send_peer_message", {
      toAgentId: firstForkedLeadId,
      message: "Can we combine our shared-config.txt modes into mode=auth+billing?",
      waitForReply: true,
    });
    expect(askSiblingLead.isError).toBe(false);
    expect(await flow.deliverMail(runId)).toBeGreaterThanOrEqual(1);
    const siblingLeadReply = await flow.callAs(firstForkedLeadId, "slp_send_peer_message", {
      toAgentId: secondForkedLeadId,
      message: "Confirmed, mode=auth+billing preserves auth behavior.",
      waitForReply: false,
    });
    expect(siblingLeadReply.isError).toBe(false);
    expect(await flow.deliverMail(runId)).toBeGreaterThanOrEqual(1);

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

    // Both Forked Leads are now archived and Master Lead received the consolidated summary of both pipelines.
    expect(flow.gateway.archivedAgentIds).toContain(firstForkedLeadId);
    expect(flow.gateway.archivedAgentIds).toContain(secondForkedLeadId);
    const masterLeadHandover = flow.mailTo(runId, flow.run(runId).masterLeadAgentId).at(-1);
    expect(masterLeadHandover?.awaitTool).toBe("slp_report");
    expect(masterLeadHandover?.text).toContain("Auth feature merged");
    expect(masterLeadHandover?.text).toContain("Billing feature merged");

    // Master Lead spawns a final End-User UAT pipeline to verify the combined features before reporting.
    const uatWorktree = JSON.parse(
      (await flow.callAsRole(runId, "master_lead", null, "slp_create_worktree", { name: "end-user-uat" })).text,
    ) as { cwd: string };
    const uatDefined = JSON.parse(
      (
        await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
          pipeline: {
            name: "end-user-uat",
            version: "1.0.0",
            worktree: uatWorktree.cwd,
            description: "Final End-User UAT verification across merged features",
            stages: [{ name: "uat", goal: "Test combined auth+billing as end user", peers: [{ role: "end-user", task: "Verify mode=auth+billing end-to-end" }] }],
          },
        })
      ).text,
    ) as { pipelineId: string };
    await new Promise((resolve) => setTimeout(resolve, 40));
    await completePipeline(flow, runId, uatDefined.pipelineId);
    const uatForkedLeadId = flow.pipeline(runId, uatDefined.pipelineId)!.stages[0].forkedLeadAgentId!;
    const uatMerge = await flow.callAs(uatForkedLeadId, "slp_finalize_pipeline", {
      summary: "End-User UAT confirmed auth+billing works end-to-end.",
    });
    expect(uatMerge.isError).toBe(false);

    // Master Lead reports to Supervisor, and Supervisor's slp_present_to_manager auto-merges into baseBranch and completes the run.
    const leadReport = await flow.callAsRole(runId, "master_lead", null, "slp_report", {
      summary: "All features and End-User UAT passed.",
    });
    expect(leadReport.isError).toBe(false);
    const firstCycleMasterLeadId = flow.run(runId).masterLeadAgentId;
    const supervisorAccept = await flow.callAsRole(runId, "supervisor", null, "slp_present_to_manager", {
      report: "Đã kiểm thử UAT và tự động merge vào nhánh gốc.",
    });
    expect(supervisorAccept.isError).toBe(false);
    expect(flow.run(runId).status).toBe("completed");
    // Only the Supervisor remains alive after completion; the first cycle's Master Lead, Forked Leads and Peers are all archived.
    expect(flow.gateway.archivedAgentIds).not.toContain(flow.run(runId).supervisorAgentId);
    expect(flow.gateway.archivedAgentIds).toContain(firstCycleMasterLeadId);
    // Only owned pipeline peer worktree workspaces are archived; the shared Supervisor/Master Lead workspace stays open.
    expect(flow.paseo.archivedWorkspaceIds).not.toContain(flow.run(runId).supervisorWorkspaceId);
    expect(flow.paseo.archivedWorkspaceIds.length).toBeGreaterThanOrEqual(3);

    // Follow-up requirements in the same session automatically spawn a fresh Master Lead.
    const followUpDelegate = await flow.callAsRole(runId, "supervisor", null, "slp_delegate", {
      acceptanceCriteria: "Add audit logging for combined auth and billing actions.",
    });
    expect(followUpDelegate.isError).toBe(false);
    const secondCycleMasterLeadId = flow.run(runId).masterLeadAgentId;
    expect(secondCycleMasterLeadId).not.toBe(firstCycleMasterLeadId);
    expect(flow.gateway.archivedAgentIds).not.toContain(secondCycleMasterLeadId);
    expect(flow.run(runId).status).toBe("planning");
    expect(flow.mailTo(runId, secondCycleMasterLeadId).at(-1)?.awaitTool).toBe("slp_define_pipeline");
  });

  it("lets Master Lead split a spec into parallel tasks, forks one dedicated Forked Lead per task reused across stages, and serializes concurrent merges", async () => {
    const flow = await createFlow({ mode: "FULL_AUTO" });
    const runId = await flow.startRun();
    await delegateToLead(flow, runId);

    // Master Lead decomposes the spec into two parallel multi-stage task pipelines in a single tool call without pre-creating worktrees.
    const batchDefine = await flow.callAsRole(runId, "master_lead", null, "slp_define_pipeline", {
      pipelines: [
        {
          name: "parallel-task-api",
          description: "Build API endpoints",
          stages: [
            { name: "implement", goal: "Implement API", peers: [{ role: "developer", task: "Write API endpoints" }] },
            { name: "verify", goal: "Verify API", peers: [{ role: "qa-engineer", task: "Test API endpoints" }] },
          ],
        },
        {
          name: "parallel-task-ui",
          description: "Build UI components",
          stages: [
            { name: "implement", goal: "Implement UI", peers: [{ role: "developer", task: "Write UI views" }] },
            { name: "verify", goal: "Verify UI", peers: [{ role: "qa-engineer", task: "Test UI views" }] },
          ],
        },
      ],
    });
    expect(batchDefine.isError).toBe(false);
    const { pipelineIds } = JSON.parse(batchDefine.text) as { pipelineIds: string[] };
    expect(pipelineIds).toHaveLength(2);
    const [apiPipelineId, uiPipelineId] = pipelineIds;

    // Wait until both parallel pipelines have provisioned their worktrees and started their first stage concurrently.
    await eventually(() => {
      const apiPipeline = flow.pipeline(runId, apiPipelineId);
      const uiPipeline = flow.pipeline(runId, uiPipelineId);
      if (apiPipeline?.status !== "running" || uiPipeline?.status !== "running") {
        throw new Error("parallel pipelines are still starting");
      }
    });

    const apiStage1LeadId = currentStage(flow, runId, apiPipelineId).forkedLeadAgentId!;
    const uiStage1LeadId = currentStage(flow, runId, uiPipelineId).forkedLeadAgentId!;
    expect(apiStage1LeadId).not.toBe(uiStage1LeadId);
    expect(flow.run(runId).agents[apiStage1LeadId].parentAgentId).toBe(flow.run(runId).masterLeadAgentId);
    expect(flow.run(runId).agents[uiStage1LeadId].parentAgentId).toBe(flow.run(runId).masterLeadAgentId);

    // Advance both pipelines to Stage 2 and verify each task reuses its dedicated Forked Lead rather than spawning a second Forked Lead.
    await reportPeer(flow, runId, apiPipelineId, "developer", "API implemented");
    await reportPeer(flow, runId, uiPipelineId, "developer", "UI implemented");
    await approveCurrentStage(flow, runId, apiPipelineId, "API implementation approved");
    await approveCurrentStage(flow, runId, uiPipelineId, "UI implementation approved");

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
    const remainingLocalSlpBranches = execFileSync("git", ["branch", "--list", "slp/*"], {
      cwd: flow.repoPath,
      encoding: "utf8",
    }).trim();
    expect(remainingLocalSlpBranches).toBe("");
  });
});
