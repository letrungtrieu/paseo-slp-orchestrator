// Distinct Kanban card components for Spec cards, Brief overview cards, and individual gradable Option cards.
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { BoardTicket, BriefItem } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { partitionTicketBriefItems, resolveSpecColorIdentity } from "./kanban-palette";

// Renders a compact colored tag pill linking a card to its Spec, Brief, or Option identifier.
function LineageTagPill({
  label,
  borderColor,
  backgroundColor,
  textColor,
}: {
  label: string;
  borderColor: string;
  backgroundColor: string;
  textColor: string;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor,
        backgroundColor,
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Text style={{ fontSize: 10, fontWeight: "700", color: textColor }}>{label}</Text>
    </View>
  );
}

// Maps an Option item's execution or QA status to a semantic badge color.
function resolveOptionStatusColor(theme: PluginTheme, optionStatus: BriefItem["status"]): string {
  // Pass is green, fail/rework is red, blocked is amber, and in-progress/implemented is accent blue.
  if (optionStatus === "pass") return theme.colors.statusSuccess;
  if (optionStatus === "fail" || optionStatus === "rework") return theme.colors.statusDanger;
  if (optionStatus === "blocked") return theme.colors.statusWarning;
  if (optionStatus === "implemented" || optionStatus === "in_progress") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

// Card rendered in Column 2 (SPEC) representing the overall Product Spec handed from Supervisor to Lead.
export function SpecKanbanCard({
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
  const specColor = resolveSpecColorIdentity(ticket);
  const { gradableOptions } = partitionTicketBriefItems(ticket);
  const passedOptionCount = gradableOptions.filter((optionBullet) => optionBullet.status === "pass").length;
  // Flag when the Spec was edited after the Lead's latest Brief so the human sees that a Brief update is pending.
  const isBriefOutdated =
    ticket.currentBriefRev > 0 && ticket.lastSyncedSpecRev < ticket.currentSpecRev;

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Inspect Spec ${ticket.ticketKey} ${ticket.title}`}
      style={[
        styles.card,
        {
          padding: 10,
          gap: 6,
          borderWidth: isSelected ? 2 : 1,
          borderLeftWidth: 5,
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
        },
      ]}
    >
      {/* Lineage tag row identifying this card as a root Spec document with concise 1-2 word status tags. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <LineageTagPill
          label={`SPEC · ${ticket.ticketKey}`}
          borderColor={specColor.borderColor}
          backgroundColor={specColor.badgeBackground}
          textColor={specColor.badgeTextColor}
        />
        <View style={[styles.row, { gap: 6 }]}>
          {ticket.mockup ? (
            <Text style={styles.mutedText}>
              Mockup {ticket.mockup.status === "approved" ? "approved" : "draft"}
            </Text>
          ) : null}
          {ticket.currentBriefRev > 0 ? (
            <Text style={styles.mutedText}>
              Brief {passedOptionCount}/{gradableOptions.length}
            </Text>
          ) : null}
          {isBriefOutdated ? <Text style={styles.warningText}>Outdated</Text> : null}
          <Text style={styles.mutedText}>v{ticket.currentSpecRev}</Text>
        </View>
      </View>

      <Text style={[styles.bodyText, { fontWeight: "700" }]} numberOfLines={3}>
        {ticket.title}
      </Text>
    </Pressable>
  );
}

// Card rendered in Column 2 (BRIEF) representing the Lead's decomposed technical Brief for a parent Spec.
export function BriefKanbanCard({
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
  const specColor = resolveSpecColorIdentity(ticket);
  const { gradableOptions, outOfScopeNotes } = partitionTicketBriefItems(ticket);
  const pausedAgentCount = ticket.activeAgents.filter((agentEntry) => Boolean(agentEntry.pausedAt)).length;

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Inspect Brief ${specColor.briefTagCode} for Spec ${ticket.ticketKey}`}
      style={[
        styles.card,
        {
          padding: 10,
          gap: 6,
          borderWidth: isSelected ? 2 : 1,
          borderLeftWidth: 5,
          // Share the exact same border color as the parent Spec card so their relationship is obvious at a glance.
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
        },
      ]}
    >
      {/* Tags explicitly link this Brief card to its parent Spec (e.g. SPEC · SLP-1 -> BRIEF · B-SLP-1). */}
      <View style={styles.row}>
        <LineageTagPill
          label={`SPEC · ${ticket.ticketKey}`}
          borderColor={specColor.borderColor}
          backgroundColor={specColor.badgeBackground}
          textColor={specColor.badgeTextColor}
        />
        <LineageTagPill
          label={`BRIEF · ${specColor.briefTagCode} v${ticket.currentBriefRev}`}
          borderColor={specColor.borderColor}
          backgroundColor={theme.colors.surface2}
          textColor={theme.colors.foreground}
        />
      </View>

      <Text style={[styles.bodyText, { fontWeight: "600" }]} numberOfLines={3}>
        {ticket.approach || ticket.title}
      </Text>

      <Text style={styles.mutedText}>
        {gradableOptions.length} gradable option{gradableOptions.length === 1 ? "" : "s"}
        {outOfScopeNotes.length > 0 ? ` · ${outOfScopeNotes.length} out-of-scope` : ""}
      </Text>

      {/* Show live agents working on this Brief and highlight when the Lead paused child peers. */}
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
                  : { borderColor: specColor.borderColor },
              ]}
            >
              <Text
                style={{
                  fontSize: 10,
                  color: activeAgent.pausedAt ? theme.colors.statusWarning : theme.colors.foreground,
                }}
              >
                {activeAgent.projectRole ?? activeAgent.role}
                {activeAgent.pausedAt ? " (PAUSED)" : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {pausedAgentCount > 0 ? (
        <Text style={styles.warningText}>
          {pausedAgentCount} peer{pausedAgentCount === 1 ? "" : "s"} paused by Lead
        </Text>
      ) : null}
    </Pressable>
  );
}

