// Project-scoped Kanban board decomposing each Spec into its Brief card and individual gradable Option cards.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { BOARD_COLUMNS, type BoardColumn, type BoardTicket, type BriefItem } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions, useBoardTickets } from "../../use-board";
import { describeRpcError, useRunList } from "../../use-run";
import { ActionButton } from "../action-button";
import { BriefKanbanCard, OptionKanbanCard, SpecKanbanCard } from "./kanban-cards";
import {
  type KanbanCardSelection,
  partitionTicketBriefItems,
  resolveOptionCardColumn,
  resolveSpecColorIdentity,
} from "./kanban-palette";
import { TicketDetailPanel } from "./ticket-detail-panel";

interface KanbanBoardSectionProps {
  styles: UiStyles;
  theme: PluginTheme;
  projectRepoPath?: string | null;
  projectDisplayName?: string | null;
  selectedRunId?: string | null;
  onOpenSupervisor?: (supervisorAgentId: string) => void;
}

// Column titles showing the flow from Supervisor Spec -> Lead Brief -> QA Score -> Rework -> Done.
const COLUMN_TITLES: Record<BoardColumn, string> = {
  spec: "1. SPEC",
  brief: "2. BRIEF",
  score: "3. SCORE",
  rework: "4. REWORK",
  done: "5. DONE",
};

