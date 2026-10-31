// Resizable and collapsible Kanban sidebar separating project controls, Spec creation, and card inspection from the Kanban columns.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRef, useState } from "react";
import { PanResponder, Pressable, Text, TextInput, View } from "react-native";
import type { BoardTicket } from "../../../shared/board";
import type { RunSummary } from "../../../shared/rpc";
import type { UiStyles } from "../../styles";
import { ActionButton } from "../action-button";
import { type KanbanCardSelection, resolveSpecColorIdentity } from "./kanban-palette";
import { SpecMarkdownEditor } from "./spec-markdown-editor";
import { TicketDetailPanel } from "./ticket-detail-panel";

// Enforce sensible sidebar width bounds so form inputs remain usable when narrowed and columns stay visible when widened.
const MIN_SIDEBAR_WIDTH_PX = 280;
const MAX_SIDEBAR_WIDTH_PX = 760;
const COLLAPSE_DRAG_THRESHOLD_PX = 190;
export const DEFAULT_KANBAN_SIDEBAR_WIDTH_PX = 380;

export interface KanbanSidebarProps {
  styles: UiStyles;
  theme: PluginTheme;
  projectDisplayName?: string | null;
  projectRepoPath?: string | null;
  effectiveRepoPath: string;
  customRepoPath: string;
  onChangeCustomRepoPath: (nextRepoPath: string) => void;
  activeProjectRun: RunSummary | null;
  allProjectTickets: BoardTicket[];
  activeSupervisorTickets: BoardTicket[];
  filterMode: "active_supervisor" | "all" | string;
  onSelectFilterMode: (nextFilterMode: "active_supervisor" | "all" | string) => void;
  isCreatingSpec: boolean;
  onToggleCreatingSpec: () => void;
  newSpecContent: string;
  onChangeNewSpecContent: (nextContent: string) => void;
  isSavingNewSpec: boolean;
  onSubmitNewSpec: () => void;
  isSpawningProductAgent: boolean;
  onSpawnProductAgent: (targetTicketKey?: string) => void;
  boardErrorMessage: string | null;
  selectedTicket: BoardTicket | null;
  selectedCard: KanbanCardSelection | null;
  onSelectCard: (nextSelection: KanbanCardSelection | null) => void;
  onOpenPreview?: (ticket: BoardTicket) => void;
  onOpenSupervisor?: (supervisorAgentId: string) => void;
  sidebarWidthPx: number;
  isSidebarCollapsed: boolean;
}

// Clamps a candidate sidebar width to the allowed min/max pixel range during drag gestures.
function clampSidebarWidthPx(candidateWidthPx: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(MAX_SIDEBAR_WIDTH_PX, Math.round(candidateWidthPx)));
}

