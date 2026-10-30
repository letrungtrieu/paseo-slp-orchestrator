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
import { MockupKanbanCard } from "./mockup-kanban-card";
import { MockupPreviewModal } from "./mockup-preview-modal";
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

// Column titles showing the flow from Supervisor Spec -> Lead HTML Mockup -> Lead Brief -> QA Score -> Rework -> Done.
const COLUMN_TITLES: Record<BoardColumn, string> = {
  spec: "1. SPEC",
  mockup: "2. MOCKUP",
  brief: "3. BRIEF",
  score: "4. SCORE",
  rework: "5. REWORK",
  done: "6. DONE",
};

// Assigns a distinct accent color to each Kanban column header.
function resolveColumnAccentColor(theme: PluginTheme, column: BoardColumn): string {
  // Done is green, Rework is red, Score is amber, Brief/Mockup are accent blue, and Spec is foreground muted.
  if (column === "done") return theme.colors.statusSuccess;
  if (column === "rework") return theme.colors.statusDanger;
  if (column === "score") return theme.colors.statusWarning;
  if (column === "mockup" || column === "brief") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

// Derives a concise Spec ticket title from the first non-empty line of the Spec Requirements text.
function deriveSpecTitleFromContent(specText: string, fallbackTitle = "Product Spec"): string {
  const firstMeaningfulLine = specText
    .split(/\r?\n/)
    .map((rawLine) => rawLine.replace(/^[#*\-\d.)\s]+/, "").trim())
    .find((cleanedLine) => cleanedLine.length > 0);
  if (!firstMeaningfulLine) return fallbackTitle;
  return firstMeaningfulLine.length > 80
    ? `${firstMeaningfulLine.slice(0, 77).trimEnd()}...`
    : firstMeaningfulLine;
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
  const { saveBoardSpec, spawnSpecAgent } = useBoardActions();

  // Default to "active_supervisor" so only the Spec, Mockup, Brief, and Options of the currently active Supervisor are shown.
  const [selectedCard, setSelectedCard] = useState<KanbanCardSelection | null>(null);
  const [activePreviewTarget, setActivePreviewTarget] = useState<{
    ticketId: string;
    version: number;
  } | null>(null);
  const [filterMode, setFilterMode] = useState<"active_supervisor" | "all" | string>("active_supervisor");
  const [isCreatingSpec, setIsCreatingSpec] = useState(false);
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
    describeRpcError(boardQuery.error) ??
    describeRpcError(saveBoardSpec.error) ??
    describeRpcError(spawnSpecAgent.error);

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
    const trimmedSpecContent = newSpecContent.trim();
    if (!effectiveRepoPath || !trimmedSpecContent) return;
    // Derive the ticket title from the first line of the Spec Requirements so the user only needs one input field.
    const derivedSpecTitle = deriveSpecTitleFromContent(
      trimmedSpecContent,
      activeProjectRun?.title || "Product Spec",
    );
    // Creating a Spec ticket from the sidebar stores Spec v1 and notifies the active Supervisor if a run is active.
    saveBoardSpec.mutate(
      {
        repoPath: effectiveRepoPath,
        runId: activeProjectRun?.id ?? selectedRunId ?? undefined,
        title: derivedSpecTitle,
        specContent: trimmedSpecContent,
        summary: "Created Spec ticket on Kanban board",
      },
      {
        onSuccess: (createdResponse) => {
          setSelectedCard({ kind: "spec", ticketId: createdResponse.ticket.id });
          setIsCreatingSpec(false);
          setIsSidebarCollapsed(false);
          setNewSpecContent("");
        },
      },
    );
  };

  // Spawns a dedicated Read-Only Spec Agent connected to this repository's Kanban board and opens its chat view.
  const handleSpawnSpecAgent = (targetTicketKey?: string) => {
    if (!effectiveRepoPath) return;
    spawnSpecAgent.mutate(
      {
        repoPath: effectiveRepoPath,
        runId: activeProjectRun?.id ?? selectedRunId ?? undefined,
        ticketId: targetTicketKey,
      },
      {
        onSuccess: (spawnedResponse) => {
          onOpenSupervisor?.(spawnedResponse.agentId);
        },
      },
    );
  };

  // Precompute all Mockup cards, decomposed Brief cards, and individual Option cards across the visible Specs.
  const mockupTicketsInColumn = visibleTickets.filter(
    (ticket) => ticket.column === "mockup" || ticket.mockupRevisions.length > 0,
  );
  const briefTicketsInColumn = visibleTickets.filter(
    (ticket) => ticket.currentBriefRev > 0 || Boolean(ticket.approach.trim()),
  );
  const optionEntriesByColumn: Record<
    Exclude<BoardColumn, "spec" | "mockup">,
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

  const previewedTicket = activePreviewTarget
    ? allProjectTickets.find((ticket) => ticket.id === activePreviewTarget.ticketId) ?? null
    : null;

  const handleOpenPreviewVersion = (targetTicket: BoardTicket, versionNumber: number) => {
    setActivePreviewTarget({ ticketId: targetTicket.id, version: versionNumber });
  };

  if (previewedTicket && activePreviewTarget) {
    return (
      <MockupPreviewModal
        styles={styles}
        theme={theme}
        ticket={previewedTicket}
        initialVersion={activePreviewTarget.version}
        selectedRunId={activeProjectRun?.id ?? selectedRunId ?? null}
        onClose={() => setActivePreviewTarget(null)}
      />
    );
  }

  return (
    <View
      style={{
        flex: 1,
        height: "100%",
        maxHeight: "100%",
        minHeight: 0,
        flexDirection: "row",
        alignItems: "stretch",
        overflow: "hidden",
      }}
    >
      {/* Separate Kanban board card on the left containing the 6 workflow columns so no card sits horizontally on top. */}
      <View
        style={[
          styles.card,
          {
            flex: 1,
            minWidth: 0,
            height: "100%",
            maxHeight: "100%",
            minHeight: 0,
            alignSelf: "stretch",
            overflow: "hidden",
            gap: 10,
          },
        ]}
      >
        {!effectiveRepoPath ? (
          <Text style={styles.mutedText}>
            Open a project workspace or enter a repository path in the right sidebar to view its Spec & Brief Kanban board.
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            style={{ flex: 1, minWidth: 0, minHeight: 0 }}
            contentContainerStyle={{ gap: 12, alignItems: "flex-start" }}
          >
            {BOARD_COLUMNS.map((columnKey) => {
              const columnAccent = resolveColumnAccentColor(theme, columnKey);
              const columnCardCount =
                columnKey === "spec"
                  ? visibleTickets.length
                  : columnKey === "mockup"
                    ? mockupTicketsInColumn.length
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
                      maxHeight: "100%",
                      minHeight: 0,
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
                    <ScrollView
                      style={{ flexShrink: 1, minHeight: 0 }}
                      contentContainerStyle={styles.stack}
                      showsVerticalScrollIndicator
                    >
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

                      {/* Column 2 (MOCKUP) holds multi-version HTML/CSS/JS mockups formatted as `title (vN) [ → ]`. */}
                      {columnKey === "mockup"
                        ? mockupTicketsInColumn.map((mockupTicket) => (
                            <MockupKanbanCard
                              key={`mockup-card-${mockupTicket.id}`}
                              styles={styles}
                              theme={theme}
                              ticket={mockupTicket}
                              isSelected={isCardSelected(selectedCard, {
                                kind: "mockup",
                                ticketId: mockupTicket.id,
                              })}
                              onSelect={() =>
                                handleToggleCardSelection({
                                  kind: "mockup",
                                  ticketId: mockupTicket.id,
                                })
                              }
                              onOpenPreviewVersion={handleOpenPreviewVersion}
                            />
                          ))
                        : null}

                      {/* Column 3 (BRIEF) holds the Lead's Brief overview cards plus any unscored Option cards. */}
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
                      {columnKey !== "spec" && columnKey !== "mockup"
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
                    </ScrollView>
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
        newSpecContent={newSpecContent}
        onChangeNewSpecContent={setNewSpecContent}
        isSavingNewSpec={saveBoardSpec.isPending}
        onSubmitNewSpec={handleCreateNewSpecTicket}
        isSpawningSpecAgent={spawnSpecAgent.isPending}
        onSpawnSpecAgent={handleSpawnSpecAgent}
        boardErrorMessage={boardErrorMessage}
        selectedTicket={selectedTicket}
        selectedCard={selectedCard}
        onSelectCard={setSelectedCard}
        onOpenPreviewVersion={handleOpenPreviewVersion}
        onOpenSupervisor={onOpenSupervisor}
        sidebarWidthPx={sidebarWidthPx}
        isSidebarCollapsed={isSidebarCollapsed}
      />
    </View>
  );
}