// Assigns a distinct accent color to each Kanban column header.
function resolveColumnAccentColor(theme: PluginTheme, column: BoardColumn): string {
  // Done is green, Rework is red, Score is amber, Brief is accent blue, and Spec is foreground muted.
  if (column === "done") return theme.colors.statusSuccess;
  if (column === "rework") return theme.colors.statusDanger;
  if (column === "score") return theme.colors.statusWarning;
  if (column === "brief") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

// Checks whether a given card matches the currently selected card state.
function isCardSelected(
  currentSelection: KanbanCardSelection | null,
  candidateSelection: KanbanCardSelection,
): boolean {
  if (!currentSelection || currentSelection.kind !== candidateSelection.kind) return false;
  if (currentSelection.ticketId !== candidateSelection.ticketId) return false;
  if (currentSelection.kind === "option" && candidateSelection.kind === "option") {
    return currentSelection.optionId === candidateSelection.optionId;
  }
  return true;
}

// Renders the Spec -> Brief -> Option Kanban board with color-matched borders, lineage tags, and focused card inspectors.
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

  // Match runs belonging to this workspace's project root path, preferring the currently active Supervisor session.
  const projectRuns = projectRepoPath
    ? allRuns.filter((runSummary) => runSummary.repoPath === projectRepoPath)
    : allRuns;
  const activeProjectRun =
    (selectedRunId ? projectRuns.find((runSummary) => runSummary.id === selectedRunId) : undefined) ??
    projectRuns.find(
      (runSummary) =>
        !runSummary.archivedAt &&
        runSummary.status !== "aborted" &&
        runSummary.status !== "completed",
    ) ??
    projectRuns.find((runSummary) => !runSummary.archivedAt && runSummary.status !== "aborted") ??
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

  // Default to "active_supervisor" so only the Spec, Brief, and Options of the currently active Supervisor are shown.
  const [selectedCard, setSelectedCard] = useState<KanbanCardSelection | null>(null);
  const [filterMode, setFilterMode] = useState<"active_supervisor" | "all" | string>("active_supervisor");
  const [isCreatingSpec, setIsCreatingSpec] = useState(false);
  const [newSpecTitle, setNewSpecTitle] = useState("");
  const [newSpecCriteria, setNewSpecCriteria] = useState("");
  const [newSpecContent, setNewSpecContent] = useState("");

  const allProjectTickets = boardQuery.data?.tickets ?? [];
  // Scope tickets belonging to the active Supervisor's run so finished/aborted runs do not clutter the board.
  const activeSupervisorTickets = activeProjectRun
    ? allProjectTickets.filter((ticket) => ticket.activeRunId === activeProjectRun.id)
    : allProjectTickets;

  const visibleTickets =
    filterMode === "active_supervisor"
      ? activeSupervisorTickets
      : filterMode === "all"
        ? allProjectTickets
        : allProjectTickets.filter((ticket) => ticket.id === filterMode);

  const selectedTicket = selectedCard
    ? allProjectTickets.find((ticket) => ticket.id === selectedCard.ticketId) ?? null
    : null;

  const boardErrorMessage =
    describeRpcError(boardQuery.error) ?? describeRpcError(saveBoardSpec.error);

  // Toggles selection when the user clicks a Spec card, Brief card, or Option card.
  const handleToggleCardSelection = (nextSelection: KanbanCardSelection) => {
    setSelectedCard((previousSelection) =>
      isCardSelected(previousSelection, nextSelection) ? null : nextSelection,
    );
  };

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
          setSelectedCard({ kind: "spec", ticketId: createdResponse.ticket.id });
          setIsCreatingSpec(false);
          setNewSpecTitle("");
          setNewSpecCriteria("");
          setNewSpecContent("");
        },
      },
    );
  };

  // Precompute all decomposed Brief cards and individual Option cards across the visible Specs.
  const briefTicketsInColumn = visibleTickets.filter(
    (ticket) => ticket.currentBriefRev > 0 || Boolean(ticket.approach.trim()),
  );
  const optionEntriesByColumn: Record<
    Exclude<BoardColumn, "spec">,
    Array<{ ticket: BoardTicket; optionBullet: BriefItem }>
  > = {
    brief: [],
    score: [],
    rework: [],
    done: [],
  };

  for (const visibleTicket of visibleTickets) {
    const { gradableOptions } = partitionTicketBriefItems(visibleTicket);
    for (const optionBullet of gradableOptions) {
      const targetOptionColumn = resolveOptionCardColumn(visibleTicket, optionBullet);
      optionEntriesByColumn[targetOptionColumn].push({
        ticket: visibleTicket,
        optionBullet,
      });
    }
  }

  return (
    <View style={styles.card}>
      {/* Section header shows the active project name, active run status, and the + New Spec button. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <View style={{ gap: 2 }}>
          <Text style={styles.sectionTitle}>
            {projectDisplayName ? `${projectDisplayName} · ` : ""}Spec & Brief Kanban
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
              label={isCreatingSpec ? "Cancel New Spec" : "+ New Spec"}
              accessibilityLabel="Create a new Spec card on the Kanban board"
              onPress={() => setIsCreatingSpec((previousState) => !previousState)}
            />
          ) : null}
        </View>
      </View>

      {/* Scope filter bar defaults to Active Supervisor only so finished/aborted runs stay out of the way. */}
      {allProjectTickets.length > 0 ? (
        <View style={styles.row}>
          <Text style={styles.fieldLabel}>Scope:</Text>
          <Pressable
            onPress={() => setFilterMode("active_supervisor")}
            style={[
              styles.chip,
              {
                borderColor: filterMode === "active_supervisor" ? theme.colors.accent : theme.colors.border,
                backgroundColor: filterMode === "active_supervisor" ? theme.colors.surface2 : theme.colors.surface1,
              },
            ]}
          >
            <Text style={styles.chipText}>
              Active Supervisor ({activeSupervisorTickets.length})
            </Text>
          </Pressable>
          {(filterMode === "all" ? allProjectTickets : activeSupervisorTickets).map((projectTicket) => {
            const specColor = resolveSpecColorIdentity(projectTicket);
            const isActiveFilter = filterMode === projectTicket.id;
            return (
              <Pressable
                key={projectTicket.id}
                onPress={() =>
                  setFilterMode((previousMode) =>
                    previousMode === projectTicket.id ? "active_supervisor" : projectTicket.id,
                  )
                }
                style={[
                  styles.chip,
                  {
                    borderWidth: isActiveFilter ? 2 : 1,
                    borderColor: specColor.borderColor,
                    backgroundColor: isActiveFilter ? specColor.badgeBackground : theme.colors.surface1,
                  },
                ]}
              >
                <Text style={{ fontSize: 11, fontWeight: "700", color: specColor.badgeTextColor }}>
                  {projectTicket.ticketKey} → {specColor.briefTagCode}
                </Text>
              </Pressable>
            );
          })}
          {allProjectTickets.length > activeSupervisorTickets.length ? (
            <Pressable
              onPress={() =>
                setFilterMode((previousMode) =>
                  previousMode === "all" ? "active_supervisor" : "all",
                )
              }
              style={[
                styles.chip,
                {
                  borderColor: filterMode === "all" ? theme.colors.accent : theme.colors.border,
                  backgroundColor: filterMode === "all" ? theme.colors.surface2 : theme.colors.surface1,
                },
              ]}
            >
              <Text style={styles.chipText}>All History ({allProjectTickets.length})</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

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

      {/* Inline creation form for authoring a new Spec card directly on the Kanban board. */}
      {isCreatingSpec ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={styles.sectionTitle}>Create New Spec Card</Text>
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
            accessibilityLabel="Create Spec card and notify Supervisor"
            disabled={saveBoardSpec.isPending || !newSpecTitle.trim() || !newSpecContent.trim()}
            onPress={handleCreateNewSpecTicket}
          />
        </View>
      ) : null}

      {boardErrorMessage ? <Text style={styles.dangerText}>{boardErrorMessage}</Text> : null}

      {/* Horizontal 5-column Kanban board on the left and a dedicated right-hand detail sidebar when a card is selected. */}
      {!effectiveRepoPath ? (
        <Text style={styles.mutedText}>
          Open a project workspace to view its Spec & Brief Kanban board.
        </Text>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            style={{ flex: 1, minWidth: 0 }}
            contentContainerStyle={{ gap: 12 }}
          >
            {BOARD_COLUMNS.map((columnKey) => {
              const columnAccent = resolveColumnAccentColor(theme, columnKey);
              const columnCardCount =
                columnKey === "spec"
                  ? visibleTickets.length
                  : columnKey === "brief"
                    ? briefTicketsInColumn.length + optionEntriesByColumn.brief.length
                    : optionEntriesByColumn[columnKey].length;

              return (
                <View
                  key={columnKey}
                  style={[
                    styles.card,
                    {
                      width: 280,
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
                    <Text style={styles.mutedText}>{columnCardCount}</Text>
                  </View>

                  {columnCardCount === 0 ? (
                    <Text style={styles.mutedText}>No cards</Text>
                  ) : (
                    <View style={styles.stack}>
                      {/* Column 1 (SPEC) holds only the high-level Spec cards handed from Supervisor to Lead. */}
                      {columnKey === "spec"
                        ? visibleTickets.map((specTicket) => (
                            <SpecKanbanCard
                              key={`spec-card-${specTicket.id}`}
                              styles={styles}
                              theme={theme}
                              ticket={specTicket}
                              isSelected={isCardSelected(selectedCard, {
                                kind: "spec",
                                ticketId: specTicket.id,
                              })}
                              onSelect={() =>
                                handleToggleCardSelection({ kind: "spec", ticketId: specTicket.id })
                              }
                            />
                          ))
                        : null}

                      {/* Column 2 (BRIEF) holds the Lead's Brief overview cards plus any unscored Option cards. */}
                      {columnKey === "brief"
                        ? briefTicketsInColumn.map((briefTicket) => (
                            <BriefKanbanCard
                              key={`brief-card-${briefTicket.id}`}
                              styles={styles}
                              theme={theme}
                              ticket={briefTicket}
                              isSelected={isCardSelected(selectedCard, {
                                kind: "brief",
                                ticketId: briefTicket.id,
                              })}
                              onSelect={() =>
                                handleToggleCardSelection({ kind: "brief", ticketId: briefTicket.id })
                              }
                            />
                          ))
                        : null}

                      {/* Render each gradable Option (C1, C2, ...) as its own separate card in BRIEF / SCORE / REWORK / DONE. */}
                      {columnKey !== "spec"
                        ? optionEntriesByColumn[columnKey].map(({ ticket, optionBullet }) => (
                            <OptionKanbanCard
                              key={`opt-card-${ticket.id}-${optionBullet.id}`}
                              styles={styles}
                              theme={theme}
                              ticket={ticket}
                              optionBullet={optionBullet}
                              isSelected={isCardSelected(selectedCard, {
                                kind: "option",
                                ticketId: ticket.id,
                                optionId: optionBullet.id,
                              })}
                              onSelect={() =>
                                handleToggleCardSelection({
                                  kind: "option",
                                  ticketId: ticket.id,
                                  optionId: optionBullet.id,
                                })
                              }
                            />
                          ))
                        : null}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {/* Right-hand sidebar drawer renders the focused inspector for the selected Spec, Brief, or Option card. */}
          {selectedTicket && selectedCard ? (
            <ScrollView
              style={{ width: 390, maxHeight: 740, flexShrink: 0 }}
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
            >
              <TicketDetailPanel
                styles={styles}
                theme={theme}
                ticket={selectedTicket}
                selection={selectedCard}
                selectedRunId={activeProjectRun?.id ?? selectedRunId ?? null}
                onClose={() => setSelectedCard(null)}
              />
            </ScrollView>
          ) : null}
        </View>
      )}
    </View>
  );
}
