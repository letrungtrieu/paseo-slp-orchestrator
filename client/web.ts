// Web-only iframe renderer and postMessage bridge for the interactive SLP HTML/CSS/JS Mockup Preview Studio.
import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";

export type MockupInspectMode = "run" | "html" | "design";

export interface PickedMockupHtmlElement {
  selector: string;
  tagName: string;
  elementText: string;
  assetPath?: string;
  imagePreviewUri?: string;
  imageDimensions?: string;
}

export interface VisibleMockupScreenImage {
  selector: string;
  tagName: string;
  elementText: string;
  assetPath: string;
  imagePreviewUri: string;
  imageDimensions: string;
}

interface WebIframeElement {
  contentWindow?: {
    postMessage(payload: unknown, targetOrigin: string): void;
  } | null;
}

interface WebWindowMessageEvent {
  data?: unknown;
}

interface WebGlobalMessageHost {
  addEventListener?(
    eventType: string,
    listener: (event: WebWindowMessageEvent) => void,
  ): void;
  removeEventListener?(
    eventType: string,
    listener: (event: WebWindowMessageEvent) => void,
  ): void;
}

function InteractiveMockupIframeHost(props: {
  // Exactly one source is set: a loopback URL (normal) or a self-contained HTML string (remote-UI fallback).
  previewUrl: string | null;
  bundledHtml: string | null;
  title: string;
  reloadNonce: number;
  scanImagesNonce?: number;
  maxWidthPx: number | null;
  inspectMode: MockupInspectMode;
  // Every selector of the comment being reviewed; a drag-select note has several.
  highlightedSelectors: string[] | null;
  onElementsPicked: (pickedElements: PickedMockupHtmlElement[]) => void;
  onScreenImagesUpdated?: (visibleImages: VisibleMockupScreenImage[]) => void;
}) {
  const iframeElementRef = useRef<WebIframeElement | null>(null);
  const elementsPickedCallbackRef = useRef(props.onElementsPicked);
  elementsPickedCallbackRef.current = props.onElementsPicked;
  const screenImagesCallbackRef = useRef(props.onScreenImagesUpdated);
  screenImagesCallbackRef.current = props.onScreenImagesUpdated;

  // Listen for postMessage events emitted when the human clicks/drags HTML tags ("Pick HTML") or images/Canvas sprites ("Design").
  useEffect(() => {
    const webHost = globalThis as unknown as WebGlobalMessageHost;
    if (!webHost.addEventListener) return;

    const handleIframeMessage = (messageEvent: WebWindowMessageEvent) => {
      const payload = messageEvent.data as Record<string, unknown> | undefined;
      if (!payload) return;
      if (payload.type === "slp-mockup-elements-picked" && Array.isArray(payload.elements)) {
        // The iframe is sandboxed but still foreign input, so every field is coerced rather than trusted.
        const pickedElements: PickedMockupHtmlElement[] = payload.elements.map((rawElement: Record<string, unknown>) => ({
          selector: typeof rawElement.selector === "string" ? rawElement.selector : "body",
          tagName: typeof rawElement.tagName === "string" ? rawElement.tagName : "div",
          elementText: typeof rawElement.elementText === "string" ? rawElement.elementText : "",
          assetPath: typeof rawElement.assetPath === "string" && rawElement.assetPath.trim() ? rawElement.assetPath : undefined,
          imagePreviewUri:
            typeof rawElement.imagePreviewUri === "string" && rawElement.imagePreviewUri.trim()
              ? rawElement.imagePreviewUri
              : undefined,
          imageDimensions:
            typeof rawElement.imageDimensions === "string" && rawElement.imageDimensions.trim()
              ? rawElement.imageDimensions
              : undefined,
        }));
        if (pickedElements.length > 0) elementsPickedCallbackRef.current(pickedElements);
      } else if (payload.type === "slp-mockup-screen-images" && Array.isArray(payload.images)) {
        const parsedImages: VisibleMockupScreenImage[] = payload.images
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            selector: typeof item.selector === "string" ? item.selector : "img",
            tagName: typeof item.tagName === "string" ? item.tagName : "img",
            elementText: typeof item.elementText === "string" ? item.elementText : "",
            assetPath: typeof item.assetPath === "string" ? item.assetPath : "",
            imagePreviewUri: typeof item.imagePreviewUri === "string" ? item.imagePreviewUri : "",
            imageDimensions: typeof item.imageDimensions === "string" ? item.imageDimensions : "",
          }))
          .filter((item) => Boolean(item.imagePreviewUri));
        screenImagesCallbackRef.current?.(parsedImages);
      }
    };

    webHost.addEventListener("message", handleIframeMessage);
    return () => {
      webHost.removeEventListener?.("message", handleIframeMessage);
    };
  }, []);

  // Synchronize "Run UI" / "Pick HTML" / "Design" mode into the iframe whenever the user toggles the toolbar buttons.
  useEffect(() => {
    iframeElementRef.current?.contentWindow?.postMessage(
      {
        type: "slp-mockup-set-inspect-mode",
        mode: props.inspectMode,
        enabled: props.inspectMode !== "run",
      },
      "*",
    );
  }, [props.inspectMode, props.reloadNonce, props.bundledHtml, props.previewUrl]);

  // Scroll to and outline the HTML elements or <canvas> sprites of a comment when the user clicks an existing comment.
  useEffect(() => {
    if (!props.highlightedSelectors) return;
    iframeElementRef.current?.contentWindow?.postMessage(
      {
        type: "slp-mockup-highlight-selectors",
        selectors: props.highlightedSelectors,
      },
      "*",
    );
  }, [props.highlightedSelectors]);

  // Why: allow the Image Explorer sidepanel to re-scan live screen images/canvas sprites without reloading the iframe.
  useEffect(() => {
    if (!props.scanImagesNonce) return;
    iframeElementRef.current?.contentWindow?.postMessage(
      { type: "slp-mockup-scan-images" },
      "*",
    );
  }, [props.scanImagesNonce]);

  // Use React.createElement("iframe") with allow-scripts so HTML+CSS+JS mockups execute interactively inside Paseo Desktop.
  return React.createElement("iframe", {
    key: `slp-mockup-iframe-${props.reloadNonce}`,
    ref: (mountedNode: WebIframeElement | null) => {
      iframeElementRef.current = mountedNode;
    },
    ...(props.previewUrl ? { src: props.previewUrl } : { srcDoc: props.bundledHtml ?? "" }),
    title: props.title,
    sandbox: "allow-scripts allow-forms allow-modals allow-popups",
    onLoad: () => {
      iframeElementRef.current?.contentWindow?.postMessage(
        {
          type: "slp-mockup-set-inspect-mode",
          mode: props.inspectMode,
          enabled: props.inspectMode !== "run",
        },
        "*",
      );
      iframeElementRef.current?.contentWindow?.postMessage(
        { type: "slp-mockup-scan-images" },
        "*",
      );
    },
    style: {
      flex: 1,
      width: props.maxWidthPx ? `${props.maxWidthPx}px` : "100%",
      maxWidth: "100%",
      height: "100%",
      border: "none",
      borderRadius: 6,
      backgroundColor: "#ffffff",
      alignSelf: "center",
      boxShadow: "0 4px 20px rgba(0, 0, 0, 0.35)",
    },
  });
}

