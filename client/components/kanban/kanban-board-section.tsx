// Project-scoped Kanban board view (Spec -> Brief -> Score -> Rework -> Done) with realtime agent badges.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { BOARD_COLUMNS, type BoardColumn, type BoardTicket } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions, useBoardTickets } from "../../use-board";
import { describeRpcError, useRunList } from "../../use-run";
import { ActionButton } from "../action-button";
import { TicketDetailPanel } from "./ticket-detail-panel";

interface KanbanBoardSectionProps {
  styles: UiStyles;
  theme: PluginTheme;
  projectRepoPath?: string | null;
  projectDisplayName?: string | null;
  selectedRunId?: string | null;
  onOpenSupervisor?: (supervisorAgentId: string) => void;
}

// Human-readable column headers showing the 5-step Spec -> Brief -> Score -> Rework -> Done workflow.
const COLUMN_TITLES: Record<BoardColumn, string> = {
  spec: "1. SPEC",
  brief: "2. BRIEF",
  score: "3. SCORE",
  rework: "4. REWORK",
  done: "5. DONE",
};

// Assigns a distinct accent color to each Kanban column header and card border.
function resolveColumnAccentColor(theme: PluginTheme, column: BoardColumn): string {
  // Done is green, Rework is red, Score is amber, Brief is accent blue, and Spec is neutral muted.
  if (column === "done") return theme.colors.statusSuccess;
  if (column === "rework") return theme.colors.statusDanger;
  if (column === "score") return theme.colors.statusWarning;
  if (column === "brief") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

// Renders a compact Kanban card summarizing Spec/Brief versions, bullet progress, and live agent badges.
function KanbanTicketCard({
  styles,
  theme,
  ticket,
  isSelected,
  onSelect,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const columnColor = resolveColumnAccentColor(theme, ticket.column);
  // Count passing and failing in-scope bullets so the operator can gauge progress without opening the detail panel.
  const inScopeBullets = ticket.items.filter((bullet) => bullet.scope === "in");
  const passedBulletCount = inScopeBullets.filter((bullet) => bullet.status === "pass").length;
  const failingBulletCount = inScopeBullets.filter(
    (bullet) => bullet.status === "fail" || bullet.status === "rework",
  ).length;
  const pausedAgentCount = ticket.activeAgents.filter((agent) => Boolean(agent.pausedAt)).length;
  // Flag when the Spec was updated after the Brief so the human knows the Lead owes a Brief diff update.
  const isBriefOutdated =
    ticket.currentBriefRev > 0 && ticket.lastSyncedSpecRev < ticket.currentSpecRev;

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Inspect ticket ${ticket.ticketKey} ${ticket.title}`}
      style={[
        styles.card,
        {
          padding: 10,
          borderLeftWidth: 4,
          borderLeftColor: columnColor,
          borderColor: isSelected ? theme.colors.accent : theme.colors.border,
          backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
        },
      ]}
    >
      {/* Top row shows the Jira-style key (e.g. SLP-1) and current Spec/Brief revision numbers. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text style={[styles.monoText, { fontWeight: "700", color: theme.colors.foreground }]}>
          {ticket.ticketKey}
        </Text>
        <Text style={styles.mutedText}>
          Spec v{ticket.currentSpecRev} · Brief v{ticket.currentBriefRev}
        </Text>
      </View>
      <Text style={[styles.bodyText, { fontWeight: "600" }]} numberOfLines={2}>
        {ticket.title}
      </Text>
      {/* Warn directly on the card when the Spec revision is newer than the Brief's synced Spec revision. */}
      {isBriefOutdated ? (
        <Text style={styles.warningText}>
          Spec v{ticket.currentSpecRev} pending Brief sync (v{ticket.lastSyncedSpecRev})
        </Text>
      ) : null}
      {/* Summarize how many Brief bullets have passed QA and how many are in rework. */}
      {inScopeBullets.length > 0 ? (
        <Text style={styles.mutedText}>
          Bullets: {passedBulletCount}/{inScopeBullets.length} pass
          {failingBulletCount > 0 ? ` · ${failingBulletCount} rework` : ""}
        </Text>
      ) : (
        <Text style={styles.mutedText}>No brief bullets yet</Text>
      )}
      {/* Render live agent chips so the operator can watch which agents are active or paused in realtime. */}
      {ticket.activeAgents.length > 0 ? (
        <View style={styles.row}>
          {ticket.activeAgents.map((activeAgent) => (
            <View
              key={activeAgent.agentId}
              style={[
                styles.chip,
                { paddingVertical: 2, paddingHorizontal: 6 },
                activeAgent.pausedAt
                  ? { borderColor: theme.colors.statusWarning }
                  : { borderColor: theme.colors.accent },
              ]}
            >
              <Text
                style={{
                  fontSize: 11,
                  color: activeAgent.pausedAt
                    ? theme.colors.statusWarning
                    : theme.colors.foreground,
                }}
              >
                {activeAgent.projectRole ?? activeAgent.role}
                {activeAgent.pausedAt ? " (PAUSED)" : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {/* Explicit summary line when the Lead has paused child peers via slp_pause_peers. */}
      {pausedAgentCount > 0 ? (
        <Text style={styles.warningText}>
          {pausedAgentCount} peer{pausedAgentCount === 1 ? "" : "s"} paused by Lead
        </Text>
      ) : null}
    </Pressable>
  );
}

// Project-scoped Kanban board section showing Spec -> Brief -> Score -> Rework -> Done and live agent activity.
export function KanbanBoardSection({
  styles,
  theme,
  projectRepoPath,
  projectDisplayName,
  selectedRunId,
  onOpenSupervisor,
}: KanbanBoardSectionProps) {
  const runsListQuery = useRunList();
  const allRuns = runsListQuery.data?.runs ?? [];

  // Match runs belonging to this workspace's project root path, preferring an active running session.
  const projectRuns = projectRepoPath
    ? allRuns.filter((runSummary) => runSummary.repoPath === projectRepoPath)
    : allRuns;
  const activeProjectRun =
    (selectedRunId ? projectRuns.find((runSummary) => runSummary.id === selectedRunId) : undefined) ??
    projectRuns.find((runSummary) => runSummary.status === "running" && !runSummary.archivedAt) ??
    projectRuns[0] ??
    null;

  const [customRepoPath, setCustomRepoPath] = useState("");
  const effectiveRepoPath =
    projectRepoPath?.trim() || customRepoPath.trim() || activeProjectRun?.repoPath || "";

  // Poll the project-scoped board tickets every 2 seconds so agent activity and Brief updates appear live.
  const boardQuery = useBoardTickets({
    repoPath: effectiveRepoPath || null,
    runId: activeProjectRun?.id ?? selectedRunId ?? null,
  });
  const { saveBoardSpec } = useBoardActions();

  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [isCreatingSpec, setIsCreatingSpec] = useState(false);
  const [newSpecTitle, setNewSpecTitle] = useState("");
  const [newSpecCriteria, setNewSpecCriteria] = useState("");
  const [newSpecContent, setNewSpecContent] = useState("");

  const boardTickets = boardQuery.data?.tickets ?? [];
  // Keep the selected ticket open across polls, defaulting to the most recently updated ticket.
  const selectedTicket =
    boardTickets.find((ticket) => ticket.id === selectedTicketId) ??
    boardTickets[0] ??
    null;

  const boardErrorMessage =
    describeRpcError(boardQuery.error) ?? describeRpcError(saveBoardSpec.error);

  const handleCreateNewSpecTicket = () => {
    if (!effectiveRepoPath || !newSpecTitle.trim() || !newSpecContent.trim()) return;
    // Creating a Spec ticket from the board stores Spec v1 and notifies the active Supervisor if a run is active.
    saveBoardSpec.mutate(
      {
        repoPath: effectiveRepoPath,
        runId: activeProjectRun?.id ?? selectedRunId ?? undefined,
        title: newSpecTitle.trim(),
        acceptanceCriteria: newSpecCriteria.trim() || undefined,
        specContent: newSpecContent.trim(),
        summary: "Created Spec ticket on Kanban board",
      },
      {
        onSuccess: (createdResponse) => {
          setSelectedTicketId(createdResponse.ticket.id);
          setIsCreatingSpec(false);
          setNewSpecTitle("");
          setNewSpecCriteria("");
          setNewSpecContent("");
        },
      },
    );
  };

  return (
    <View style={styles.card}>
      {/* Section header shows the active project name, active run status, and the + New Spec button. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <View style={{ gap: 2 }}>
          <Text style={styles.sectionTitle}>
            {projectDisplayName ? `${projectDisplayName} · ` : ""}Spec & Brief Kanban ({boardTickets.length})
          </Text>
          <Text style={styles.mutedText}>
            {effectiveRepoPath || "No project selected"}
            {activeProjectRun ? ` · Active Run: ${activeProjectRun.title} (${activeProjectRun.status})` : ""}
          </Text>
        </View>
        <View style={styles.row}>
          {activeProjectRun && onOpenSupervisor ? (
            <ActionButton
              styles={styles}
              label="Open Supervisor Chat"
              accessibilityLabel={`Open Supervisor chat for ${activeProjectRun.title}`}
              onPress={() => onOpenSupervisor(activeProjectRun.supervisorAgentId)}
            />
          ) : null}
          {effectiveRepoPath ? (
            <ActionButton
              styles={styles}
              tone={isCreatingSpec ? "secondary" : "primary"}
              label={isCreatingSpec ? "Cancel New Spec" : "+ New Spec Ticket"}
              accessibilityLabel="Create a new Spec ticket on the Kanban board"
              onPress={() => setIsCreatingSpec((previousState) => !previousState)}
            />
          ) : null}
        </View>
      </View>

      {/* Only show the manual repository path input when not already scoped to a workspace's project root. */}
      {!projectRepoPath ? (
        <View style={styles.row}>
          <Text style={styles.fieldLabel}>Project Repo:</Text>
          <TextInput
            style={[styles.input, { flex: 1, minWidth: 220 }]}
            value={customRepoPath || activeProjectRun?.repoPath || ""}
            onChangeText={setCustomRepoPath}
            placeholder="/path/to/git/repository"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>
      ) : null}

      {/* Inline creation form for authoring a new Spec ticket directly on the Kanban board. */}
      {isCreatingSpec ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={styles.sectionTitle}>Create New Spec Ticket</Text>
          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            style={styles.input}
            value={newSpecTitle}
            onChangeText={setNewSpecTitle}
            placeholder="Feature or Epic title"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
          <Text style={styles.fieldLabel}>Acceptance Criteria (optional)</Text>
          <TextInput
            style={styles.input}
            value={newSpecCriteria}
            onChangeText={setNewSpecCriteria}
            placeholder="High-level acceptance criteria"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
          <Text style={styles.fieldLabel}>Spec Requirements (Shared with Supervisor)</Text>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            value={newSpecContent}
            onChangeText={setNewSpecContent}
            multiline
            placeholder="Write the full feature specification..."
            placeholderTextColor={theme.colors.foregroundMuted}
          />
          <ActionButton
            styles={styles}
            tone="primary"
            label={saveBoardSpec.isPending ? "Saving..." : "Create Spec & Notify Supervisor"}
            accessibilityLabel="Create Spec ticket and notify Supervisor"
            disabled={saveBoardSpec.isPending || !newSpecTitle.trim() || !newSpecContent.trim()}
            onPress={handleCreateNewSpecTicket}
          />
        </View>
      ) : null}

      {boardErrorMessage ? <Text style={styles.dangerText}>{boardErrorMessage}</Text> : null}

      {/* Horizontal 5-column Kanban board: SPEC -> BRIEF -> SCORE -> REWORK -> DONE. */}
      {!effectiveRepoPath ? (
        <Text style={styles.mutedText}>
          Open a project workspace to view its Spec & Brief Kanban board.
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 10 }}>
          {BOARD_COLUMNS.map((columnKey) => {
            const columnTickets = boardTickets.filter((ticket) => ticket.column === columnKey);
            const columnAccent = resolveColumnAccentColor(theme, columnKey);
            return (
              <View
                key={columnKey}
                style={[
                  styles.card,
                  {
                    width: 250,
                    backgroundColor: theme.colors.surface0,
                    borderTopWidth: 3,
                    borderTopColor: columnAccent,
                  },
                ]}
              >
                <View style={[styles.row, { justifyContent: "space-between" }]}>
                  <Text style={{ color: columnAccent, fontWeight: "700", fontSize: 13 }}>
                    {COLUMN_TITLES[columnKey]}
                  </Text>
                  <Text style={styles.mutedText}>{columnTickets.length}</Text>
                </View>
                {columnTickets.length === 0 ? (
                  <Text style={styles.mutedText}>No tickets</Text>
                ) : (
                  <View style={styles.stack}>
                    {columnTickets.map((columnTicket) => (
                      <KanbanTicketCard
                        key={columnTicket.id}
                        styles={styles}
                        theme={theme}
                        ticket={columnTicket}
                        isSelected={selectedTicket?.id === columnTicket.id}
                        onSelect={() => setSelectedTicketId(columnTicket.id)}
                      />
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Detail panel below the columns lets the human inspect diffs and edit the Spec of the selected ticket. */}
      {selectedTicket ? (
        <TicketDetailPanel
          styles={styles}
          theme={theme}
          ticket={selectedTicket}
          selectedRunId={activeProjectRun?.id ?? selectedRunId ?? null}
          onClose={() => setSelectedTicketId(null)}
        />
      ) : null}
    </View>
  );
}
