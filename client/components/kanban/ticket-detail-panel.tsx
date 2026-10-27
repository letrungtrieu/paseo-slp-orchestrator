// Detailed inspector and Spec editor for a selected Kanban ticket, including Spec/Brief revision diff viewers.
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { BoardTicket, BriefItem } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions } from "../../use-board";
import { describeRpcError } from "../../use-run";
import { ActionButton } from "../action-button";
import { DiffViewer } from "./diff-viewer";

interface TicketDetailPanelProps {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  selectedRunId: string | null;
  onClose: () => void;
}

// Maps each Brief bullet status to a theme status color so QA failures and verified bullets stand out at a glance.
function resolveBriefItemColor(theme: PluginTheme, itemStatus: BriefItem["status"]): string {
  // Passing items use green, failing/rework items use red, and blocked items use amber warning color.
  if (itemStatus === "pass") return theme.colors.statusSuccess;
  if (itemStatus === "fail" || itemStatus === "rework") return theme.colors.statusDanger;
  if (itemStatus === "blocked") return theme.colors.statusWarning;
  if (itemStatus === "implemented" || itemStatus === "in_progress") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

// Renders a single Brief bullet item with its diff badge, scope, verification method, and QA scorecard evidence.
function BriefItemRow({
  styles,
  theme,
  briefItem,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  briefItem: BriefItem;
}) {
  const itemStatusColor = resolveBriefItemColor(theme, briefItem.status);

  // Highlight added or modified bullets from the latest Brief revision so operators see what the Lead changed.
  const diffBadgeColor =
    briefItem.diffBadge === "added"
      ? theme.colors.statusSuccess
      : briefItem.diffBadge === "modified"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;

  return (
    <View
      style={[
        styles.card,
        {
          padding: 8,
          borderLeftWidth: 3,
          borderLeftColor: itemStatusColor,
          backgroundColor: theme.colors.surface2,
        },
      ]}
    >
      {/* Header row displays bullet ID, current status, revision diff badge, and scope/version provenance. */}
      <View style={styles.row}>
        <Text style={[styles.monoText, { fontWeight: "700", color: theme.colors.foreground }]}>
          {briefItem.id}
        </Text>
        <Text style={{ color: itemStatusColor, fontSize: 12, fontWeight: "700" }}>
          {briefItem.status.toUpperCase()}
        </Text>
        {/* Only show the diff badge when the bullet was added or modified in the latest Brief revision. */}
        {briefItem.diffBadge !== "unchanged" ? (
          <Text style={{ color: diffBadgeColor, fontSize: 11, fontWeight: "700" }}>
            [{briefItem.diffBadge.toUpperCase()}]
          </Text>
        ) : null}
        <Text style={styles.mutedText}>
          Scope: {briefItem.scope === "in" ? "IN-SCOPE" : "OUT-OF-SCOPE"} · Spec v{briefItem.specRev} · Brief v{briefItem.briefRev}
        </Text>
      </View>
      <Text style={styles.bodyText}>{briefItem.requirement}</Text>
      {/* Display the verification method and developer notes when recorded on the bullet. */}
      {briefItem.verification ? (
        <Text style={styles.mutedText}>Verify: {briefItem.verification}</Text>
      ) : null}
      {briefItem.implementationNote ? (
        <Text style={styles.mutedText}>Implementation: {briefItem.implementationNote}</Text>
      ) : null}
      {/* Render QA scorecard verdict and evidence directly on the bullet so grading is visible in context. */}
      {briefItem.score ? (
        <View style={{ gap: 2 }}>
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              color:
                briefItem.score.status === "pass"
                  ? theme.colors.statusSuccess
                  : briefItem.score.status === "fail"
                    ? theme.colors.statusDanger
                    : theme.colors.statusWarning,
            }}
          >
            Score: {briefItem.score.status.toUpperCase()}
            {briefItem.score.gradedBy ? ` (${briefItem.score.gradedBy})` : ""} — {briefItem.score.reason}
          </Text>
          {briefItem.score.evidence ? (
            <Text style={styles.monoText}>Evidence: {briefItem.score.evidence}</Text>
          ) : null}
        </View>
      ) : null}
      {/* Rework notes explain why the bullet was sent back to the developer. */}
      {briefItem.reworkNote ? (
        <Text style={styles.dangerText}>Rework: {briefItem.reworkNote}</Text>
      ) : null}
    </View>
  );
}

