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
  bundledHtml: string;
  title: string;
  reloadNonce: number;
  maxWidthPx: number | null;
  inspectModeEnabled: boolean;
  highlightedSelector: string | null;
  onElementPicked: (pickedElement: PickedMockupHtmlElement) => void;
}) {
  const iframeElementRef = useRef<WebIframeElement | null>(null);
  const elementPickedCallbackRef = useRef(props.onElementPicked);
  elementPickedCallbackRef.current = props.onElementPicked;

  // Listen for postMessage events emitted when the human clicks an HTML tag in "Pick Element to Comment" mode.
  useEffect(() => {
    const webHost = globalThis as unknown as WebGlobalMessageHost;
    if (!webHost.addEventListener) return;

    const handleIframeMessage = (messageEvent: WebWindowMessageEvent) => {
      const payload = messageEvent.data as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "slp-mockup-element-picked") return;
      const selector = typeof payload.selector === "string" ? payload.selector : "body";
      const tagName = typeof payload.tagName === "string" ? payload.tagName : "div";
      const elementText = typeof payload.elementText === "string" ? payload.elementText : "";
      elementPickedCallbackRef.current({ selector, tagName, elementText });
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
  }, [props.inspectModeEnabled, props.reloadNonce, props.bundledHtml]);

  // Scroll to and outline a specific HTML element inside the mockup when the user clicks an existing comment.
  useEffect(() => {
    if (!props.highlightedSelector) return;
    iframeElementRef.current?.contentWindow?.postMessage(
      {
        type: "slp-mockup-highlight-selector",
        selector: props.highlightedSelector,
      },
      "*",
    );
  }, [props.highlightedSelector]);

  // Use React.createElement("iframe") with allow-scripts so HTML+CSS+JS mockups execute interactively inside Paseo Desktop.
  return React.createElement("iframe", {
    key: `slp-mockup-iframe-${props.reloadNonce}`,
    ref: (mountedNode: WebIframeElement | null) => {
      iframeElementRef.current = mountedNode;
    },
    srcDoc: props.bundledHtml,
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
  bundledHtml: string;
  title: string;
  reloadNonce: number;
  maxWidthPx: number | null;
  inspectModeEnabled: boolean;
  highlightedSelector: string | null;
  onElementPicked: (pickedElement: PickedMockupHtmlElement) => void;
}): React.ReactNode {
  if (Platform.OS !== "web") {
    return null;
  }
  return React.createElement(InteractiveMockupIframeHost, props);
}
