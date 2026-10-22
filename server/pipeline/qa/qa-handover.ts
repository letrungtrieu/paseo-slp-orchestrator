// Handover from the feature phase to the QA phase once the last feature branch lands on the QA branch.
// Feature Leads are retired so their sessions stop holding memory while the QA Lead's peers run heavy tools.
import type { Run } from "../../../shared/state";
import { qaHandoverBriefing } from "../../prompts/qa-messages";
import type { PipelineContext } from "../context";
import { stageMail } from "../stage-mail";
import { featurePipelinesOf } from "./qa-phase-state";

// How long the merging Lead may take to finish the turn that called slp_finalize_pipeline before it is archived anyway.
const MERGING_LEAD_IDLE_TIMEOUT_MS = 60_000;

// The merging Lead is excluded because archiving a session mid-tool-call would drop its finalize reply.
export async function retireIdleFeatureLeads(ctx: PipelineContext, runId: string, mergingLeadId: string): Promise<void> {
  const idleFeatureLeads = Object.values(ctx.store.require(runId).agents).filter(
    (agentRecord) => agentRecord.role === "master_lead" && agentRecord.agentId !== mergingLeadId && !agentRecord.archivedAt,
  );
  for (const featureLead of idleFeatureLeads) {
    await ctx.gateway.archive(featureLead.agentId).catch(() => undefined);
  }
}

// Runs inside the finalize mutation so the accountability switch and the QA Lead's mail commit together.
export function applyQaHandover(mutableRun: Run): void {
  // Repointing the accountable Lead lets existing revival, nudge and rework paths serve the QA Lead unchanged.
  mutableRun.masterLeadAgentId = mutableRun.qaLeadAgentId;
  // Planning makes slp_define_pipeline the QA Lead's owed tool until its QA pipeline starts.
  mutableRun.status = "planning";
  const qaLeadRecord = mutableRun.agents[mutableRun.qaLeadAgentId];
  if (qaLeadRecord) {
    qaLeadRecord.pipelineId = null;
    qaLeadRecord.stageId = null;
  }
  mutableRun.mailbox.push(
    stageMail(mutableRun.qaLeadAgentId, qaHandoverBriefing(mutableRun, featurePipelinesOf(mutableRun)), "slp_define_pipeline"),
  );
}

// Fire-and-forget: the finalize tool must return before the merging Lead can go idle.
export function retireMergingLeadWhenIdle(ctx: PipelineContext, runId: string, mergingLeadId: string): void {
  void (async () => {
    await ctx.gateway.waitForIdle(mergingLeadId, MERGING_LEAD_IDLE_TIMEOUT_MS).catch(() => undefined);
    const mergingLeadRecord = ctx.store.find(runId)?.agents[mergingLeadId];
    if (!mergingLeadRecord || mergingLeadRecord.archivedAt) return;
    await ctx.gateway.archive(mergingLeadId).catch(() => undefined);
  })().catch((retireError) => console.error("[slp] retiring merged feature Lead failed", retireError));
}
