// Markdown building blocks for stage mail: the locked brief, graded scorecards and the capped-rework decision request.
import type { PipelineBrief, PipelineState, StageState } from "../../shared/pipeline";
import type { PeerKind } from "../../shared/project-prompts";
import type { Run } from "../../shared/state";

export function formatBrief(brief: PipelineBrief): string {
  const criteriaLines = brief.criteria.map((criterion) => `- **${criterion.id}**: ${criterion.requirement} — _verify:_ ${criterion.verification}`);
  return [
    `**Approach**: ${brief.approach}`,
    `**Criteria**\n${criteriaLines.join("\n")}`,
    `**In scope**\n${brief.inScope.map((scopeItem) => `- ${scopeItem}`).join("\n")}`,
    `**Out of scope (do not build)**\n${brief.outOfScope.length ? brief.outOfScope.map((scopeItem) => `- ${scopeItem}`).join("\n") : "- Anything not listed in scope"}`,
  ].join("\n\n");
}

// A QA pipeline grades what the feature pipelines promised, so without its own brief it shows their locked briefs.
export function briefSection(run: Run, pipeline: PipelineState): string | null {
  if (pipeline.brief) return `### Locked Brief (the contract for this pipeline)\n${formatBrief(pipeline.brief)}`;
  if (pipeline.kind !== "qa") return null;
  const featureBriefs = Object.values(run.pipelines).filter((candidate) => candidate.kind === "feature" && candidate.brief);
  if (featureBriefs.length === 0) return "### Criteria To Grade\nUse the Given/When/Then scenarios of the product spec (slp_get_run → productSpec) as the criteria.";
  return [
    "### Criteria To Grade (locked feature briefs; also grade the product spec scenarios from slp_get_run)",
    ...featureBriefs.map((featurePipeline) => `#### Feature ${featurePipeline.name}\n${formatBrief(featurePipeline.brief!)}`),
  ].join("\n\n");
}

// Each kind gets one short instruction set; peers never coordinate with each other, only with their Lead.
export function peerKindGuidance(peerKind: PeerKind, stage: StageState): string {
  if (stage.kind === "mockup") {
    return "You are an engineer peer in the **mockup** stage. Analyze your assigned portion of the Product Spec and help assemble a self-contained, interactive HTML/CSS/JS mockup under `.slp/mockups/<feature>/` with a required `index.html` entry point (and optional relative `.css` / `.js` files). Do not modify production source files outside `.slp/mockups/`. Report your mockup analysis or written HTML/CSS/JS sections to the Lead via `slp_stage_report`.";
  }
  if (peerKind === "advisor") {
    return "You are an **advisor** in the planning stage. You do not write code. Investigate the techniques or design options that fit this problem, discuss them with the Lead (slp_ask/slp_answer with the Lead only), and report a concise recommendation with slp_stage_report: chosen option, why, main risks, and what to leave out. Prefer the simplest option that meets the acceptance criteria.";
  }
  if (peerKind === "qa") {
    return "You are a **QA grader**. You do not fix code and you do not contact other peers. Grade every criterion listed below against the current worktree and submit slp_stage_report with scorecard: one entry per criterion { criterionId, status: pass|fail|blocked, reason, evidence }. Record anything outside the criteria in observations; it is for the Lead's judgement and is not graded.";
  }
  const verifyNote = stage.kind === "verify"
    ? " In this verify stage you only act when the Lead sends you a fix request; after your fix the QA peers re-grade automatically."
    : "";
  return `You are the **only developer** of this pipeline. Build exactly what the locked brief describes: everything in scope, nothing out of scope, no extra abstractions or features. If the brief is wrong or not buildable as written, call slp_escalate instead of improvising. Ask only the Lead when something is unclear. Report what you changed, the commands you ran and their results with slp_stage_report.${verifyNote}`;
}

export function formatStageReports(reports: StageState["reports"]): string {
  return reports.map((peerReport) => {
    const findingsText = peerReport.findings.length > 0
      ? `\n  Findings:\n${peerReport.findings.map((finding) => `  - ${finding}`).join("\n")}`
      : "";
    // The scorecard is rendered as a table so the Lead can decide from it without reopening raw evidence.
    const scorecardText = peerReport.scorecard?.length
      ? `\n\n  | Criterion | Status | Reason | Evidence |\n  | --- | --- | --- | --- |\n${peerReport.scorecard.map((entry) => `  | ${entry.criterionId} | ${entry.status} | ${entry.reason} | ${entry.evidence || "-"} |`).join("\n")}`
      : "";
    const observationsText = peerReport.observations?.length
      ? `\n  Observations (outside the criteria):\n${peerReport.observations.map((observation) => `  - ${observation}`).join("\n")}`
      : "";
    return `- **${peerReport.role}** (\`${peerReport.agentId}\`) [${peerReport.status}]: ${peerReport.summary}${findingsText}${scorecardText}${observationsText}`;
  }).join("\n");
}

// The Supervisor gets the latest result per peer so the human sees the current scorecard, not the whole history.
export function humanDecisionRequest(
  pipeline: PipelineState,
  stage: StageState,
  leadAgentId: string,
  leadReason: string,
  maxReworkRounds: number,
): string {
  const latestReportByAgent = new Map(stage.reports.map((peerReport) => [peerReport.agentId, peerReport]));
  return [
    `## Human decision needed: pipeline '${pipeline.name}' (\`${pipeline.id}\`), stage '${stage.name}'`,
    `The Lead (\`${leadAgentId}\`) used all ${maxReworkRounds} rework rounds without accepting the result and escalated:\n${leadReason}`,
    pipeline.brief ? `### Locked Brief\n${formatBrief(pipeline.brief)}` : "",
    latestReportByAgent.size ? `### Latest Results\n${formatStageReports([...latestReportByAgent.values()])}` : "",
    [
      "### What To Do",
      "1. Present this to the human in Vietnamese: what passes, what still fails and why, and the Lead's recommendation.",
      "2. Ask for the final decision (accept as is, rework with specific guidance, or drop/adjust scope) and end your turn.",
      `3. When the human answers, call slp_relay_decision({ pipelineId: "${pipeline.id}", decision }) with their decision verbatim.`,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}
