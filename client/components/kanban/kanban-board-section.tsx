// Project-scoped Kanban workspace splitting the resizable Spec/Inspector sidebar from the 5-column Kanban board.
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { BOARD_COLUMNS, type BoardColumn, type BoardTicket, type BriefItem } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { useBoardActions, useBoardTickets } from "../../use-board";
import { describeRpcError, useRunList } from "../../use-run";
import { BriefKanbanCard, OptionKanbanCard, SpecKanbanCard } from "./kanban-cards";
import {
  type KanbanCardSelection,
  partitionTicketBriefItems,
  resolveOptionCardColumn,
} from "./kanban-palette";
import {
  DEFAULT_KANBAN_SIDEBAR_WIDTH_PX,
  KanbanSidebar,
  KanbanSidebarResizeHandle,
} from "./kanban-sidebar";

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

// Renders the resizable left sidebar and the separate 5-column Kanban board side-by-side.
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

  // Sidebar width and collapsed state allow the operator to drag-resize or collapse the sidebar independently of the board.
  const [sidebarWidthPx, setSidebarWidthPx] = useState<number>(DEFAULT_KANBAN_SIDEBAR_WIDTH_PX);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);

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

  // Selecting a card on the Kanban board opens its inspector inside the sidebar and exits the New Spec creation form.
  const handleToggleCardSelection = (nextSelection: KanbanCardSelection) => {
    setSelectedCard((previousSelection) => {
      const willDeselect = isCardSelected(previousSelection, nextSelection);
      if (!willDeselect) {
        setIsCreatingSpec(false);
        setIsSidebarCollapsed(false);
      }
      return willDeselect ? null : nextSelection;
    });
  };

  // Toggling "+ New Spec" always opens the form inside the sidebar rather than rendering a top card above the board.
  const handleToggleCreatingSpec = () => {
    setIsCreatingSpec((previousCreatingState) => {
      const nextCreatingState = !previousCreatingState;
      if (nextCreatingState) {
        setIsSidebarCollapsed(false);
      }
      return nextCreatingState;
    });
  };

  const handleCreateNewSpecTicket = () => {
    if (!effectiveRepoPath || !newSpecTitle.trim() || !newSpecContent.trim()) return;
    // Creating a Spec ticket from the sidebar stores Spec v1 and notifies the active Supervisor if a run is active.
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
          setIsSidebarCollapsed(false);
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
    <View style={{ flex: 1, flexDirection: "row", alignItems: "stretch", minHeight: 620 }}>
      {/* Separate Kanban board card on the left containing only the 5 workflow columns so no card sits horizontally on top. */}
      <View style={[styles.card, { flex: 1, minWidth: 0, alignSelf: "stretch", gap: 10 }]}>
        {!effectiveRepoPath ? (
          <Text style={styles.mutedText}>
            Open a project workspace or enter a repository path in the right sidebar to view its Spec & Brief Kanban board.
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            style={{ flex: 1, minWidth: 0 }}
            contentContainerStyle={{ gap: 12, alignItems: "flex-start" }}
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
        )}
      </View>

      {/* Draggable splitter bar separating the Kanban board container on the left from the sidebar on the right. */}
      <KanbanSidebarResizeHandle
        theme={theme}
        sidebarWidthPx={sidebarWidthPx}
        isSidebarCollapsed={isSidebarCollapsed}
        onChangeSidebarWidthPx={setSidebarWidthPx}
        onChangeSidebarCollapsed={setIsSidebarCollapsed}
      />

      {/* Independent resizable sidebar on the right for project controls, New Spec creation, and selected card inspection. */}
      <KanbanSidebar
        styles={styles}
        theme={theme}
        projectDisplayName={projectDisplayName}
        projectRepoPath={projectRepoPath}
        effectiveRepoPath={effectiveRepoPath}
        customRepoPath={customRepoPath}
        onChangeCustomRepoPath={setCustomRepoPath}
        activeProjectRun={activeProjectRun}
        selectedRunId={selectedRunId}
        allProjectTickets={allProjectTickets}
        activeSupervisorTickets={activeSupervisorTickets}
        filterMode={filterMode}
        onSelectFilterMode={setFilterMode}
        isCreatingSpec={isCreatingSpec}
        onToggleCreatingSpec={handleToggleCreatingSpec}
        newSpecTitle={newSpecTitle}
        onChangeNewSpecTitle={setNewSpecTitle}
        newSpecCriteria={newSpecCriteria}
        onChangeNewSpecCriteria={setNewSpecCriteria}
        newSpecContent={newSpecContent}
        onChangeNewSpecContent={setNewSpecContent}
        isSavingNewSpec={saveBoardSpec.isPending}
        onSubmitNewSpec={handleCreateNewSpecTicket}
        boardErrorMessage={boardErrorMessage}
        selectedTicket={selectedTicket}
        selectedCard={selectedCard}
        onSelectCard={setSelectedCard}
        onOpenSupervisor={onOpenSupervisor}
        sidebarWidthPx={sidebarWidthPx}
        isSidebarCollapsed={isSidebarCollapsed}
      />
    </View>
  );
}
