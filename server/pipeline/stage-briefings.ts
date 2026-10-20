// Every fresh cohort receives the same goal, roster and durable handover before any peer starts work.
import {
  BASE_PEER_ROLE_ID,
  PEER_UNDERSTAND_STAGE_ID,
  type PipelineState,
  type StageState,
} from "../../shared/pipeline";
import type { Run } from "../../shared/state";
import type { StagePromptContext } from "../prompts/system-prompts";

// Adapts pipeline.peerUnderstand into a StageState view so stage report, message, rework, and approval
// handlers operate on the pre-stage discovery phase without duplicating protocol state machines.
export function buildPeerUnderstandStageView(pipeline: PipelineState): StageState {
  const peerUnderstandState = pipeline.peerUnderstand;
  const stageOverviewSummary = pipeline.stages.length > 0
    ? pipeline.stages
        .map((stageDefinition, stageIndex) => `${stageIndex + 1}. ${stageDefinition.name}: ${stageDefinition.goal}`)
        .join(" | ")
    : "stages to be created by Forked Lead after mutual understanding is confirmed";
  const investigationGoalDetail = peerUnderstandState.investigationGoal
    ? ` Investigation goal: ${peerUnderstandState.investigationGoal}`
    : "";
  return {
    id: PEER_UNDERSTAND_STAGE_ID,
    name: PEER_UNDERSTAND_STAGE_ID,
    goal: `Investigate the project and align with the Forked Lead on the root problem and task expectations for pipeline '${pipeline.name}' (${stageOverviewSummary}).${investigationGoalDetail}`,
    peers: [
      {
        role: BASE_PEER_ROLE_ID,
        task: peerUnderstandState.investigationGoal ?? pipeline.description,
      },
    ],
    status: peerUnderstandState.status,
    forkedLeadAgentId: peerUnderstandState.forkedLeadAgentId,
    // Keep the active base_peer in peerAgentIds[0] so direct messaging and rework target it like a single-peer stage.
    peerAgentIds: peerUnderstandState.basePeerAgentId ? [peerUnderstandState.basePeerAgentId] : [],
    // Reference the persisted arrays directly so mutations inside store.mutate update pipeline.peerUnderstand in place.
    reports: peerUnderstandState.reports,
    messages: peerUnderstandState.messages,
    result: peerUnderstandState.result,
    startedAt: peerUnderstandState.startedAt,
    completedAt: peerUnderstandState.completedAt,
  };
}

// Builds the system prompt stage assignment injected into Forked Lead and Base Peer during peer_understand.
export function peerUnderstandPromptContext(pipeline: PipelineState, assignedTask: string): StagePromptContext {
  const syntheticStageView = buildPeerUnderstandStageView(pipeline);
  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    stageId: PEER_UNDERSTAND_STAGE_ID,
    stageName: PEER_UNDERSTAND_STAGE_ID,
    goal: syntheticStageView.goal,
    task: assignedTask,
    worktree: pipeline.worktree,
    peerRoster: syntheticStageView.peers,
    priorResults: [],
    history: pipeline.peerUnderstand.messages.map(
      (exchangeMessage) => `${exchangeMessage.fromAgentId} -> ${exchangeMessage.toAgentId}: ${exchangeMessage.message}`,
    ),
  };
}

