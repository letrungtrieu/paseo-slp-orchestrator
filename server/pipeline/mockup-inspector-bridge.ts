// Inspector + dynamic asset fallback bridge injected into every mockup preview so the Studio can pick HTML elements.
import type { PreindexedMockupAssets } from "./mockup-asset-resolver";

// Build the inspector + dynamic asset fallback bridge injected at the end of the bundled mockup HTML.
export function buildMockupInspectorBridgeScript(
  preindexedAssets: PreindexedMockupAssets,
): string {
  // Serialize the pre-indexed mockup images safely so dynamic JS `img.src = "assets/" + name` resolves inside srcDoc.
  const serializeForScript = (jsonValue: unknown): string =>
    JSON.stringify(jsonValue).replace(/<\/script/gi, "<\\/script");
  const serializedAssetUris = serializeForScript(preindexedAssets.assetUris);
  const serializedAssetIndexByKey = serializeForScript(preindexedAssets.assetIndexByKey);
  return `<script data-slp-mockup-inspector="true">
(function () {
  var inspectEnabled = false;
  var hoveredElement = null;
  var selectedElements = [];
  // Highlight styles: thick enough to read on busy mockups, and the selection is heavier than the hover preview.
  var HOVER_OUTLINE = "3px dashed #06b6d4";
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
      if (brokenTarget.hasAttribute("src")) brokenTarget.setAttribute("src", fallbackUri);
      else if (brokenTarget.hasAttribute("href")) brokenTarget.setAttribute("href", fallbackUri);
    }
  }, true);

  if (typeof MutationObserver !== "undefined") {
    var domObserver = new MutationObserver(function () {
      rewriteDynamicElementAssetAttributes(document);
    });
    if (document.documentElement) {
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "poster", "href"]
      });
    }
  }
  rewriteDynamicElementAssetAttributes(document);

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
    // A hovered element that is also selected keeps its heavier selection outline.
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

  function reportPickedElements(targetEls) {
    window.parent.postMessage({
      type: "slp-mockup-elements-picked",
      elements: targetEls.map(function (pickedEl) {
        return {
          selector: buildElementSelector(pickedEl),
          tagName: pickedEl.tagName.toLowerCase(),
          elementText: extractElementSnippet(pickedEl)
        };
      })
    }, "*");
  }

  // Zero-size and non-visual tags can never be seen inside a drawn region, so they are not candidates.
  function isPickableElement(candidateEl) {
    if (NON_PICKABLE_TAGS[candidateEl.tagName]) return false;
    var candidateBox = candidateEl.getBoundingClientRect();
    return candidateBox.width > 0 && candidateBox.height > 0;
  }

  // Only elements fully inside the region count, and a container stands for its children (parent-first).
  function pickElementsInRegion(regionLeft, regionTop, regionRight, regionBottom) {
    var fullyContainedEls = Array.from(document.body.querySelectorAll("*")).filter(function (candidateEl) {
      if (!isPickableElement(candidateEl)) return false;
      var candidateBox = candidateEl.getBoundingClientRect();
      return candidateBox.left >= regionLeft - CONTAIN_TOLERANCE_PX
        && candidateBox.top >= regionTop - CONTAIN_TOLERANCE_PX
        && candidateBox.right <= regionRight + CONTAIN_TOLERANCE_PX
        && candidateBox.bottom <= regionBottom + CONTAIN_TOLERANCE_PX;
    });
    // querySelectorAll is in document order, so a descendant always follows its ancestor: one pass drops the children.
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
      // pointer-events:none keeps the rubber band from becoming the event target of its own drag.
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

  // Press starts a possible drag; the mockup must not see it or text selection would start under the rubber band.
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
      // A release outside the iframe never reaches this document, so a button-less move cancels the stale drag.
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
    var candidateEl = mouseEvent.target;
    if (!candidateEl || candidateEl === hoveredElement || candidateEl === document.body || candidateEl === document.documentElement) return;
    clearHoverOutline();
    hoveredElement = candidateEl;
    if (selectedElements.indexOf(hoveredElement) === -1) {
      setOutline(hoveredElement, HOVER_OUTLINE);
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
    // The rubber band is removed before measuring so it can never be picked as an element itself.
    endDrag();
    // Without a drag the press is a plain click on the one element under the pointer.
    var pickedEls = wasDrag
      ? pickElementsInRegion(regionLeft, regionTop, regionRight, regionBottom)
      : (upEvent.target && upEvent.target.nodeType === 1 ? [upEvent.target] : []);
    // An empty region keeps the previous selection instead of silently clearing the human's work.
    if (pickedEls.length === 0) return;
    selectElements(pickedEls);
    reportPickedElements(pickedEls);
  }, true);

  // The mockup's own click handlers (links, buttons) must not fire while picking.
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
      inspectEnabled = Boolean(payload.enabled);
      document.body.style.cursor = inspectEnabled ? "crosshair" : "";
      if (!inspectEnabled) {
        endDrag();
        clearHoverOutline();
        clearSelectedOutline();
      }
    } else if (payload.type === "slp-mockup-highlight-selectors" && Array.isArray(payload.selectors)) {
      // One comment may target several elements, so the whole group is outlined and the first is scrolled into view.
      var foundEls = payload.selectors.map(function (targetSelector) {
        try { return document.querySelector(targetSelector); } catch (_err) { return null; }
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
