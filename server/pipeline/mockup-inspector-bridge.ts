// Inspector + Design-mode image/Canvas-sprite picker + dynamic asset fallback bridge injected into mockup previews.
import type { PreindexedMockupAssets } from "./mockup-asset-resolver";
import { buildMockupCanvasSpriteBridgeSnippet } from "./mockup-canvas-sprite-bridge";

// Build the inspector + Design-mode image/Canvas sprite picker + dynamic asset fallback bridge injected into the mockup HTML.
export function buildMockupInspectorBridgeScript(
  preindexedAssets: PreindexedMockupAssets,
): string {
  // Serialize the pre-indexed mockup images safely so dynamic JS `img.src = "assets/" + name` resolves inside srcDoc.
  const serializeForScript = (jsonValue: unknown): string =>
    JSON.stringify(jsonValue).replace(/<\/script/gi, "<\\/script");
  const serializedAssetUris = serializeForScript(preindexedAssets.assetUris);
  const serializedAssetIndexByKey = serializeForScript(preindexedAssets.assetIndexByKey);
  const canvasSpriteBridgeSnippet = buildMockupCanvasSpriteBridgeSnippet();

  return `<script data-slp-mockup-inspector="true">
(function () {
  var inspectMode = "run";
  var inspectEnabled = false;
  var hoveredElement = null;
  var selectedElements = [];
  // Highlight styles: thick enough to read on busy mockups, and the selection is heavier than the hover preview.
  var HOVER_OUTLINE = "3px dashed #06b6d4";
  var DESIGN_HOVER_OUTLINE = "3px dashed #ec4899";
  var SELECTED_OUTLINE = "4px solid #f59e0b";
  var OUTLINE_OFFSET = "2px";
  // Below this many pixels of pointer travel a press is a plain click, not the start of a drag-select.
  var DRAG_THRESHOLD_PX = 5;
  // Tolerance so a region drawn along an element's edge still counts as containing it.
  var CONTAIN_TOLERANCE_PX = 3;
  var NON_PICKABLE_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, BR: 1 };
  var dragStartPoint = null;
  var dragRegionEl = null;
  var dragMoved = false;
  var mockupAssetUris = ${serializedAssetUris};
  var mockupAssetIndexByKey = ${serializedAssetIndexByKey};
  var reverseAssetPathByUri = {};
  window.__slpMockupAssetPathsByUri = reverseAssetPathByUri;

  // Build reverse URI -> relative file path lookup at runtime from the slot index without duplicating base64 strings.
  var indexKeys = Object.keys(mockupAssetIndexByKey);
  for (var keyIdx = 0; keyIdx < indexKeys.length; keyIdx++) {
    var pathKey = indexKeys[keyIdx];
    var uriSlot = mockupAssetIndexByKey[pathKey];
    var slotDataUri = mockupAssetUris[uriSlot];
    if (slotDataUri && pathKey.indexOf("./") !== 0 && (!reverseAssetPathByUri[slotDataUri] || pathKey.indexOf("/") !== -1)) {
      reverseAssetPathByUri[slotDataUri] = pathKey;
    }
  }

  // Own-property check so a path such as "constructor" never resolves to an inherited object member.
  function lookupIndexedAssetUri(assetKey) {
    if (!Object.prototype.hasOwnProperty.call(mockupAssetIndexByKey, assetKey)) return null;
    return mockupAssetUris[mockupAssetIndexByKey[assetKey]] || null;
  }

  function lookupMockupAssetDataUri(rawAssetPath) {
    if (!rawAssetPath || typeof rawAssetPath !== "string") return null;
    var trimmedPath = rawAssetPath.trim();
    if (!trimmedPath || /^(?:https?:|data:|blob:|\\/\\/)/i.test(trimmedPath)) return null;
    var cleanPath = (trimmedPath.split(/[?#]/)[0] || trimmedPath).replace(/\\\\/g, "/");
    var exactUri = lookupIndexedAssetUri(cleanPath);
    if (exactUri) return exactUri;
    var normalizedRelative = cleanPath.replace(/^(?:\\.\\/|\\/|\\.\\.\\/)*/, "");
    var relativeUri = lookupIndexedAssetUri(normalizedRelative);
    if (relativeUri) return relativeUri;
    var fileBasename = normalizedRelative.split("/").pop();
    return fileBasename ? lookupIndexedAssetUri(fileBasename) : null;
  }

  function buildElementSelector(targetEl) {
    if (!targetEl || targetEl.nodeType !== 1) return "body";
    if (targetEl.id) return targetEl.tagName.toLowerCase() + "#" + targetEl.id;
    var pathSegments = [];
    var currentEl = targetEl;
    while (currentEl && currentEl.nodeType === 1 && currentEl.tagName.toLowerCase() !== "html") {
      var segment = currentEl.tagName.toLowerCase();
      if (currentEl.id) {
        segment += "#" + currentEl.id;
        pathSegments.unshift(segment);
        break;
      }
      var classList = Array.from(currentEl.classList || []).filter(Boolean).slice(0, 2);
      if (classList.length > 0) {
        segment += "." + classList.join(".");
      }
      var parentEl = currentEl.parentElement;
      if (parentEl) {
        var sameTagSiblings = Array.from(parentEl.children).filter(function (sib) {
          return sib.tagName === currentEl.tagName;
        });
        if (sameTagSiblings.length > 1) {
          var nthIndex = sameTagSiblings.indexOf(currentEl) + 1;
          segment += ":nth-of-type(" + nthIndex + ")";
        }
      }
      pathSegments.unshift(segment);
      currentEl = parentEl;
      if (pathSegments.length >= 4) break;
    }
    return pathSegments.join(" > ") || "body";
  }

  function extractElementSnippet(targetEl) {
    if (!targetEl) return "";
    var rawText = (targetEl.innerText || targetEl.textContent || targetEl.getAttribute("placeholder") || targetEl.getAttribute("aria-label") || targetEl.value || "").trim().replace(/\\s+/g, " ");
    return rawText.slice(0, 80);
  }

  ${canvasSpriteBridgeSnippet}

  function rewriteDynamicElementAssetAttributes(rootNode) {
    if (!rootNode || !rootNode.querySelectorAll) return;
    var mediaNodes = rootNode.querySelectorAll("img[src], source[src], video[src], video[poster], image[href], use[href]");
    for (var idx = 0; idx < mediaNodes.length; idx++) {
      var mediaEl = mediaNodes[idx];
      var attrNames = ["src", "poster", "href"];
      for (var attrIdx = 0; attrIdx < attrNames.length; attrIdx++) {
        var attrName = attrNames[attrIdx];
        var rawVal = mediaEl.getAttribute(attrName);
        var resolvedUri = lookupMockupAssetDataUri(rawVal);
        if (resolvedUri && rawVal !== resolvedUri) {
          if (!mediaEl.getAttribute("data-slp-asset-path") && rawVal && !/^data:/i.test(rawVal)) {
            mediaEl.setAttribute("data-slp-asset-path", rawVal.replace(/^(?:\\.\\/)*/, ""));
          }
          mediaEl.setAttribute(attrName, resolvedUri);
        }
      }
    }
  }

  window.addEventListener("error", function (errorEvent) {
    var brokenTarget = errorEvent && errorEvent.target;
    if (!brokenTarget || brokenTarget.nodeType !== 1) return;
    var rawSrcAttr = brokenTarget.getAttribute && (brokenTarget.getAttribute("src") || brokenTarget.getAttribute("href"));
    var fallbackUri = lookupMockupAssetDataUri(rawSrcAttr);
    if (fallbackUri) {
      if (rawSrcAttr && !brokenTarget.getAttribute("data-slp-asset-path") && !/^data:/i.test(rawSrcAttr)) {
        brokenTarget.setAttribute("data-slp-asset-path", rawSrcAttr.replace(/^(?:\\.\\/)*/, ""));
      }
      if (brokenTarget.hasAttribute("src")) brokenTarget.setAttribute("src", fallbackUri);
      else if (brokenTarget.hasAttribute("href")) brokenTarget.setAttribute("href", fallbackUri);
    }
  }, true);

  function installDomAssetObserver() {
    if (typeof MutationObserver === "undefined" || !document.documentElement) return;
    var domObserver = new MutationObserver(function () {
      rewriteDynamicElementAssetAttributes(document);
    });
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "poster", "href"]
    });
    rewriteDynamicElementAssetAttributes(document);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installDomAssetObserver);
  } else {
    installDomAssetObserver();
  }

  // The mockup's own outline is remembered once per element so leaving inspect mode restores it exactly.
  function setOutline(targetEl, outlineValue) {
    if (targetEl.__slpPrevOutline === undefined) {
      targetEl.__slpPrevOutline = targetEl.style.outline;
      targetEl.__slpPrevOutlineOffset = targetEl.style.outlineOffset;
    }
    targetEl.style.outline = outlineValue;
    targetEl.style.outlineOffset = OUTLINE_OFFSET;
  }

  function restoreOutline(targetEl) {
    if (targetEl.__slpPrevOutline === undefined) return;
    targetEl.style.outline = targetEl.__slpPrevOutline;
    targetEl.style.outlineOffset = targetEl.__slpPrevOutlineOffset;
    delete targetEl.__slpPrevOutline;
    delete targetEl.__slpPrevOutlineOffset;
  }

  function clearHoverOutline() {
    if (hoveredElement && selectedElements.indexOf(hoveredElement) === -1) {
      restoreOutline(hoveredElement);
    }
    hoveredElement = null;
  }

  function clearSelectedOutline() {
    selectedElements.forEach(restoreOutline);
    selectedElements = [];
  }

  function selectElements(targetEls) {
    clearHoverOutline();
    clearSelectedOutline();
    selectedElements = targetEls;
    selectedElements.forEach(function (selectedEl) {
      setOutline(selectedEl, SELECTED_OUTLINE);
    });
  }

  function isPickableElement(candidateEl) {
    if (NON_PICKABLE_TAGS[candidateEl.tagName]) return false;
    var candidateBox = candidateEl.getBoundingClientRect();
    return candidateBox.width > 0 && candidateBox.height > 0;
  }

  function pickElementsInRegion(regionLeft, regionTop, regionRight, regionBottom) {
    var fullyContainedEls = Array.from(document.body.querySelectorAll("*")).filter(function (candidateEl) {
      if (!isPickableElement(candidateEl)) return false;
      var candidateBox = candidateEl.getBoundingClientRect();
      return candidateBox.left >= regionLeft - CONTAIN_TOLERANCE_PX
        && candidateBox.top >= regionTop - CONTAIN_TOLERANCE_PX
        && candidateBox.right <= regionRight + CONTAIN_TOLERANCE_PX
        && candidateBox.bottom <= regionBottom + CONTAIN_TOLERANCE_PX;
    });
    var outermostEls = [];
    fullyContainedEls.forEach(function (containedEl) {
      var lastKeptEl = outermostEls[outermostEls.length - 1];
      if (lastKeptEl && lastKeptEl.contains(containedEl)) return;
      outermostEls.push(containedEl);
    });
    return outermostEls;
  }

  function drawDragRegion(pointerX, pointerY) {
    if (!dragRegionEl) {
      dragRegionEl = document.createElement("div");
      dragRegionEl.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px dashed #f59e0b;background:rgba(245,158,11,0.14);";
      document.body.appendChild(dragRegionEl);
    }
    dragRegionEl.style.left = Math.min(dragStartPoint.x, pointerX) + "px";
    dragRegionEl.style.top = Math.min(dragStartPoint.y, pointerY) + "px";
    dragRegionEl.style.width = Math.abs(pointerX - dragStartPoint.x) + "px";
    dragRegionEl.style.height = Math.abs(pointerY - dragStartPoint.y) + "px";
  }

  function endDrag() {
    if (dragRegionEl) dragRegionEl.remove();
    dragRegionEl = null;
    dragStartPoint = null;
    dragMoved = false;
  }

  document.addEventListener("mousedown", function (downEvent) {
    if (!inspectEnabled || downEvent.button !== 0) return;
    downEvent.preventDefault();
    downEvent.stopPropagation();
    downEvent.stopImmediatePropagation();
    clearHoverOutline();
    dragStartPoint = { x: downEvent.clientX, y: downEvent.clientY };
    dragMoved = false;
  }, true);

  document.addEventListener("mousemove", function (mouseEvent) {
    if (!inspectEnabled) return;
    if (dragStartPoint) {
      if (mouseEvent.buttons === 0) {
        endDrag();
        return;
      }
      var travelledPx = Math.max(Math.abs(mouseEvent.clientX - dragStartPoint.x), Math.abs(mouseEvent.clientY - dragStartPoint.y));
      if (dragMoved || travelledPx >= DRAG_THRESHOLD_PX) {
        dragMoved = true;
        drawDragRegion(mouseEvent.clientX, mouseEvent.clientY);
      }
      return;
    }
    var rawTarget = mouseEvent.target;
    if (!rawTarget || rawTarget === document.body || rawTarget === document.documentElement) return;
    var candidateEl = rawTarget;
    if (inspectMode === "design") {
      var designHoverMeta = resolveDesignImageTargetAtPoint(mouseEvent.clientX, mouseEvent.clientY, rawTarget);
      if (!designHoverMeta) {
        clearHoverOutline();
        return;
      }
      candidateEl = designHoverMeta.element;
    }
    if (candidateEl === hoveredElement) return;
    clearHoverOutline();
    hoveredElement = candidateEl;
    if (selectedElements.indexOf(hoveredElement) === -1) {
      setOutline(hoveredElement, inspectMode === "design" ? DESIGN_HOVER_OUTLINE : HOVER_OUTLINE);
    }
  }, true);

  document.addEventListener("mouseup", function (upEvent) {
    if (!inspectEnabled || !dragStartPoint) return;
    upEvent.preventDefault();
    upEvent.stopPropagation();
    upEvent.stopImmediatePropagation();
    var regionLeft = Math.min(dragStartPoint.x, upEvent.clientX);
    var regionTop = Math.min(dragStartPoint.y, upEvent.clientY);
    var regionRight = Math.max(dragStartPoint.x, upEvent.clientX);
    var regionBottom = Math.max(dragStartPoint.y, upEvent.clientY);
    var wasDrag = dragMoved;
    endDrag();

    if (inspectMode === "design" && !wasDrag) {
      var designTarget = resolveDesignImageTargetAtPoint(upEvent.clientX, upEvent.clientY, upEvent.target);
      if (designTarget) {
        selectElements([designTarget.element]);
        window.parent.postMessage({
          type: "slp-mockup-elements-picked",
          elements: [{
            selector: designTarget.selector,
            tagName: designTarget.tagName,
            elementText: designTarget.elementText,
            assetPath: designTarget.assetPath,
            imagePreviewUri: designTarget.imagePreviewUri,
            imageDimensions: designTarget.imageDimensions
          }]
        }, "*");
        return;
      }
    }

    var pickedEls = wasDrag
      ? pickElementsInRegion(regionLeft, regionTop, regionRight, regionBottom)
      : (upEvent.target && upEvent.target.nodeType === 1 ? [upEvent.target] : []);
    if (pickedEls.length === 0) return;
    selectElements(pickedEls);
    window.parent.postMessage({
      type: "slp-mockup-elements-picked",
      elements: pickedEls.map(function (pickedEl) {
        var imageMeta = extractElementImageMetadata(pickedEl, upEvent.clientX, upEvent.clientY);
        return {
          selector: imageMeta ? imageMeta.selector : buildElementSelector(pickedEl),
          tagName: imageMeta ? imageMeta.tagName : pickedEl.tagName.toLowerCase(),
          elementText: imageMeta ? imageMeta.elementText : extractElementSnippet(pickedEl),
          assetPath: imageMeta ? imageMeta.assetPath : undefined,
          imagePreviewUri: imageMeta ? imageMeta.imagePreviewUri : undefined,
          imageDimensions: imageMeta ? imageMeta.imageDimensions : undefined
        };
      })
    }, "*");
  }, true);

  document.addEventListener("click", function (clickEvent) {
    if (!inspectEnabled) return;
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    clickEvent.stopImmediatePropagation();
  }, true);

  window.addEventListener("message", function (msgEvent) {
    var payload = msgEvent && msgEvent.data;
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "slp-mockup-set-inspect-mode") {
      inspectMode = typeof payload.mode === "string" ? payload.mode : (payload.enabled ? "html" : "run");
      inspectEnabled = inspectMode === "html" || inspectMode === "design" || Boolean(payload.enabled);
      if (document.body) document.body.style.cursor = inspectEnabled ? "crosshair" : "";
      if (!inspectEnabled) {
        endDrag();
        clearHoverOutline();
        clearSelectedOutline();
      } else if (inspectMode === "design") {
        broadcastVisibleScreenImages();
      }
    } else if (payload.type === "slp-mockup-scan-images") {
      broadcastVisibleScreenImages();
    } else if (payload.type === "slp-mockup-highlight-selectors" && Array.isArray(payload.selectors)) {
      var foundEls = payload.selectors.map(function (targetSelector) {
        var cleanSelector = String(targetSelector || "").replace(/\\s*\\[sprite:.*\\]$/, "");
        try { return document.querySelector(cleanSelector); } catch (_err) { return null; }
      }).filter(Boolean);
      if (foundEls.length > 0) {
        selectElements(foundEls);
        foundEls[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  });
})();
</script>`;
}