// Card rendered for a single gradable Option (C1, C2, ...) decomposed by the Lead from the Brief.
export function OptionKanbanCard({
  styles,
  theme,
  ticket,
  optionBullet,
  isSelected,
  onSelect,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  optionBullet: BriefItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const specColor = resolveSpecColorIdentity(ticket);
  const statusColor = resolveOptionStatusColor(theme, optionBullet.status);

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Inspect Option ${optionBullet.id} of Brief ${specColor.briefTagCode} (${ticket.ticketKey})`}
      style={[
        styles.card,
        {
          padding: 10,
          gap: 6,
          borderWidth: isSelected ? 2 : 1,
          borderLeftWidth: 5,
          // Keep the parent Spec/Brief border color on every Option card so cards from the same Spec group visually.
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
        },
      ]}
    >
      {/* Top tags show parent Spec, parent Brief, Option ID, and current status/score badge. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <View style={styles.row}>
          <LineageTagPill
            label={ticket.ticketKey}
            borderColor={specColor.borderColor}
            backgroundColor={specColor.badgeBackground}
            textColor={specColor.badgeTextColor}
          />
          <LineageTagPill
            label={specColor.briefTagCode}
            borderColor={specColor.borderColor}
            backgroundColor={theme.colors.surface2}
            textColor={theme.colors.foregroundMuted}
          />
          <LineageTagPill
            label={`OPT · ${optionBullet.id}`}
            borderColor={specColor.borderColor}
            backgroundColor={theme.colors.surface2}
            textColor={theme.colors.foreground}
          />
        </View>
        <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor }}>
          {optionBullet.status.toUpperCase()}
        </Text>
      </View>

      {/* Concise 3-line summary of this single option so the card stays compact and readable. */}
      <Text style={[styles.bodyText, { fontWeight: "500" }]} numberOfLines={3}>
        {optionBullet.requirement}
      </Text>

      {/* Show QA score reason or verification hint in one compact footer line. */}
      {optionBullet.score ? (
        <Text style={{ fontSize: 11, color: statusColor }} numberOfLines={2}>
          Score: {optionBullet.score.status.toUpperCase()} — {optionBullet.score.reason}
        </Text>
      ) : optionBullet.reworkNote ? (
        <Text style={[styles.dangerText, { fontSize: 11 }]} numberOfLines={2}>
          Rework: {optionBullet.reworkNote}
        </Text>
      ) : optionBullet.verification ? (
        <Text style={[styles.mutedText, { fontSize: 11 }]} numberOfLines={1}>
          Verify: {optionBullet.verification}
        </Text>
      ) : null}
    </Pressable>
  );
}