// Entry point called by MockupPreviewModal; returns null on non-web platforms where DOM iframes are unavailable.
export function renderMockupPreviewIframe(props: {
  previewUrl: string | null;
  bundledHtml: string | null;
  title: string;
  reloadNonce: number;
  scanImagesNonce?: number;
  maxWidthPx: number | null;
  inspectMode: MockupInspectMode;
  highlightedSelectors: string[] | null;
  onElementsPicked: (pickedElements: PickedMockupHtmlElement[]) => void;
  onScreenImagesUpdated?: (visibleImages: VisibleMockupScreenImage[]) => void;
}): React.ReactNode {
  if (Platform.OS !== "web") {
    return null;
  }
  return React.createElement(InteractiveMockupIframeHost, props);
}

// Renders a thumbnail preview of a selected or commented image/Canvas sprite in Design mode on Web.
export function renderInlineImagePreview(props: {
  imageUri: string;
  altText: string;
  maxHeightPx?: number;
  onDoubleClick?: () => void;
}): React.ReactNode {
  if (Platform.OS !== "web" || !props.imageUri) {
    return null;
  }
  return React.createElement("img", {
    src: props.imageUri,
    alt: props.altText,
    onDoubleClick: props.onDoubleClick,
    style: {
      width: "100%",
      maxHeight: `${props.maxHeightPx ?? 110}px`,
      objectFit: "contain",
      borderRadius: 6,
      backgroundColor: "#0f172a",
      border: "1px solid rgba(148, 163, 184, 0.25)",
      padding: 4,
    },
  });
}
