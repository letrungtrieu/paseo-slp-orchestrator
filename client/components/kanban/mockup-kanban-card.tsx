// Compact Kanban card for Column 1 (MOCKUP); clicking selects the card to show its file and review actions in the Sidebar.
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { BoardTicket } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { resolveSpecColorIdentity } from "./kanban-palette";

export interface MockupKanbanCardProps {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  isSelected: boolean;
  onSelect: () => void;
}

// Renders a compact Mockup card with concise 1-2 word status tags; review actions live in the Sidebar inspector.
export function MockupKanbanCard({
  styles,
  theme,
  ticket,
  isSelected,
  onSelect,
}: MockupKanbanCardProps) {
  const specColor = resolveSpecColorIdentity(ticket);
  const openNoteCount = ticket.mockup?.elementComments.length ?? 0;
  const isApproved = ticket.mockup?.status === "approved";

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Inspect Mockup for ${ticket.ticketKey} ${ticket.title}`}
      style={[
        styles.card,
        {
          padding: 10,
          gap: 6,
          backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
          borderWidth: isSelected ? 2 : 1,
          borderLeftWidth: 5,
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
        },
      ]}
    >
      {/* Compact top bar with Mockup lineage pill and short 1-2 word status tags */}
      <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 5,
            borderWidth: 1,
            borderColor: specColor.borderColor,
            backgroundColor: specColor.badgeBackground,
          }}
        >
          <Text style={{ fontSize: 10, fontWeight: "700", color: specColor.badgeTextColor }}>
            MOCKUP · {ticket.ticketKey}
          </Text>
        </View>

        <View style={[styles.row, { gap: 6 }]}>
          {openNoteCount > 0 ? (
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.accent }}>
              {openNoteCount} {openNoteCount === 1 ? "note" : "notes"}
            </Text>
          ) : null}
          <Text
            style={{
              fontSize: 11,
              fontWeight: "700",
              color: isApproved ? theme.colors.statusSuccess : theme.colors.statusWarning,
            }}
          >
            {isApproved ? "Approved" : "Draft"}
          </Text>
        </View>
      </View>

      <Text style={[styles.bodyText, { fontWeight: "700" }]} numberOfLines={2}>
        {ticket.title}
      </Text>
    </Pressable>
  );
}
