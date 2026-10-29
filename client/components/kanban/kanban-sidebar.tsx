// Resizable and collapsible Kanban sidebar separating project controls, Spec creation, and card inspection from the Kanban columns.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRef, useState } from "react";
import { PanResponder, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { BoardTicket } from "../../../shared/board";
import type { RunSummary } from "../../../shared/rpc";
import type { UiStyles } from "../../styles";
import { ActionButton } from "../action-button";
import { type KanbanCardSelection, resolveSpecColorIdentity } from "./kanban-palette";
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
  selectedRunId?: string | null;
  allProjectTickets: BoardTicket[];
  activeSupervisorTickets: BoardTicket[];
  filterMode: "active_supervisor" | "all" | string;
  onSelectFilterMode: (nextFilterMode: "active_supervisor" | "all" | string) => void;
  isCreatingSpec: boolean;
  onToggleCreatingSpec: () => void;
  newSpecTitle: string;
  onChangeNewSpecTitle: (nextTitle: string) => void;
  newSpecCriteria: string;
  onChangeNewSpecCriteria: (nextCriteria: string) => void;
  newSpecContent: string;
  onChangeNewSpecContent: (nextContent: string) => void;
  isSavingNewSpec: boolean;
  onSubmitNewSpec: () => void;
  boardErrorMessage: string | null;
  selectedTicket: BoardTicket | null;
  selectedCard: KanbanCardSelection | null;
  onSelectCard: (nextSelection: KanbanCardSelection | null) => void;
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
  projectDisplayName,
  projectRepoPath,
  effectiveRepoPath,
  customRepoPath,
  onChangeCustomRepoPath,
  activeProjectRun,
  selectedRunId,
  allProjectTickets,
  activeSupervisorTickets,
  filterMode,
  onSelectFilterMode,
  isCreatingSpec,
  onToggleCreatingSpec,
  newSpecTitle,
  onChangeNewSpecTitle,
  newSpecCriteria,
  onChangeNewSpecCriteria,
  newSpecContent,
  onChangeNewSpecContent,
  isSavingNewSpec,
  onSubmitNewSpec,
  boardErrorMessage,
  selectedTicket,
  selectedCard,
  onSelectCard,
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
          flexShrink: 0,
          alignSelf: "stretch",
          gap: 10,
        },
      ]}
    >
      {/* Sidebar header displays project identity and active run status without duplicating the edge collapse control. */}
      <View style={{ gap: 2 }}>
        <Text style={styles.sectionTitle} numberOfLines={2}>
          {projectDisplayName ? `${projectDisplayName} · ` : ""}Spec & Brief Kanban
        </Text>
        <Text style={styles.mutedText} numberOfLines={2}>
          {effectiveRepoPath || "No project selected"}
        </Text>
        {activeProjectRun ? (
          <Text style={styles.mutedText} numberOfLines={1}>
            Active Run: {activeProjectRun.title} ({activeProjectRun.status})
          </Text>
        ) : null}
      </View>

      {/* Primary sidebar actions for opening Supervisor chat or toggling the New Spec creation form inside the sidebar. */}
      <View style={styles.row}>
        {effectiveRepoPath ? (
          <ActionButton
            styles={styles}
            tone={isCreatingSpec ? "secondary" : "primary"}
            label={isCreatingSpec ? "Cancel New Spec" : "+ New Spec"}
            accessibilityLabel="Create a new Spec card in the sidebar"
            onPress={onToggleCreatingSpec}
          />
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

      {/* Scope filter bar lets the operator isolate the active Supervisor's Spec or a single Spec family. */}
      {allProjectTickets.length > 0 ? (
        <View style={{ gap: 6 }}>
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
        <View style={{ gap: 4 }}>
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

      {/* Scrollable sidebar body stretches to full height so the Create New Spec Card form fills the sidebar vertically. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, gap: 10 }}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        {isCreatingSpec ? (
          <View style={[styles.card, { flex: 1, backgroundColor: theme.colors.surface2, gap: 8 }]}>
            <Text style={styles.sectionTitle}>Create New Spec Card</Text>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={styles.input}
              value={newSpecTitle}
              onChangeText={onChangeNewSpecTitle}
              placeholder="Feature or Epic title"
              placeholderTextColor={theme.colors.foregroundMuted}
            />
            <Text style={styles.fieldLabel}>Acceptance Criteria (optional)</Text>
            <TextInput
              style={styles.input}
              value={newSpecCriteria}
              onChangeText={onChangeNewSpecCriteria}
              placeholder="High-level acceptance criteria"
              placeholderTextColor={theme.colors.foregroundMuted}
            />
            <Text style={styles.fieldLabel}>Spec Requirements (Shared with Supervisor)</Text>
            {/* Let the multiline Spec Requirements editor grow to fill the remaining vertical height of the sidebar card. */}
            <TextInput
              style={[styles.input, { flex: 1, minHeight: 220, textAlignVertical: "top" }]}
              value={newSpecContent}
              onChangeText={onChangeNewSpecContent}
              multiline
              placeholder="Write the full feature specification..."
              placeholderTextColor={theme.colors.foregroundMuted}
            />
            <ActionButton
              styles={styles}
              tone="primary"
              label={isSavingNewSpec ? "Saving..." : "Create Spec & Notify Supervisor"}
              accessibilityLabel="Create Spec card and notify Supervisor"
              disabled={isSavingNewSpec || !newSpecTitle.trim() || !newSpecContent.trim()}
              onPress={onSubmitNewSpec}
            />
          </View>
        ) : selectedTicket && selectedCard ? (
          <TicketDetailPanel
            styles={styles}
            theme={theme}
            ticket={selectedTicket}
            selection={selectedCard}
            selectedRunId={activeProjectRun?.id ?? selectedRunId ?? null}
            onClose={() => onSelectCard(null)}
          />
        ) : (
          <View style={[styles.card, { backgroundColor: theme.colors.surface2, gap: 6 }]}>
            <Text style={[styles.bodyText, { fontWeight: "600" }]}>
              Inspector & Spec Sidebar
            </Text>
            <Text style={styles.mutedText}>
              Select any Spec, Brief, or Option card on the Kanban board to inspect or edit it here, or click "+ New Spec" to author a new Spec card.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
