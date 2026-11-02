// Interactive web image canvas stage and coordinate formatter/parser for Point Comment & Rectangle Markup mode.
import React, { useRef, useState } from "react";
import { Platform } from "react-native";

export type ImageMarkupToolMode = "point" | "rect";

export interface DesignImageAnnotationItem {
  id: string;
  kind: ImageMarkupToolMode;
  xPct: number;
  yPct: number;
  wPct?: number;
  hPct?: number;
  inkColor: string;
  comment: string;
}

export const MARKUP_INK_PALETTE: ReadonlyArray<{ color: string; label: string }> = [
  { color: "#ef4444", label: "Đỏ" },
  { color: "#f59e0b", label: "Cam" },
  { color: "#10b981", label: "Xanh lá" },
  { color: "#38bdf8", label: "Xanh dương" },
  { color: "#ec4899", label: "Hồng" },
  { color: "#a855f7", label: "Tím" },
];

// Why: clamp percentages to [0, 100] and format with a comma decimal separator ('40,1%') to match Vietnamese notation.
export function formatCoordinatePercentVi(rawPercent: number): string {
  const clampedPercent = Math.min(100, Math.max(0, Number.isFinite(rawPercent) ? rawPercent : 0));
  return `${clampedPercent.toFixed(1).replace(".", ",")}%`;
}

export function formatAnnotationCoordinateHeader(annotation: DesignImageAnnotationItem): string {
  if (annotation.kind === "rect") {
    return `(x:${formatCoordinatePercentVi(annotation.xPct)} y:${formatCoordinatePercentVi(annotation.yPct)} w:${formatCoordinatePercentVi(annotation.wPct ?? 10)} h:${formatCoordinatePercentVi(annotation.hPct ?? 10)})`;
  }
  return `(x:${formatCoordinatePercentVi(annotation.xPct)} y:${formatCoordinatePercentVi(annotation.yPct)})`;
}

// Why: serialize all numbered point/rectangle annotations into the exact '#1 (x:40,1% y:50,5%): ...' contract for the Design Agent.
export function formatImageAnnotationsToCommentText(
  annotations: readonly DesignImageAnnotationItem[],
  generalImageNote?: string,
): string {
  const formattedLines = annotations.map((item, idx) => {
    const cleanComment = item.comment.trim() || "Cần kiểm tra / chỉnh sửa vùng này";
    return `#${idx + 1} ${formatAnnotationCoordinateHeader(item)}: ${cleanComment}`;
  });
  const trimmedGeneral = generalImageNote?.trim() ?? "";
  if (trimmedGeneral) {
    formattedLines.push(trimmedGeneral);
  }
  return formattedLines.join("\n");
}

function parseLocalizedFloat(rawToken: string): number {
  const parsed = Number.parseFloat(rawToken.replace(",", "."));
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
}

// Why: rehydrate existing '#1 (x:... y:...)' and '#2 (x:... y:... w:... h:...)' lines back into interactive pins/rectangles when re-editing.
export function parseCommentTextToImageAnnotations(
  rawCommentText: string,
  defaultInkColor = "#ef4444",
): { annotations: DesignImageAnnotationItem[]; generalNote: string } {
  if (!rawCommentText.trim()) {
    return { annotations: [], generalNote: "" };
  }
  const lines = rawCommentText.split(/\r?\n/);
  const restoredAnnotations: DesignImageAnnotationItem[] = [];
  const leftoverGeneralLines: string[] = [];
  const annotationLineRegex =
    /^#(\d+)\s*\(\s*x\s*:\s*([\d.,]+)%?\s+y\s*:\s*([\d.,]+)%?(?:\s+w\s*:\s*([\d.,]+)%?\s+h\s*:\s*([\d.,]+)%?)?\s*\)\s*:\s*(.*)$/i;

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) continue;
    const match = trimmedLine.match(annotationLineRegex);
    if (!match) {
      leftoverGeneralLines.push(trimmedLine);
      continue;
    }
    const xPct = parseLocalizedFloat(match[2] ?? "0");
    const yPct = parseLocalizedFloat(match[3] ?? "0");
    const hasRectDimensions = Boolean(match[4] && match[5]);
    const wPct = hasRectDimensions ? parseLocalizedFloat(match[4] ?? "10") : undefined;
    const hPct = hasRectDimensions ? parseLocalizedFloat(match[5] ?? "10") : undefined;
    const paletteSlot =
      MARKUP_INK_PALETTE[restoredAnnotations.length % MARKUP_INK_PALETTE.length]?.color ??
      defaultInkColor;

    restoredAnnotations.push({
      id: `restored-ann-${Date.now()}-${restoredAnnotations.length}`,
      kind: hasRectDimensions ? "rect" : "point",
      xPct,
      yPct,
      ...(hasRectDimensions ? { wPct, hPct } : {}),
      inkColor: paletteSlot,
      comment: (match[6] ?? "").trim(),
    });
  }

  return {
    annotations: restoredAnnotations,
    generalNote: leftoverGeneralLines.join("\n"),
  };
}

