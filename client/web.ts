// Web-only iframe renderer and postMessage bridge for the interactive SLP HTML/CSS/JS Mockup Preview Studio.
import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";

export interface PickedMockupHtmlElement {
  selector: string;
  tagName: string;
  elementText: string;
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
  maxWidthPx: number | null;
  inspectModeEnabled: boolean;
  // Every selector of the comment being reviewed; a drag-select note has several.
  highlightedSelectors: string[] | null;
  onElementsPicked: (pickedElements: PickedMockupHtmlElement[]) => void;
}) {
  const iframeElementRef = useRef<WebIframeElement | null>(null);
  const elementsPickedCallbackRef = useRef(props.onElementsPicked);
  elementsPickedCallbackRef.current = props.onElementsPicked;

  // Listen for postMessage events emitted when the human clicks, or drag-selects, HTML tags in "Pick HTML" mode.
  useEffect(() => {
    const webHost = globalThis as unknown as WebGlobalMessageHost;
    if (!webHost.addEventListener) return;

    const handleIframeMessage = (messageEvent: WebWindowMessageEvent) => {
      const payload = messageEvent.data as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "slp-mockup-elements-picked" || !Array.isArray(payload.elements)) return;
      // The iframe is sandboxed but still foreign input, so every field is coerced rather than trusted.
      const pickedElements = payload.elements.map((rawElement: Record<string, unknown>) => ({
        selector: typeof rawElement.selector === "string" ? rawElement.selector : "body",
        tagName: typeof rawElement.tagName === "string" ? rawElement.tagName : "div",
        elementText: typeof rawElement.elementText === "string" ? rawElement.elementText : "",
      }));
      if (pickedElements.length > 0) elementsPickedCallbackRef.current(pickedElements);
    };

    webHost.addEventListener("message", handleIframeMessage);
    return () => {
      webHost.removeEventListener?.("message", handleIframeMessage);
    };
  }, []);

  // Synchronize "Pick Element to Comment" mode into the iframe whenever the user toggles the toolbar button.
  useEffect(() => {
    iframeElementRef.current?.contentWindow?.postMessage(
      {
        type: "slp-mockup-set-inspect-mode",
        enabled: props.inspectModeEnabled,
      },
      "*",
    );
  }, [props.inspectModeEnabled, props.reloadNonce, props.bundledHtml, props.previewUrl]);

  // Scroll to and outline the HTML elements of a comment when the user clicks an existing comment.
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
          enabled: props.inspectModeEnabled,
        },
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
  // Exactly one source is set: a loopback URL (normal) or a self-contained HTML string (remote-UI fallback).
  previewUrl: string | null;
  bundledHtml: string | null;
  title: string;
  reloadNonce: number;
  maxWidthPx: number | null;
  inspectModeEnabled: boolean;
  // Every selector of the comment being reviewed; a drag-select note has several.
  highlightedSelectors: string[] | null;
  onElementsPicked: (pickedElements: PickedMockupHtmlElement[]) => void;
}): React.ReactNode {
  if (Platform.OS !== "web") {
    return null;
  }
  return React.createElement(InteractiveMockupIframeHost, props);
}
