// Focused inspector panels for a single selected Kanban card (Spec card, Brief card, or single Option card).
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { BoardTicket } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions } from "../../use-board";
import { describeRpcError } from "../../use-run";
import { ActionButton } from "../action-button";
import { DiffViewer } from "./diff-viewer";
import {
  type KanbanCardSelection,
  partitionTicketBriefItems,
  resolveSpecColorIdentity,
} from "./kanban-palette";
import { InspectorTagBadge, OptionCardInspector } from "./option-card-inspector";

interface TicketDetailPanelProps {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  selection: KanbanCardSelection;
  selectedRunId: string | null;
  onClose: () => void;
}

// Inspector rendered ONLY when the user selects a Spec card in Column 1 (SPEC).
function SpecCardInspector({
  styles,
  theme,
  ticket,
  selectedRunId,
  onClose,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  selectedRunId: string | null;
  onClose: () => void;
}) {
  const { saveBoardSpec } = useBoardActions();
  const specColor = resolveSpecColorIdentity(ticket);
  const latestSpecRevision = ticket.specRevisions[ticket.specRevisions.length - 1] ?? null;
  const currentSpecContent = latestSpecRevision?.content ?? "";

  const [editedTitle, setEditedTitle] = useState(ticket.title);
  const [editedAcceptanceCriteria, setEditedAcceptanceCriteria] = useState(ticket.acceptanceCriteria);
  const [editedSpecContent, setEditedSpecContent] = useState(currentSpecContent);
  const [specChangeSummary, setSpecChangeSummary] = useState("");
  const [showSpecDiffHistory, setShowSpecDiffHistory] = useState(false);

  // Reset local Spec editor draft whenever the user switches to another Spec card or a new Spec revision arrives.
  useEffect(() => {
    setEditedTitle(ticket.title);
    setEditedAcceptanceCriteria(ticket.acceptanceCriteria);
    setEditedSpecContent(ticket.specRevisions[ticket.specRevisions.length - 1]?.content ?? "");
    setSpecChangeSummary("");
  }, [ticket.id, ticket.currentSpecRev]);

  const saveErrorMessage = describeRpcError(saveBoardSpec.error);
  const hasUnsavedSpecEdits =
    editedTitle.trim() !== ticket.title.trim() ||
    editedAcceptanceCriteria.trim() !== ticket.acceptanceCriteria.trim() ||
    editedSpecContent.trim() !== currentSpecContent.trim();

  const handleApplySpec = () => {
    // Saving a Spec edit creates a new Spec revision with unified diff and notifies the Supervisor.
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
    <View
      style={[
        styles.card,
        {
          borderWidth: 2,
          borderLeftWidth: 6,
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          gap: 10,
        },
      ]}
    >
      {/* Header displays ONLY the Spec card identity and diff toggle without mixing Brief items. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <View style={styles.row}>
          <InspectorTagBadge
            label={`SPEC · ${ticket.ticketKey} (v${ticket.currentSpecRev})`}
            borderColor={specColor.borderColor}
            backgroundColor={specColor.badgeBackground}
            textColor={specColor.badgeTextColor}
          />
          <Text style={styles.sectionTitle}>Product Spec (Human & Supervisor)</Text>
        </View>
        <View style={styles.row}>
          {ticket.specRevisions.length > 0 ? (
            <ActionButton
              styles={styles}
              label={showSpecDiffHistory ? "Hide Spec Diffs" : `Spec Diffs (${ticket.specRevisions.length})`}
              accessibilityLabel="Toggle Spec revision diff history"
              onPress={() => setShowSpecDiffHistory((previousState) => !previousState)}
            />
          ) : null}
          <ActionButton
            styles={styles}
            label="Close"
            accessibilityLabel={`Close Spec inspector for ${ticket.ticketKey}`}
            onPress={onClose}
          />
        </View>
      </View>

      <Text style={styles.fieldLabel}>Spec Title</Text>
      <TextInput
        style={styles.input}
        value={editedTitle}
        onChangeText={setEditedTitle}
        placeholder="Spec title"
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

      <Text style={styles.fieldLabel}>Spec Content (Handed by Supervisor to Lead)</Text>
      <TextInput
        style={[styles.input, { minHeight: 140, textAlignVertical: "top" }]}
        value={editedSpecContent}
        onChangeText={setEditedSpecContent}
        multiline
        placeholder="Full 5-section Product Spec..."
        placeholderTextColor={theme.colors.foregroundMuted}
      />

      <Text style={styles.fieldLabel}>Revision Note (optional)</Text>
      <TextInput
        style={styles.input}
        value={specChangeSummary}
        onChangeText={setSpecChangeSummary}
        placeholder="Why did you edit this Spec?"
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

      {showSpecDiffHistory ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Spec Revision History (Git-style Unified Diff)</Text>
          {[...ticket.specRevisions].reverse().map((specRevision) => (
            <View key={`spec-rev-${specRevision.rev}`} style={styles.stack}>
              <Text style={styles.bodyText}>
                v{specRevision.rev} · {specRevision.author} · {specRevision.summary}
              </Text>
              <DiffViewer styles={styles} theme={theme} diffFromPrevious={specRevision.diff} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Inspector rendered ONLY when the user selects a Brief card in Column 2 (BRIEF).
function BriefCardInspector({
  styles,
  theme,
  ticket,
  onClose,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  onClose: () => void;
}) {
  const specColor = resolveSpecColorIdentity(ticket);
  const { gradableOptions, inScopeNotes, outOfScopeNotes } = partitionTicketBriefItems(ticket);
  const latestBriefRevision = ticket.briefRevisions[ticket.briefRevisions.length - 1] ?? null;
  const [showBriefDiffHistory, setShowBriefDiffHistory] = useState(false);

  return (
    <View
      style={[
        styles.card,
        {
          borderWidth: 2,
          borderLeftWidth: 6,
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          gap: 10,
        },
      ]}
    >
      {/* Header shows both the parent Spec tag and this Brief's tag with matching border color. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <View style={styles.row}>
          <InspectorTagBadge
            label={`SPEC · ${ticket.ticketKey}`}
            borderColor={specColor.borderColor}
            backgroundColor={specColor.badgeBackground}
            textColor={specColor.badgeTextColor}
          />
          <InspectorTagBadge
            label={`BRIEF · ${specColor.briefTagCode} (v${ticket.currentBriefRev})`}
            borderColor={specColor.borderColor}
            backgroundColor={theme.colors.surface2}
            textColor={theme.colors.foreground}
          />
          <Text style={styles.sectionTitle}>Lead Technical Brief Overview</Text>
        </View>
        <View style={styles.row}>
          {ticket.briefRevisions.length > 0 ? (
            <ActionButton
              styles={styles}
              label={showBriefDiffHistory ? "Hide Brief Diffs" : `Brief Diffs (${ticket.briefRevisions.length})`}
              accessibilityLabel="Toggle Brief revision diff history"
              onPress={() => setShowBriefDiffHistory((previousState) => !previousState)}
            />
          ) : null}
          <ActionButton
            styles={styles}
            label="Close"
            accessibilityLabel={`Close Brief inspector for ${specColor.briefTagCode}`}
            onPress={onClose}
          />
        </View>
      </View>

      {ticket.lastSyncedSpecRev < ticket.currentSpecRev ? (
        <Text style={styles.warningText}>
          Outdated Brief: Spec is at v{ticket.currentSpecRev}, while Brief is synced to Spec v{ticket.lastSyncedSpecRev}.
        </Text>
      ) : null}

      <View style={{ gap: 4 }}>
        <Text style={styles.fieldLabel}>Technical Approach (Decomposed by Lead from {ticket.ticketKey})</Text>
        <Text style={styles.bodyText}>{ticket.approach || "No technical approach recorded yet."}</Text>
      </View>

      {latestBriefRevision ? (
        <Text style={styles.mutedText}>
          Latest revision v{latestBriefRevision.rev} by {latestBriefRevision.authorAgentId}: {latestBriefRevision.reason}
        </Text>
      ) : null}

      <Text style={styles.mutedText}>
        Decomposed into {gradableOptions.length} Option card{gradableOptions.length === 1 ? "" : "s"} ({gradableOptions.map((optionItem) => optionItem.id).join(", ")}) on the board.
      </Text>

      {/* Show additional in-scope and out-of-scope boundaries belonging to the Brief overview. */}
      {inScopeNotes.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>In-Scope Boundaries ({inScopeNotes.length})</Text>
          {inScopeNotes.map((scopeBullet) => (
            <Text key={scopeBullet.id} style={styles.bodyText}>
              • {scopeBullet.requirement}
            </Text>
          ))}
        </View>
      ) : null}

      {outOfScopeNotes.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Out-of-Scope Boundaries ({outOfScopeNotes.length})</Text>
          {outOfScopeNotes.map((outBullet) => (
            <Text key={outBullet.id} style={styles.mutedText}>
              • {outBullet.requirement}
            </Text>
          ))}
        </View>
      ) : null}

      {/* Realtime active agents working on this Brief. */}
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
                    : { borderColor: specColor.borderColor },
                ]}
              >
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

      {showBriefDiffHistory ? (
        <View style={styles.stack}>
          <Text style={styles.fieldLabel}>Brief Revision History (Git-style Unified Diff)</Text>
          {[...ticket.briefRevisions].reverse().map((briefRevision) => (
            <View key={`brief-rev-${briefRevision.rev}`} style={styles.stack}>
              <Text style={styles.bodyText}>
                Brief v{briefRevision.rev} (Spec v{briefRevision.specRev}) · {briefRevision.authorAgentId} · {briefRevision.reason}
              </Text>
              <DiffViewer styles={styles} theme={theme} diffFromPrevious={briefRevision.diff} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Dispatches to the focused inspector matching whichever card (Spec, Brief, or Option) the user clicked.
export function TicketDetailPanel({
  styles,
  theme,
  ticket,
  selection,
  selectedRunId,
  onClose,
}: TicketDetailPanelProps) {
  if (selection.kind === "spec") {
    return (
      <SpecCardInspector
        styles={styles}
        theme={theme}
        ticket={ticket}
        selectedRunId={selectedRunId}
        onClose={onClose}
      />
    );
  }

  if (selection.kind === "brief") {
    return (
      <BriefCardInspector
        styles={styles}
        theme={theme}
        ticket={ticket}
        onClose={onClose}
      />
    );
  }

  const selectedOptionBullet = ticket.items.find((bulletItem) => bulletItem.id === selection.optionId);
  if (!selectedOptionBullet) return null;

  return (
    <OptionCardInspector
      styles={styles}
      theme={theme}
      ticket={ticket}
      optionBullet={selectedOptionBullet}
      onClose={onClose}
    />
  );
}
