import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { PipelineGate, PipelinePeerDefinition, PipelineState, StageState } from "../../shared/pipeline";
import type { UiStyles } from "../styles";
import { describeRpcError, useRunActions } from "../use-run";
import { ActionButton } from "./action-button";

interface PipelineDetailProps {
  styles: UiStyles;
  theme: PluginTheme;
  runId: string;
  pipelines: PipelineState[];
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  integrated: "Integrated",
  failed: "Failed",
  pending: "Pending",
  completing: "Completing",
  closing: "Closing",
  closed: "Closed",
};

function statusColor(theme: PluginTheme, status: string): string {
  // Paused and failed need attention; completed states use the same positive colour as task cards.
  if (status === "failed" || status === "paused") return theme.colors.statusDanger;
  if (status === "completed" || status === "integrated" || status === "closed") return theme.colors.statusSuccess;
  if (status === "completing" || status === "closing") return theme.colors.statusWarning;
  return status === "pending" || status === "queued" ? theme.colors.foregroundMuted : theme.colors.accent;
}

function statusLabel(status: string): string {
  // Unknown values remain readable so a newer daemon does not make an older client blank.
  return STATUS_LABELS[status] ?? status;
}

function formatTime(timestamp?: string | null): string | null {
  if (!timestamp) return null;
  const parsedTimestamp = new Date(timestamp);
  // Keep a malformed persisted timestamp visible instead of replacing it with a misleading local time.
  return Number.isNaN(parsedTimestamp.getTime()) ? timestamp : parsedTimestamp.toLocaleString();
}

function renderOptionalLine(label: string, value: string | null | undefined, styles: UiStyles) {
  // Optional metadata is omitted when absent to keep the stage cards compact on mobile.
  return value ? (
    <Text style={styles.mutedText}>
      {label}: {value}
    </Text>
  ) : null;
}

function peerStatusForStage(stageStatus: StageState["status"]): string {
  // Peer labels describe the persisted cohort lifecycle, not a live SDK session probe.
  if (stageStatus === "completing") return "closing";
  if (stageStatus === "completed") return "closed";
  return stageStatus;
}

function PeerRow({ styles, theme, peer, agentId, peerStatus }: {
  styles: UiStyles;
  theme: PluginTheme;
  peer: PipelinePeerDefinition;
  agentId?: string;
  peerStatus: string;
}) {
  // Agent ids are supplementary diagnostics; role and task remain useful before the cohort starts.
  const peerColor = statusColor(theme, peerStatus);
  return (
    <View style={[styles.card, { padding: 8, borderLeftWidth: 3, borderLeftColor: peerColor }]}>
      <Text style={styles.bodyText}>
        {peer.role} {agentId ? `· ${agentId}` : ""}
      </Text>
      <Text style={{ color: peerColor, fontSize: 12, fontWeight: "600" }}>{statusLabel(peerStatus)}</Text>
      <Text style={styles.mutedText}>{peer.task}</Text>
    </View>
  );
}

function StageRow({ styles, theme, stage, stageIndex, currentStageIndex }: {
  styles: UiStyles;
  theme: PluginTheme;
  stage: StageState;
  stageIndex: number;
  currentStageIndex: number;
}) {
  // The current stage marker follows the persisted index because multiple stages can share a status during handoff.
  const stageColor = statusColor(theme, stage.status);
  const stagePeerIds = stage.peerAgentIds ?? [];
  const reportCount = stage.reports?.length ?? 0;
  const messageCount = stage.messages?.length ?? 0;
  return (
    <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: stageColor }]}>
      <View style={styles.row}>
        <Text style={styles.bodyText}>
          {stageIndex + 1}. {stage.name}
        </Text>
        <Text style={{ color: stageColor, fontSize: 13, fontWeight: "700" }}>{statusLabel(stage.status)}</Text>
      </View>
      <Text style={styles.mutedText}>{stage.goal}</Text>
      {stageIndex === currentStageIndex ? <Text style={styles.warningText}>Current stage</Text> : null}
      {renderOptionalLine("Lead", stage.forkedLeadAgentId, styles)}
      {renderOptionalLine("Started", formatTime(stage.startedAt), styles)}
      {renderOptionalLine("Completed", formatTime(stage.completedAt), styles)}
      <View style={styles.stack}>
        {/* A partially persisted stage may briefly have no peer ids; keep that state visible during recovery. */}
        {stage.peers.length === 0 ? <Text style={styles.mutedText}>No peers assigned.</Text> : null}
        {stage.peers.map((peer, peerIndex) => (
          <PeerRow
            key={`${peer.role}-${stagePeerIds[peerIndex] ?? peerIndex}`}
            styles={styles}
            theme={theme}
            peer={peer}
            agentId={stagePeerIds[peerIndex]}
            peerStatus={peerStatusForStage(stage.status)}
          />
        ))}
      </View>
      {/* Counts expose direct discussion and evidence without dumping long SQLite histories into every card. */}
      {reportCount || messageCount ? (
        <Text style={styles.mutedText}>
          {reportCount} report{reportCount === 1 ? "" : "s"} · {messageCount} message{messageCount === 1 ? "" : "s"}
        </Text>
      ) : null}
      {reportCount > 0 ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Reports</Text>
          {stage.reports.map((report) => (
            <View key={`${report.agentId}-${report.submittedAt}`}>
              <Text style={styles.bodyText}>{report.role} · {report.status}</Text>
              <Text style={styles.mutedText}>{report.summary}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {messageCount > 0 ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Direct messages</Text>
          {stage.messages.map((message) => (
            <Text key={message.id} style={styles.mutedText}>
              {message.fromAgentId} → {message.toAgentId}: {message.message}
            </Text>
          ))}
        </View>
      ) : null}
      {stage.result?.summary ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Stage result</Text>
          <Text style={styles.bodyText}>{stage.result.summary}</Text>
          {renderOptionalLine("Approved by", stage.result.approvedBy, styles)}
          {renderOptionalLine("Approved", formatTime(stage.result.approvedAt), styles)}
        </View>
      ) : null}
    </View>
  );
}