// Vertical drag splitter placed between the sidebar and the Kanban board so the operator can drag to widen or narrow the sidebar.
export function KanbanSidebarResizeHandle({
  theme,
  sidebarWidthPx,
  isSidebarCollapsed,
  onChangeSidebarWidthPx,
  onChangeSidebarCollapsed,
}: {
  theme: PluginTheme;
  sidebarWidthPx: number;
  isSidebarCollapsed: boolean;
  onChangeSidebarWidthPx: (nextWidthPx: number) => void;
  onChangeSidebarCollapsed: (nextCollapsed: boolean) => void;
}) {
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  // Track the starting width at gesture grant so cumulative gestureState.dx maps 1:1 to pixel width changes.
  const dragOriginWidthRef = useRef<number>(sidebarWidthPx);
  const latestSidebarWidthRef = useRef<number>(sidebarWidthPx);
  const latestCollapsedStateRef = useRef<boolean>(isSidebarCollapsed);
  latestSidebarWidthRef.current = sidebarWidthPx;
  latestCollapsedStateRef.current = isSidebarCollapsed;

  // Keep callbacks in refs so PanResponder always invokes the latest state setters without recreating the responder mid-drag.
  const widthCallbackRef = useRef(onChangeSidebarWidthPx);
  const collapseCallbackRef = useRef(onChangeSidebarCollapsed);
  widthCallbackRef.current = onChangeSidebarWidthPx;
  collapseCallbackRef.current = onChangeSidebarCollapsed;

  const splitterPanResponder = useRef(
    PanResponder.create({
      // Capture horizontal drags immediately so parent ScrollViews do not intercept the resize gesture.
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: (_gestureEvent, gestureState) => Math.abs(gestureState.dx) > 2,
      onMoveShouldSetPanResponderCapture: (_gestureEvent, gestureState) => Math.abs(gestureState.dx) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        setIsDraggingSplitter(true);
        // When dragging inward from a collapsed right-hand rail, start from 44px so the sidebar expands smoothly leftward.
        dragOriginWidthRef.current = latestCollapsedStateRef.current ? 44 : latestSidebarWidthRef.current;
      },
      onPanResponderMove: (_gestureEvent, gestureState) => {
        // Because the sidebar sits on the right, dragging the splitter left (negative dx) widens the sidebar.
        const proposedSidebarWidthPx = dragOriginWidthRef.current - gestureState.dx;
        // Collapse automatically when the user drags the splitter rightward past the minimum collapse threshold.
        if (proposedSidebarWidthPx < COLLAPSE_DRAG_THRESHOLD_PX) {
          if (!latestCollapsedStateRef.current) {
            collapseCallbackRef.current(true);
          }
          return;
        }
        if (latestCollapsedStateRef.current) {
          collapseCallbackRef.current(false);
        }
        widthCallbackRef.current(clampSidebarWidthPx(proposedSidebarWidthPx));
      },
      onPanResponderRelease: () => {
        setIsDraggingSplitter(false);
      },
      onPanResponderTerminate: () => {
        setIsDraggingSplitter(false);
      },
    }),
  ).current;

  return (
    <View
      {...splitterPanResponder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Drag horizontally to resize Kanban sidebar"
      style={{
        width: 14,
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {/* Visual vertical divider pill that highlights in accent color while the user is actively dragging. */}
      <View
        style={{
          width: isDraggingSplitter ? 4 : 2,
          flex: 1,
          borderRadius: 999,
          backgroundColor: isDraggingSplitter ? theme.colors.accent : theme.colors.border,
          opacity: isDraggingSplitter ? 1 : 0.8,
        }}
      />
      <Pressable
        onPress={() => onChangeSidebarCollapsed(!isSidebarCollapsed)}
        accessibilityRole="button"
        accessibilityLabel={isSidebarCollapsed ? "Expand Kanban sidebar" : "Collapse Kanban sidebar"}
        style={{
          marginVertical: 6,
          paddingVertical: 6,
          paddingHorizontal: 3,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: isDraggingSplitter ? theme.colors.accent : theme.colors.border,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foreground }}>
          {isSidebarCollapsed ? "«" : "»"}
        </Text>
      </Pressable>
      <View
        style={{
          width: isDraggingSplitter ? 4 : 2,
          flex: 1,
          borderRadius: 999,
          backgroundColor: isDraggingSplitter ? theme.colors.accent : theme.colors.border,
          opacity: isDraggingSplitter ? 1 : 0.8,
        }}
      />
    </View>
  );
}

// Standalone right-hand sidebar housing project header, Scope filter, Create New Spec Card form, and TicketDetailPanel inspector.
export function KanbanSidebar({
  styles,
  theme,
  projectRepoPath,
  effectiveRepoPath,
  customRepoPath,
  onChangeCustomRepoPath,
  activeProjectRun,
  allProjectTickets,
  activeSupervisorTickets,
  filterMode,
  onSelectFilterMode,
  isCreatingSpec,
  onToggleCreatingSpec,
  newSpecContent,
  onChangeNewSpecContent,
  isSavingNewSpec,
  onSubmitNewSpec,
  isSpawningProductAgent,
  onSpawnProductAgent,
  boardErrorMessage,
  selectedTicket,
  selectedCard,
  onSelectCard,
  onOpenPreview,
  onOpenSupervisor,
  sidebarWidthPx,
  isSidebarCollapsed,
}: KanbanSidebarProps) {
  // Hide the sidebar body completely when collapsed; the single edge handle button on KanbanSidebarResizeHandle controls expand/collapse.
  if (isSidebarCollapsed) {
    return null;
  }

  return (
    <View
      style={[
        styles.card,
        {
          width: sidebarWidthPx,
          height: "100%",
          maxHeight: "100%",
          minHeight: 0,
          flexShrink: 0,
          alignSelf: "stretch",
          overflow: "hidden",
          gap: 10,
        },
      ]}
    >
      {/* Scope filter bar lets the operator isolate the active Supervisor's Spec or a single Spec family. */}
      {allProjectTickets.length > 0 ? (
        <View style={{ gap: 6, flexShrink: 0 }}>
          <Text style={styles.fieldLabel}>Scope Filter</Text>
          <View style={styles.row}>
            <Pressable
              onPress={() => onSelectFilterMode("active_supervisor")}
              style={[
                styles.chip,
                {
                  borderColor:
                    filterMode === "active_supervisor" ? theme.colors.accent : theme.colors.border,
                  backgroundColor:
                    filterMode === "active_supervisor"
                      ? theme.colors.surface2
                      : theme.colors.surface1,
                },
              ]}
            >
              <Text style={styles.chipText}>
                Active Supervisor ({activeSupervisorTickets.length})
              </Text>
            </Pressable>
            {(filterMode === "all" ? allProjectTickets : activeSupervisorTickets).map(
              (projectTicket) => {
                const specColor = resolveSpecColorIdentity(projectTicket);
                const isActiveFilter = filterMode === projectTicket.id;
                return (
                  <Pressable
                    key={projectTicket.id}
                    onPress={() =>
                      onSelectFilterMode(
                        filterMode === projectTicket.id ? "active_supervisor" : projectTicket.id,
                      )
                    }
                    style={[
                      styles.chip,
                      {
                        borderWidth: isActiveFilter ? 2 : 1,
                        borderColor: specColor.borderColor,
                        backgroundColor: isActiveFilter
                          ? specColor.badgeBackground
                          : theme.colors.surface1,
                      },
                    ]}
                  >
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: "700",
                        color: specColor.badgeTextColor,
                      }}
                    >
                      {projectTicket.ticketKey} → {specColor.briefTagCode}
                    </Text>
                  </Pressable>
                );
              },
            )}
            {allProjectTickets.length > activeSupervisorTickets.length ? (
              <Pressable
                onPress={() =>
                  onSelectFilterMode(filterMode === "all" ? "active_supervisor" : "all")
                }
                style={[
                  styles.chip,
                  {
                    borderColor: filterMode === "all" ? theme.colors.accent : theme.colors.border,
                    backgroundColor:
                      filterMode === "all" ? theme.colors.surface2 : theme.colors.surface1,
                  },
                ]}
              >
                <Text style={styles.chipText}>All History ({allProjectTickets.length})</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* Fallback repository path input when the panel is rendered outside a workspace context. */}
      {!projectRepoPath ? (
        <View style={{ gap: 4, flexShrink: 0 }}>
          <Text style={styles.fieldLabel}>Project Repo</Text>
          <TextInput
            style={styles.input}
            value={customRepoPath || activeProjectRun?.repoPath || ""}
            onChangeText={onChangeCustomRepoPath}
            placeholder="/path/to/git/repository"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>
      ) : null}

      {boardErrorMessage ? <Text style={styles.dangerText}>{boardErrorMessage}</Text> : null}

      {/* Bounded flex body so header buttons and bottom inputs stay fixed while only inner Spec/card content scrolls. */}
      <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {isCreatingSpec ? (
          <View
            style={[
              styles.card,
              {
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                backgroundColor: theme.colors.surface2,
                gap: 8,
              },
            ]}
          >
            <View
              style={[
                styles.row,
                { justifyContent: "space-between", alignItems: "center", flexShrink: 0 },
              ]}
            >
              <Text style={styles.sectionTitle}>Create New Spec Card</Text>
              <View style={styles.row}>
                <ActionButton
                  styles={styles}
                  label={isSpawningProductAgent ? "Opening Agent..." : "Discuss with Agent"}
                  accessibilityLabel="Open a Product Agent to discuss and draft this Spec"
                  disabled={isSpawningProductAgent}
                  onPress={() => onSpawnProductAgent()}
                />
                <ActionButton
                  styles={styles}
                  tone="secondary"
                  label="Cancel"
                  accessibilityLabel="Cancel creating new Spec card"
                  onPress={onToggleCreatingSpec}
                />
              </View>
            </View>
            {/* Only the Spec Markdown editor/preview area scrolls; top action buttons and bottom submit button stay fixed. */}
            <SpecMarkdownEditor
              styles={styles}
              theme={theme}
              markdownContent={newSpecContent}
              onChangeMarkdownContent={onChangeNewSpecContent}
              initialMode="edit"
            />
            <View style={{ flexShrink: 0 }}>
              <ActionButton
                styles={styles}
                tone="primary"
                label={isSavingNewSpec ? "Saving..." : "Create Spec"}
                accessibilityLabel="Create Spec card"
                disabled={isSavingNewSpec || !newSpecContent.trim()}
                onPress={onSubmitNewSpec}
              />
            </View>
          </View>
        ) : selectedTicket && selectedCard ? (
          <TicketDetailPanel
            styles={styles}
            theme={theme}
            ticket={selectedTicket}
            selection={selectedCard}
            isSpawningProductAgent={isSpawningProductAgent}
            onSpawnProductAgent={onSpawnProductAgent}
            onOpenPreview={onOpenPreview}
            onOpenSupervisor={onOpenSupervisor}
            onClose={() => onSelectCard(null)}
          />
        ) : (
          // New work starts with the Product Agent; "+ New Spec" remains for features whose Spec is already written.
          <View style={[styles.row, { justifyContent: "center" }]}>
            {effectiveRepoPath ? (
              <>
                <ActionButton
                  styles={styles}
                  tone="primary"
                  label={isSpawningProductAgent ? "Opening Agent..." : "+ New Feature"}
                  accessibilityLabel="Open a Product Agent to shape a new feature"
                  disabled={isSpawningProductAgent}
                  onPress={() => onSpawnProductAgent()}
                />
                <ActionButton
                  styles={styles}
                  label="+ New Spec"
                  accessibilityLabel="Create a new Spec card manually in the sidebar"
                  onPress={onToggleCreatingSpec}
                />
              </>
            ) : null}
            {activeProjectRun && onOpenSupervisor ? (
              <ActionButton
                styles={styles}
                label="Open Supervisor Chat"
                accessibilityLabel={`Open Supervisor chat for ${activeProjectRun.title}`}
                onPress={() => onOpenSupervisor(activeProjectRun.supervisorAgentId)}
              />
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}