// Displays the full Spec editor, Brief checklist, active agents, and revision diffs for the selected Kanban ticket.
export function TicketDetailPanel({
  styles,
  theme,
  ticket,
  selectedRunId,
  onClose,
}: TicketDetailPanelProps) {
  const { saveBoardSpec } = useBoardActions();
  // Read the latest Spec and Brief revisions to seed the editor and display revision metadata.
  const latestSpecRevision = ticket.specRevisions[ticket.specRevisions.length - 1] ?? null;
  const latestBriefRevision = ticket.briefRevisions[ticket.briefRevisions.length - 1] ?? null;
  const currentSpecContent = latestSpecRevision?.content ?? "";

  const [editedTitle, setEditedTitle] = useState(ticket.title);
  const [editedAcceptanceCriteria, setEditedAcceptanceCriteria] = useState(ticket.acceptanceCriteria);
  const [editedSpecContent, setEditedSpecContent] = useState(currentSpecContent);
  const [specChangeSummary, setSpecChangeSummary] = useState("");
  const [showSpecDiffHistory, setShowSpecDiffHistory] = useState(false);
  const [showBriefDiffHistory, setShowBriefDiffHistory] = useState(false);

  // Sync local editor draft whenever the user switches to a different ticket or a new Spec version lands.
  useEffect(() => {
    setEditedTitle(ticket.title);
    setEditedAcceptanceCriteria(ticket.acceptanceCriteria);
    setEditedSpecContent(ticket.specRevisions[ticket.specRevisions.length - 1]?.content ?? "");
    setSpecChangeSummary("");
  }, [ticket.id, ticket.currentSpecRev]);

  const saveErrorMessage = describeRpcError(saveBoardSpec.error);

  // Detect whether the human has unsaved Spec edits relative to the persisted ticket snapshot.
  const hasUnsavedSpecEdits =
    editedTitle.trim() !== ticket.title.trim() ||
    editedAcceptanceCriteria.trim() !== ticket.acceptanceCriteria.trim() ||
    editedSpecContent.trim() !== currentSpecContent.trim();

  const handleApplySpec = () => {
    // Applying a Spec edit persists a new SpecRevision and immediately notifies the Supervisor agent.
    saveBoardSpec.mutate({
      repoPath: ticket.repoPath,
      runId: selectedRunId ?? ticket.activeRunId ?? undefined,
      ticketId: ticket.ticketKey,
      title: editedTitle.trim() || ticket.title,
      acceptanceCriteria: editedAcceptanceCriteria.trim() || undefined,
      specContent: editedSpecContent.trim() || ticket.title,
      summary: specChangeSummary.trim() || undefined,
    });
  };

  return (
    <View style={[styles.card, { borderColor: theme.colors.accent, gap: 12 }]}>
      {/* Panel header shows the Jira-style ticket key, current Kanban column, and a Close button. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text style={styles.sectionTitle}>
          {ticket.ticketKey} · {ticket.column.toUpperCase()}
        </Text>
        <ActionButton
          styles={styles}
          label="Close Detail"
          accessibilityLabel={`Close detail for ${ticket.ticketKey}`}
          onPress={onClose}
        />
      </View>

      {/* Realtime active agents badge list showing who is working on this ticket and whether Lead paused them. */}
      {ticket.activeAgents.length > 0 ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Realtime Agent Activity ({ticket.activeAgents.length})</Text>
          <View style={styles.row}>
            {ticket.activeAgents.map((activeAgent) => (
              <View
                key={activeAgent.agentId}
                style={[
                  styles.chip,
                  activeAgent.pausedAt
                    ? { borderColor: theme.colors.statusWarning }
                    : { borderColor: theme.colors.accent },
                ]}
              >
                {/* Show PAUSED BY LEAD in amber when the Lead has frozen a child peer's turn. */}
                <Text
                  style={[
                    styles.chipText,
                    activeAgent.pausedAt ? { color: theme.colors.statusWarning } : null,
                  ]}
                >
                  {activeAgent.agentId} ({activeAgent.projectRole ?? activeAgent.role})
                  {activeAgent.stageName ? ` · ${activeAgent.stageName}` : ""}
                  {activeAgent.pausedAt
                    ? ` · PAUSED BY LEAD${activeAgent.pausedReason ? `: ${activeAgent.pausedReason}` : ""}`
                    : activeAgent.awaitingTool
                      ? ` · awaiting ${activeAgent.awaitingTool}`
                      : " · active"}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* Spec Section: shared between Human and Supervisor. Human edits here notify Supervisor on Apply. */}
      <View style={styles.stack}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <Text style={styles.sectionTitle}>
            Spec (v{ticket.currentSpecRev}) — Human & Supervisor
          </Text>
          {ticket.specRevisions.length > 0 ? (
            <ActionButton
              styles={styles}
              label={showSpecDiffHistory ? "Hide Spec Diffs" : `Spec Diffs (${ticket.specRevisions.length})`}
              accessibilityLabel="Toggle Spec revision diff history"
              onPress={() => setShowSpecDiffHistory((previousState) => !previousState)}
            />
          ) : null}
        </View>
        {/* Editable title and acceptance criteria stay synchronized with the Spec document. */}
        <Text style={styles.fieldLabel}>Ticket Title</Text>
        <TextInput
          style={styles.input}
          value={editedTitle}
          onChangeText={setEditedTitle}
          placeholder="Ticket title"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
        <Text style={styles.fieldLabel}>Acceptance Criteria</Text>
        <TextInput
          style={styles.input}
          value={editedAcceptanceCriteria}
          onChangeText={setEditedAcceptanceCriteria}
          placeholder="High-level acceptance criteria"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
        {/* Multiline Spec Markdown editor where the human operator refines requirements at any point. */}
        <Text style={styles.fieldLabel}>Spec Document (Shared between You & Supervisor)</Text>
        <TextInput
          style={[styles.input, { minHeight: 110, textAlignVertical: "top" }]}
          value={editedSpecContent}
          onChangeText={setEditedSpecContent}
          multiline
          placeholder="Describe your product/technical requirements..."
          placeholderTextColor={theme.colors.foregroundMuted}
        />
        {/* Optional summary helps the Supervisor and Lead understand why the Spec was modified. */}
        <Text style={styles.fieldLabel}>Revision Summary (optional)</Text>
        <TextInput
          style={styles.input}
          value={specChangeSummary}
          onChangeText={setSpecChangeSummary}
          placeholder="Why did you update the Spec? (e.g. switch auth from session to JWT)"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
        <View style={styles.row}>
          <ActionButton
            styles={styles}
            tone="primary"
            label={saveBoardSpec.isPending ? "Applying..." : "Apply Spec & Notify Supervisor"}
            accessibilityLabel={`Apply Spec changes for ${ticket.ticketKey} and notify Supervisor`}
            disabled={saveBoardSpec.isPending || !hasUnsavedSpecEdits}
            onPress={handleApplySpec}
          />
          {latestSpecRevision ? (
            <Text style={styles.mutedText}>
              Last updated by {latestSpecRevision.author} ({latestSpecRevision.summary})
            </Text>
          ) : null}
        </View>
        {saveErrorMessage ? <Text style={styles.dangerText}>{saveErrorMessage}</Text> : null}

        {/* Expandable Git-style unified diff history for all Spec revisions, newest first. */}
        {showSpecDiffHistory ? (
          <View style={styles.stack}>
            <Text style={styles.fieldLabel}>Spec Revision History (Git-style Unified Diff)</Text>
            {[...ticket.specRevisions].reverse().map((specRevision) => (
              <View key={`spec-rev-${specRevision.rev}`} style={styles.stack}>
                <Text style={styles.bodyText}>
                  v{specRevision.rev} · {specRevision.author} · {specRevision.summary}
                </Text>
                <DiffViewer
                  styles={styles}
                  theme={theme}
                  diffFromPrevious={specRevision.diff}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* Brief Section: managed by Lead (`master_lead` / `qa_lead`), mutable with revision diffs when conflicts arise. */}
      <View style={styles.stack}>
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <Text style={styles.sectionTitle}>
            Brief (v{ticket.currentBriefRev} · synced to Spec v{ticket.lastSyncedSpecRev}) — Lead & Peers
          </Text>
          {ticket.briefRevisions.length > 0 ? (
            <ActionButton
              styles={styles}
              label={showBriefDiffHistory ? "Hide Brief Diffs" : `Brief Diffs (${ticket.briefRevisions.length})`}
              accessibilityLabel="Toggle Brief revision diff history"
              onPress={() => setShowBriefDiffHistory((previousState) => !previousState)}
            />
          ) : null}
        </View>
        {/* Warn when the Spec has advanced ahead of the Brief so the operator knows a Lead Brief sync is pending. */}
        {ticket.currentBriefRev > 0 && ticket.lastSyncedSpecRev < ticket.currentSpecRev ? (
          <Text style={styles.warningText}>
            Outdated Brief: Spec is at v{ticket.currentSpecRev}, while Brief is still synced to Spec v{ticket.lastSyncedSpecRev}.
          </Text>
        ) : null}
        {ticket.approach ? (
          <View style={{ gap: 2 }}>
            <Text style={styles.fieldLabel}>Technical Approach</Text>
            <Text style={styles.bodyText}>{ticket.approach}</Text>
          </View>
        ) : (
          <Text style={styles.mutedText}>Lead has not recorded a technical Brief yet.</Text>
        )}
        {latestBriefRevision ? (
          <Text style={styles.mutedText}>
            Latest Brief revision v{latestBriefRevision.rev} by {latestBriefRevision.authorAgentId}: {latestBriefRevision.reason}
          </Text>
        ) : null}
        {/* Render every Brief bullet item in order with its live status, diff badge, and QA score. */}
        <View style={styles.stack}>
          {ticket.items.map((briefItem) => (
            <BriefItemRow key={briefItem.id} styles={styles} theme={theme} briefItem={briefItem} />
          ))}
        </View>

        {/* Expandable Git-style unified diff history for all Brief revisions authored by the Lead. */}
        {showBriefDiffHistory ? (
          <View style={styles.stack}>
            <Text style={styles.fieldLabel}>Brief Revision History (Lead Technical Pivots & Spec Syncs)</Text>
            {[...ticket.briefRevisions].reverse().map((briefRevision) => (
              <View key={`brief-rev-${briefRevision.rev}`} style={styles.stack}>
                <Text style={styles.bodyText}>
                  Brief v{briefRevision.rev} (Spec v{briefRevision.specRev}) · {briefRevision.authorAgentId} · {briefRevision.reason}
                </Text>
                <DiffViewer
                  styles={styles}
                  theme={theme}
                  diffFromPrevious={briefRevision.diff}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}