interface DomPointerEvent {
  clientX: number;
  clientY: number;
  button?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

interface DomBoundingBoxElement {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

function InteractiveWebImageMarkupStage(props: {
  imageUri: string;
  altText: string;
  toolMode: ImageMarkupToolMode;
  activeInkColor: string;
  annotations: readonly DesignImageAnnotationItem[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (annotationId: string) => void;
  onCreateAnnotation: (newAnnotation: DesignImageAnnotationItem) => void;
}) {
  const stageOverlayRef = useRef<DomBoundingBoxElement | null>(null);
  const [dragOriginPct, setDragOriginPct] = useState<{ xPct: number; yPct: number } | null>(null);
  const [dragCurrentPct, setDragCurrentPct] = useState<{ xPct: number; yPct: number } | null>(null);

  // Why: convert pointer viewport coordinates into [0, 100] percentages relative to the exact rendered image box.
  const pointerToImagePercent = (pointerEvent: DomPointerEvent): { xPct: number; yPct: number } | null => {
    const surfaceNode = stageOverlayRef.current;
    if (!surfaceNode) return null;
    const rect = surfaceNode.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const xPct = Math.min(100, Math.max(0, ((pointerEvent.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.min(100, Math.max(0, ((pointerEvent.clientY - rect.top) / rect.height) * 100));
    return { xPct, yPct };
  };

  const handleStageMouseDown = (downEvent: DomPointerEvent) => {
    if (typeof downEvent.button === "number" && downEvent.button !== 0) return;
    downEvent.preventDefault();
    const pointPct = pointerToImagePercent(downEvent);
    if (!pointPct) return;

    if (props.toolMode === "point") {
      const createdPoint: DesignImageAnnotationItem = {
        id: `img-ann-${Date.now()}-${props.annotations.length + 1}`,
        kind: "point",
        xPct: pointPct.xPct,
        yPct: pointPct.yPct,
        inkColor: props.activeInkColor,
        comment: "",
      };
      props.onCreateAnnotation(createdPoint);
      return;
    }

    setDragOriginPct(pointPct);
    setDragCurrentPct(pointPct);
  };

  const handleStageMouseMove = (moveEvent: DomPointerEvent) => {
    if (!dragOriginPct) return;
    const pointPct = pointerToImagePercent(moveEvent);
    if (pointPct) {
      setDragCurrentPct(pointPct);
    }
  };

  const finalizeRectangleDrag = () => {
    if (!dragOriginPct || !dragCurrentPct) {
      setDragOriginPct(null);
      setDragCurrentPct(null);
      return;
    }
    const leftPct = Math.min(dragOriginPct.xPct, dragCurrentPct.xPct);
    const topPct = Math.min(dragOriginPct.yPct, dragCurrentPct.yPct);
    const widthPct = Math.abs(dragCurrentPct.xPct - dragOriginPct.xPct);
    const heightPct = Math.abs(dragCurrentPct.yPct - dragOriginPct.yPct);
    setDragOriginPct(null);
    setDragCurrentPct(null);

    // Why: if the user clicked without dragging in Markup mode, create a sensible 12%x12% selection box centered on the click.
    const finalWidthPct = widthPct < 1.2 ? 12 : widthPct;
    const finalHeightPct = heightPct < 1.2 ? 12 : heightPct;
    const finalLeftPct = widthPct < 1.2 ? Math.max(0, Math.min(100 - finalWidthPct, leftPct - finalWidthPct / 2)) : leftPct;
    const finalTopPct = heightPct < 1.2 ? Math.max(0, Math.min(100 - finalHeightPct, topPct - finalHeightPct / 2)) : topPct;

    const createdRect: DesignImageAnnotationItem = {
      id: `img-ann-${Date.now()}-${props.annotations.length + 1}`,
      kind: "rect",
      xPct: finalLeftPct,
      yPct: finalTopPct,
      wPct: finalWidthPct,
      hPct: finalHeightPct,
      inkColor: props.activeInkColor,
      comment: "",
    };
    props.onCreateAnnotation(createdRect);
  };

  const draftRectStyle =
    dragOriginPct && dragCurrentPct
      ? {
          left: `${Math.min(dragOriginPct.xPct, dragCurrentPct.xPct)}%`,
          top: `${Math.min(dragOriginPct.yPct, dragCurrentPct.yPct)}%`,
          width: `${Math.abs(dragCurrentPct.xPct - dragOriginPct.xPct)}%`,
          height: `${Math.abs(dragCurrentPct.yPct - dragOriginPct.yPct)}%`,
        }
      : null;

  return React.createElement(
    "div",
    {
      style: {
        display: "flex",
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#090d16",
        backgroundImage:
          "linear-gradient(45deg, #111827 25%, transparent 25%), linear-gradient(-45deg, #111827 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #111827 75%), linear-gradient(-45deg, transparent 75%, #111827 75%)",
        backgroundSize: "20px 20px",
        backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
        borderRadius: 10,
        border: "1px solid #334155",
        padding: 16,
        minHeight: 380,
        overflow: "auto",
        userSelect: "none",
      },
    },
    React.createElement(
      "div",
      {
        ref: (node: DomBoundingBoxElement | null) => {
          stageOverlayRef.current = node;
        },
        onMouseDown: handleStageMouseDown,
        onMouseMove: handleStageMouseMove,
        onMouseUp: finalizeRectangleDrag,
        style: {
          position: "relative",
          display: "inline-block",
          cursor: "crosshair",
          lineHeight: 0,
          boxShadow: "0 8px 28px rgba(0, 0, 0, 0.5)",
          borderRadius: 4,
        },
      },
      React.createElement("img", {
        src: props.imageUri,
        alt: props.altText,
        draggable: false,
        style: {
          display: "block",
          maxWidth: "600px",
          maxHeight: "460px",
          width: "auto",
          height: "auto",
          minWidth: "140px",
          minHeight: "90px",
          objectFit: "contain",
          pointerEvents: "none",
          userSelect: "none",
        },
      }),
      props.annotations.map((annotation, idx) => {
        const badgeNumber = idx + 1;
        const isSelected = annotation.id === props.selectedAnnotationId;
        if (annotation.kind === "rect") {
          return React.createElement(
            "div",
            {
              key: annotation.id,
              onMouseDown: (ev: DomPointerEvent) => {
                ev.stopPropagation();
                props.onSelectAnnotation(annotation.id);
              },
              style: {
                position: "absolute",
                left: `${annotation.xPct}%`,
                top: `${annotation.yPct}%`,
                width: `${annotation.wPct ?? 10}%`,
                height: `${annotation.hPct ?? 10}%`,
                border: `${isSelected ? 3 : 2}px solid ${annotation.inkColor}`,
                backgroundColor: `${annotation.inkColor}26`,
                boxShadow: isSelected ? `0 0 0 2px #ffffff, 0 4px 12px rgba(0,0,0,0.45)` : "0 2px 6px rgba(0,0,0,0.35)",
                borderRadius: 4,
                boxSizing: "border-box",
                cursor: "pointer",
              },
            },
            React.createElement(
              "span",
              {
                style: {
                  position: "absolute",
                  left: -2,
                  top: -22,
                  backgroundColor: annotation.inkColor,
                  color: "#ffffff",
                  fontSize: "11px",
                  fontWeight: 800,
                  fontFamily: "monospace",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  lineHeight: "14px",
                  whiteSpace: "nowrap",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.4)",
                },
              },
              `#${badgeNumber}`,
            ),
          );
        }

        return React.createElement(
          "div",
          {
            key: annotation.id,
            onMouseDown: (ev: DomPointerEvent) => {
              ev.stopPropagation();
              props.onSelectAnnotation(annotation.id);
            },
            style: {
              position: "absolute",
              left: `${annotation.xPct}%`,
              top: `${annotation.yPct}%`,
              transform: "translate(-50%, -50%)",
              width: isSelected ? 26 : 22,
              height: isSelected ? 26 : 22,
              borderRadius: "999px",
              backgroundColor: annotation.inkColor,
              border: isSelected ? "2.5px solid #ffffff" : "1.5px solid #0f172a",
              color: "#ffffff",
              fontSize: "11px",
              fontWeight: 800,
              fontFamily: "monospace",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 3px 10px rgba(0,0,0,0.55)",
              cursor: "pointer",
            },
          },
          `#${badgeNumber}`,
        );
      }),
      draftRectStyle
        ? React.createElement("div", {
            style: {
              position: "absolute",
              ...draftRectStyle,
              border: `2px dashed ${props.activeInkColor}`,
              backgroundColor: `${props.activeInkColor}33`,
              pointerEvents: "none",
              boxSizing: "border-box",
            },
          })
        : null,
    ),
  );
}

export function renderInteractiveImageMarkupStage(props: {
  imageUri: string;
  altText: string;
  toolMode: ImageMarkupToolMode;
  activeInkColor: string;
  annotations: readonly DesignImageAnnotationItem[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (annotationId: string) => void;
  onCreateAnnotation: (newAnnotation: DesignImageAnnotationItem) => void;
}): React.ReactNode {
  if (Platform.OS !== "web" || !props.imageUri) {
    return null;
  }
  return React.createElement(InteractiveWebImageMarkupStage, props);
}