export function PipelineDetail({ styles, theme, runId, pipelines }: PipelineDetailProps) {
  // Pipelines are rendered in daemon order supplied by the keyed Run record; no fixed role or phase is inferred here.
  const { approvePipelineGate } = useRunActions();
  const gateErrorMessage = describeRpcError(approvePipelineGate.error);
  return (
    <View style={styles.stack}>
      <Text style={styles.sectionTitle}>Pipelines ({pipelines.length})</Text>
      {pipelines.map((pipeline) => {
        const pipelineColor = statusColor(theme, pipeline.status);
        // The gate is optional for older snapshots and is only actionable when the dynamic contract persisted one.
        const pipelineGate: PipelineGate | null = pipeline.gate;
        return (
          <View key={pipeline.id} style={[styles.card, { borderLeftWidth: 4, borderLeftColor: pipelineColor }]}>
            <View style={styles.row}>
              <Text style={styles.bodyText}>{pipeline.name}</Text>
              <Text style={{ color: pipelineColor, fontSize: 13, fontWeight: "700" }}>{statusLabel(pipeline.status)}</Text>
            </View>
            <Text style={styles.mutedText}>v{pipeline.version} · {pipeline.id}</Text>
            {pipeline.description ? <Text style={styles.bodyText}>{pipeline.description}</Text> : null}
            {renderOptionalLine("Worktree", pipeline.worktree, styles)}
            {renderOptionalLine("Branch", pipeline.branch, styles)}
            {renderOptionalLine("Workspace", pipeline.workspaceId, styles)}
            {renderOptionalLine("Lead", pipeline.leadAgentId, styles)}
            {pipeline.pausedReason ? <Text style={styles.dangerText}>{pipeline.pausedReason}</Text> : null}
            {pipeline.status === "paused" ? (
              <Text style={styles.mutedText}>Resume through the Lead tool.</Text>
            ) : null}
            {pipelineGate ? (
              <View style={[styles.stack, { padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 }]}>
                <Text style={styles.warningText}>{pipelineGate.note}</Text>
                <ActionButton
                  styles={styles}
                  tone="primary"
                  label={pipelineGate.kind === "before_integration" ? "Approve integration" : "Approve stage"}
                  accessibilityLabel={`Approve pipeline gate for ${pipeline.name}`}
                  disabled={approvePipelineGate.isPending}
                  onPress={() => approvePipelineGate.mutate({ runId, pipelineId: pipeline.id })}
                />
              </View>
            ) : null}
            {/* The stage cards preserve the Lead's names and order so the monitor mirrors the submitted JSON. */}
            <View style={styles.stack}>
              {pipeline.stages.map((stage, stageIndex) => (
                <StageRow
                  key={stage.id ?? `${pipeline.id}-${stage.name}-${stageIndex}`}
                  styles={styles}
                  theme={theme}
                  stage={stage}
                  stageIndex={stageIndex}
                  currentStageIndex={pipeline.currentStageIndex}
                />
              ))}
            </View>
            {pipeline.finalReport ? (
              <View style={styles.stack}>
                <Text style={styles.fieldLabel}>Final report</Text>
                <Text style={styles.bodyText}>{pipeline.finalReport}</Text>
              </View>
            ) : null}
            {gateErrorMessage ? <Text style={styles.dangerText}>{gateErrorMessage}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}