// Prompts Forked Lead at the start of peer_understand to formulate the investigation goal for Base Peer before stages are created.
export function coordinatorPeerUnderstandGoalBriefing(run: Run, pipeline: PipelineState): string {
  const basePeerId = pipeline.peerUnderstand.basePeerAgentId ?? "pending";
  return [
    `You are the **Forked Lead** owning task pipeline **${pipeline.name}** (\`${pipeline.id}\`) in the **\`${PEER_UNDERSTAND_STAGE_ID}\`** phase.`,
    `### Task Description\n${pipeline.description}`,
    run.criteria ? `### Overall Acceptance Criteria\n${run.criteria}` : "",
    [
      "### Step 1: Set the Investigation Goal for Base Peer",
      `- **Worktree**: \`${pipeline.worktree}\``,
      `- **Base Peer**: \`${basePeerId}\``,
      `1. Formulate a concrete **investigation goal** specifying which modules, files, architectural boundaries, and input/logic/output contracts Base Peer must investigate in \`${pipeline.worktree}\`.`,
      `2. Send your investigation goal to Base Peer now via \`slp_send_peer_message({ toAgentId: "${basePeerId}", message: "<investigation goal and concrete questions>", waitForReply: true })\`.`,
      `3. After Base Peer investigates and both of you confirm mutual understanding via \`slp_stage_report\`, you will create the concrete pipeline stages via \`slp_define_pipeline({ pipelineId: "${pipeline.id}", summary, stages: [...] })\` (or \`slp_approve_stage({ summary, stages: [...] })\`).`,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

// Formats the initial discovery briefing delivered to base_peer when peer_understand starts or when Forked Lead sends the investigation goal.
export function basePeerUnderstandBriefing(run: Run, pipeline: PipelineState): string {
  const upcomingStageLines = pipeline.stages.map((upcomingStage, stageIndex) => {
    const assignedRoles = upcomingStage.peers
      .map((peerAssignment) => `${peerAssignment.role} (${peerAssignment.task})`)
      .join("; ");
    return `- **Stage ${stageIndex + 1}: ${upcomingStage.name}** — Goal: ${upcomingStage.goal}\n  Assigned peers: ${assignedRoles}`;
  });
  // Include Forked Lead's investigation goal and ID so base_peer aligns with Forked Lead before pipeline stages are finalized.
  const briefingSections = [
    `You are the **Base Peer** (\`${BASE_PEER_ROLE_ID}\`) in the pre-pipeline **\`${PEER_UNDERSTAND_STAGE_ID}\`** phase for pipeline **${pipeline.name}**.`,
    `### Task & Problem Description\n${pipeline.description}`,
    pipeline.peerUnderstand.investigationGoal
      ? `### Forked Lead Investigation Goal\n${pipeline.peerUnderstand.investigationGoal}`
      : "",
    [
      "### Discovery & Alignment Instructions (`peer_understand`)",
      `1. Stay **READ-ONLY** in worktree \`${pipeline.worktree}\`. Inspect the relevant project files, architecture, and tests to satisfy the investigation goal and understand the exact expectations of this task.`,
      `2. Exchange messages with the **Forked Lead** (\`${pipeline.peerUnderstand.forkedLeadAgentId ?? "pending"}\`) via \`slp_send_peer_message\` if any requirement, boundary condition, or expected input/logic/output contract needs clarification.`,
      "3. Once you and the Forked Lead confirm mutual understanding, the Forked Lead will create/launch the pipeline stages and your session will be **forked** to spawn every stage peer, so capture a thorough codebase map and root-problem analysis in context.",
      "4. Submit your structured understanding and concrete input/logic/output expectations via `slp_stage_report` when ready.",
    ].join("\n"),
    [
      "### Pipeline Context",
      `- **Pipeline**: ${pipeline.name} (\`${pipeline.id}\`)`,
      `- **Phase**: \`${PEER_UNDERSTAND_STAGE_ID}\``,
      `- **Worktree**: \`${pipeline.worktree}\``,
      `- **Forked Lead (Coordinator)**: \`${pipeline.peerUnderstand.forkedLeadAgentId ?? "pending"}\``,
    ].join("\n"),
    upcomingStageLines.length > 0
      ? `### Planned Pipeline Stages\n${upcomingStageLines.join("\n")}`
      : "### Pipeline Stages\nStages will be created by the Forked Lead as soon as both of you confirm mutual understanding.",
  ].filter(Boolean);
  if (run.criteria) {
    briefingSections.push(`### Overall Acceptance Criteria\n${run.criteria}`);
  }
  return briefingSections.join("\n\n");
}

// Formats the review prompt sent to Forked Lead when base_peer submits its peer_understand report.
export function coordinatorPeerUnderstandReviewBriefing(run: Run, pipeline: PipelineState): string {
  const formattedReports = pipeline.peerUnderstand.reports.map((submittedReport) => {
    const findingsBlock = submittedReport.findings.length > 0
      ? `\n  Findings:\n${submittedReport.findings.map((findingLine) => `  - ${findingLine}`).join("\n")}`
      : "";
    return `- **${submittedReport.role}** (\`${submittedReport.agentId}\`) [${submittedReport.status}]: ${submittedReport.summary}${findingsBlock}`;
  }).join("\n");
  const closureInstruction = pipeline.stages.length === 0
    ? `Verify that you and Base Peer fully understand each other on the root problem, affected modules, and expected input/logic/output contracts. Use \`slp_send_peer_message\` or \`slp_stage_rework\` if further clarification is needed. Once mutual understanding is confirmed, create the pipeline stages by calling \`slp_define_pipeline({ pipelineId: "${pipeline.id}", summary, stages: [{ name, goal, peers: [{ role, task }] }] })\` (or \`slp_approve_stage({ summary, stages })\`) to checkpoint Base Peer's session and start Stage 1.`
    : "Verify that the Base Peer thoroughly understands the root problem, affected modules, and expected input/logic/output contracts for the upcoming stages. Use `slp_send_peer_message` or `slp_stage_rework` if deeper investigation or clarification is needed, or call `slp_approve_stage({ summary, stages? })` (or `slp_define_pipeline`) to checkpoint Base Peer's session and start Stage 1.";
  // Remind the Forked Lead that confirming peer_understand checkpoints base_peer's session for all stage peer forks.
  return [
    `You are the **Forked Lead** reviewing the **\`${PEER_UNDERSTAND_STAGE_ID}\`** phase for pipeline **${pipeline.name}** (\`${pipeline.id}\`).`,
    `- **Task Description**: ${pipeline.description}`,
    pipeline.peerUnderstand.investigationGoal
      ? `- **Investigation Goal**: ${pipeline.peerUnderstand.investigationGoal}`
      : "",
    `- **Worktree**: \`${pipeline.worktree}\``,
    `- **Base Peer**: \`${pipeline.peerUnderstand.basePeerAgentId ?? "unknown"}\``,
    run.criteria ? `### Overall Acceptance Criteria\n${run.criteria}` : "",
    `### Submitted Base Peer Understanding Report\n${formattedReports || "(no report submitted yet)"}`,
    closureInstruction,
  ].filter(Boolean).join("\n\n");
}

export function stagePromptContext(pipeline: PipelineState, stage: StageState, task: string): StagePromptContext {
  // The goal and assignment are system context even before the final roster is activated through the mailbox.
  return { pipelineId: pipeline.id, pipelineName: pipeline.name, stageId: stage.id, stageName: stage.name,
    goal: stage.goal, task, worktree: pipeline.worktree,
    peerRoster: stage.peers.map(({ role, task }) => ({ role, task })),
    priorResults: pipeline.stages.slice(0, pipeline.currentStageIndex).map((previousStage) =>
      `${previousStage.name}: ${previousStage.result?.summary ?? ""}`),
    history: stage.messages.map((message) => `${message.fromAgentId} -> ${message.toAgentId}: ${message.message}`) };
}

export function stageBriefing(run: Run, pipeline: PipelineState, stage: StageState, currentPeerIndex?: number): string {
  // Format roster and prior stage outcomes as readable Markdown instead of raw JSON so prompts remain easy to scan in chat.
  const rosterLines = stage.peerAgentIds.map((agentId, peerIndex) => {
    const peerAssignment = stage.peers[peerIndex];
    if (peerIndex === currentPeerIndex) {
      return `- **${peerAssignment.role}** (\`${agentId}\` — you)`;
    }
    return `- **${peerAssignment.role}** (\`${agentId}\`): ${peerAssignment.task}`;
  });
  const completedStages = pipeline.stages.slice(0, pipeline.currentStageIndex);
  const previousStageLines = completedStages.map((previousStage) =>
    `- **${previousStage.name}** (${previousStage.goal}): ${previousStage.result?.summary ?? "Approved"}`,
  );
  // Expose live peers from earlier completed stages so downstream peers can directly question them via slp_send_peer_message.
  const priorStagePeerLines = completedStages.flatMap((previousStage) =>
    previousStage.peerAgentIds.flatMap((priorPeerAgentId, priorPeerIndex) => {
      if (!priorPeerAgentId || run.agents[priorPeerAgentId]?.archivedAt) return [];
      const priorAssignment = previousStage.peers[priorPeerIndex];
      const latestPeerReport = [...previousStage.reports]
        .reverse()
        .find((reportEntry) => reportEntry.agentId === priorPeerAgentId);
      const reportSummarySuffix = latestPeerReport ? ` — Latest report: ${latestPeerReport.summary}` : "";
      return [
        `- [Stage **${previousStage.name}**] **${priorAssignment?.role ?? "peer"}** (\`${priorPeerAgentId}\`): ${priorAssignment?.task ?? ""}${reportSummarySuffix}`,
      ];
    }),
  );
  const sections = [
    [
      "### Stage Context",
      `- **Pipeline**: ${pipeline.name} (\`${pipeline.id}\`) — ${pipeline.description}`,
      `- **Stage**: ${stage.name} (\`${stage.id}\`)`,
      `- **Worktree**: \`${pipeline.worktree}\``,
      `- **Stage Goal**: ${stage.goal}`,
      `- **Forked Lead (Coordinator)**: \`${stage.forkedLeadAgentId ?? "pending"}\``,
    ].join("\n"),
    `### Stage Peer Roster\n${rosterLines.join("\n")}`,
  ];
  if (run.criteria) {
    sections.push(`### Overall Acceptance Criteria\n${run.criteria}`);
  }
  // Include Base Peer's discovery report, Forked Lead's investigation goal, and peer_understand approval so stage peers and degraded forks retain the baseline analysis.
  if (
    pipeline.peerUnderstand.investigationGoal
    || pipeline.peerUnderstand.result
    || pipeline.peerUnderstand.reports.length > 0
  ) {
    const latestBasePeerReport = pipeline.peerUnderstand.reports.at(-1);
    const basePeerFindings = latestBasePeerReport?.findings.length
      ? `\n  Findings:\n${latestBasePeerReport.findings.map((findingLine) => `  - ${findingLine}`).join("\n")}`
      : "";
    const peerUnderstandLines = [
      pipeline.peerUnderstand.basePeerAgentId
        ? `- **Base Peer**: \`${pipeline.peerUnderstand.basePeerAgentId}\`${pipeline.peerUnderstand.basePeerSessionId ? ` (session \`${pipeline.peerUnderstand.basePeerSessionId}\`)` : ""}`
        : "",
      pipeline.peerUnderstand.investigationGoal
        ? `- **Forked Lead Investigation Goal**: ${pipeline.peerUnderstand.investigationGoal}`
        : "",
      latestBasePeerReport
        ? `- **Base Peer Investigation Summary**: ${latestBasePeerReport.summary}${basePeerFindings}`
        : "",
      pipeline.peerUnderstand.result
        ? `- **Forked Lead Alignment Summary**: ${pipeline.peerUnderstand.result.summary}`
        : "",
    ].filter(Boolean);
    if (peerUnderstandLines.length > 0) {
      sections.push(`### Base Peer Understanding (peer_understand)\n${peerUnderstandLines.join("\n")}`);
    }
  }
  if (previousStageLines.length > 0) {
    sections.push(`### Previous Stage Results\n${previousStageLines.join("\n")}`);
  }
  if (priorStagePeerLines.length > 0) {
    sections.push(
      `### Prior Stage Peers (Available for Cross-Stage Questions via slp_send_peer_message)\n${priorStagePeerLines.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export function peerStageBriefing(run: Run, pipeline: PipelineState, stage: StageState, peerIndex: number): string {
  const assignment = stage.peers[peerIndex];
  const hasPriorStagePeers = pipeline.currentStageIndex > 0;
  const crossStageHint = hasPriorStagePeers
    ? " Peers from earlier stages remain active in this pipeline—if you need clarification on upstream logic or assumptions, message them directly via `slp_send_peer_message` using their IDs from **Prior Stage Peers**."
    : "";
  // Tailor collaboration instructions so a single peer does not waste a turn looking for sibling peers to message.
  const coordinationGuidance = stage.peers.length === 1
    ? `You are the sole peer in this stage.${crossStageHint} Apply your configured \`.slp\` workflow in the worktree and submit evidence with \`slp_stage_report\` (or use \`slp_escalate\` if blocked). The Forked Lead decides when this stage is complete.`
    : `All stage peers are equal participants. Stay focused on the shared goal, collaborate with current-stage or prior-stage peers via \`slp_send_peer_message\` when needed, apply your configured \`.slp\` workflow, and submit evidence with \`slp_stage_report\`. The Forked Lead decides when this stage is complete.`;
  return [
    `You are project peer **${assignment.role}** in stage **${stage.name}**.`,
    `### Your Task\n${assignment.task}`,
    coordinationGuidance,
    stageBriefing(run, pipeline, stage, peerIndex),
  ].join("\n\n");
}

export function coordinatorStageBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  // The coordinator judges the goal according to its configured .slp/FORKED_LEAD.md workflow.
  return [
    "You are the **Forked Lead** controlling this stage from its start until closure. Apply your configured `.slp` workflow to direct peers through `slp_send_peer_message` or `slp_stage_rework`, inspect their evidence and the worktree, and decide when the result is acceptable with `slp_approve_stage({summary})` (or use `slp_escalate` if blocked beyond your authority).",
    stageBriefing(run, pipeline, stage),
  ].join("\n\n");
}

// When a Forked Lead session dies mid-stage after peers already reported, include their saved reports so the replacement can act immediately.
export function coordinatorRevivalBriefing(run: Run, pipeline: PipelineState, stage: StageState): string {
  const baseBriefing = coordinatorStageBriefing(run, pipeline, stage);
  if (stage.reports.length === 0) return baseBriefing;
  const formattedReports = stage.reports.map((peerReport) => {
    const findingsText = peerReport.findings.length > 0
      ? `\n  Findings:\n${peerReport.findings.map((finding) => `  - ${finding}`).join("\n")}`
      : "";
    return `- **${peerReport.role}** (\`${peerReport.agentId}\`) [${peerReport.status}]: ${peerReport.summary}${findingsText}`;
  }).join("\n");
  return `${baseBriefing}\n\n### Submitted Stage Peer Reports\n${formattedReports}\n\nReview the submitted reports against goal '${stage.goal}' according to your configured \`.slp\` workflow. Direct more work with \`slp_stage_rework\` or approve with \`slp_approve_stage\` when you accept the result.`;
}

// Inform a surviving Forked Lead when dead peer slots are replaced so direct messages and rework target the new identities.
export function peerRosterUpdateNotice(stage: StageState, revivedPeerIndices: ReadonlySet<number>): string {
  const revivedPeerSummaries = [...revivedPeerIndices].map((peerIndex) => {
    const peerAssignment = stage.peers[peerIndex];
    const replacementPeerAgentId = stage.peerAgentIds[peerIndex];
    return `${peerAssignment.role} (${replacementPeerAgentId})`;
  });
  return `Stage '${stage.name}' revived dead peer session(s): ${revivedPeerSummaries.join(", ")}. Continue coordinating this stage with the updated peer roster.`;
}

// Provide the final Forked Lead with peer and sibling-Forked-Lead contacts so it can merge autonomously and consult on conflicts.
export function pipelineFinalizationBriefing(run: Run, pipeline: PipelineState): string {
  const pipelinePeerLines = pipeline.stages.flatMap((completedStage) =>
    completedStage.peerAgentIds.flatMap((peerAgentId, peerIndex) => {
      if (!peerAgentId || run.agents[peerAgentId]?.archivedAt) return [];
      const peerAssignment = completedStage.peers[peerIndex];
      return [`- [Stage **${completedStage.name}**] **${peerAssignment?.role ?? "peer"}** (\`${peerAgentId}\`): ${peerAssignment?.task ?? ""}`];
    }),
  );
  // Expose active Forked Leads from sibling pipelines so cross-pipeline merge conflicts can be resolved collaboratively.
  const siblingForkedLeadLines = Object.values(run.pipelines)
    .filter((candidatePipeline) => candidatePipeline.id !== pipeline.id)
    .flatMap((siblingPipeline) => {
      const siblingCoordinatorId = [...siblingPipeline.stages]
        .reverse()
        .map((siblingStage) => siblingStage.forkedLeadAgentId)
        .find((coordinatorId): coordinatorId is string => Boolean(coordinatorId && !run.agents[coordinatorId]?.archivedAt));
      if (!siblingCoordinatorId) return [];
      return [
        `- Pipeline **${siblingPipeline.name}** (\`${siblingPipeline.id}\`, branch \`${siblingPipeline.branch ?? "n/a"}\`, status \`${siblingPipeline.status}\`): Forked Lead \`${siblingCoordinatorId}\``,
      ];
    });
  const briefingSections = [
    `Pipeline '${pipeline.name}' (${pipeline.id}) completed all stages. You are responsible for verifying and merging its branch into the integration branch.`,
    [
      "### Merge & Finalization Instructions",
      `1. Inspect \`${pipeline.worktree}\` (branch \`${pipeline.branch}\`) and commit any remaining valid stage work so the worktree is clean.`,
      `2. Call \`slp_finalize_pipeline({ pipelineId: "${pipeline.id}", summary })\` with a consolidated summary of all delivered changes and verified metrics to merge \`${pipeline.branch}\` into \`${run.integrationBranch}\` (\`${run.devCwd}\`).`,
      `3. If \`slp_finalize_pipeline\` reports a merge conflict: inspect the conflicting files. If you do not fully understand why a conflicting change was made, message the responsible **Peer** in this pipeline or the sibling **Forked Lead** of the related feature pipeline via \`slp_send_peer_message({ toAgentId, message, waitForReply: true })\`. Then merge \`${run.integrationBranch}\` into \`${pipeline.branch}\` inside \`${pipeline.worktree}\`, resolve the conflicts cleanly, commit, and call \`slp_finalize_pipeline\` again.`,
    ].join("\n"),
  ];
  if (pipelinePeerLines.length > 0) {
    briefingSections.push(`### Pipeline Peers (Available for Merge/Conflict Questions via slp_send_peer_message)\n${pipelinePeerLines.join("\n")}`);
  }
  if (siblingForkedLeadLines.length > 0) {
    briefingSections.push(`### Sibling Pipeline Forked Leads (Available for Cross-Feature Conflict Consultation via slp_send_peer_message)\n${siblingForkedLeadLines.join("\n")}`);
  }
  return briefingSections.join("\n\n");
}
