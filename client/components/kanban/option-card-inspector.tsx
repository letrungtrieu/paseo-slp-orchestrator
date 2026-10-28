// Shared lineage tag badge and single-Option inspector panel for a selected Kanban Option card.
import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { BoardTicket, BriefItem } from "../../../shared/board";
import type { UiStyles } from "../../styles";
import { ActionButton } from "../action-button";
import { resolveSpecColorIdentity } from "./kanban-palette";

// Renders a lineage badge pill at the top of an inspector panel so the user always sees Spec -> Brief -> Option links.
export function InspectorTagBadge({
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
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "700", color: textColor }}>{label}</Text>
    </View>
  );
}

// Inspector rendered ONLY when the user clicks a single Option card (C1, C2, ...) in BRIEF / SCORE / REWORK / DONE.
export function OptionCardInspector({
  styles,
  theme,
  ticket,
  optionBullet,
  onClose,
}: {
  styles: UiStyles;
  theme: PluginTheme;
  ticket: BoardTicket;
  optionBullet: BriefItem;
  onClose: () => void;
}) {
  const specColor = resolveSpecColorIdentity(ticket);
  // Color-code the status badge so passing options are green, failing/rework options are red, and blocked options are amber.
  const statusColor =
    optionBullet.status === "pass"
      ? theme.colors.statusSuccess
      : optionBullet.status === "fail" || optionBullet.status === "rework"
        ? theme.colors.statusDanger
        : optionBullet.status === "blocked"
          ? theme.colors.statusWarning
          : theme.colors.accent;

  return (
    <View
      style={[
        styles.card,
        {
          borderWidth: 2,
          borderLeftWidth: 6,
          // Match the parent Spec and Brief border color so the selected Option inspector visually belongs to its Spec family.
          borderColor: specColor.borderColor,
          borderLeftColor: specColor.borderColor,
          gap: 10,
        },
      ]}
    >
      {/* Header shows the full tag chain: SPEC -> BRIEF -> OPTION and its current status. */}
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <View style={styles.row}>
          <InspectorTagBadge
            label={`SPEC · ${ticket.ticketKey}`}
            borderColor={specColor.borderColor}
            backgroundColor={specColor.badgeBackground}
            textColor={specColor.badgeTextColor}
          />
          <InspectorTagBadge
            label={`BRIEF · ${specColor.briefTagCode} (v${optionBullet.briefRev})`}
            borderColor={specColor.borderColor}
            backgroundColor={theme.colors.surface2}
            textColor={theme.colors.foregroundMuted}
          />
          <InspectorTagBadge
            label={`OPTION · ${optionBullet.id}`}
            borderColor={specColor.borderColor}
            backgroundColor={theme.colors.surface2}
            textColor={theme.colors.foreground}
          />
          <Text style={{ color: statusColor, fontWeight: "700", fontSize: 13 }}>
            {optionBullet.status.toUpperCase()}
          </Text>
        </View>
        <ActionButton
          styles={styles}
          label="Close"
          accessibilityLabel={`Close Option inspector for ${optionBullet.id}`}
          onPress={onClose}
        />
      </View>

      <View style={{ gap: 4 }}>
        <Text style={styles.fieldLabel}>Option Requirement</Text>
        <Text style={styles.bodyText}>{optionBullet.requirement}</Text>
      </View>

      {optionBullet.verification ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Verification Method</Text>
          <Text style={styles.monoText}>{optionBullet.verification}</Text>
        </View>
      ) : null}

      {optionBullet.implementationNote ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Developer Implementation Note</Text>
          <Text style={styles.bodyText}>{optionBullet.implementationNote}</Text>
        </View>
      ) : null}

      {/* QA Scorecard verdict and evidence for this specific Option card. */}
      {optionBullet.score ? (
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.colors.surface2,
              borderLeftWidth: 4,
              borderLeftColor: statusColor,
              gap: 4,
            },
          ]}
        >
          <Text style={{ fontWeight: "700", color: statusColor }}>
            QA Score: {optionBullet.score.status.toUpperCase()}
            {optionBullet.score.gradedBy ? ` (by ${optionBullet.score.gradedBy})` : ""}
          </Text>
          <Text style={styles.bodyText}>{optionBullet.score.reason}</Text>
          {optionBullet.score.evidence ? (
            <Text style={styles.monoText}>Evidence: {optionBullet.score.evidence}</Text>
          ) : null}
        </View>
      ) : (
        <Text style={styles.mutedText}>Not yet graded by QA.</Text>
      )}

      {optionBullet.reworkNote ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Rework Feedback</Text>
          <Text style={styles.dangerText}>{optionBullet.reworkNote}</Text>
        </View>
      ) : null}
    </View>
  );
}
