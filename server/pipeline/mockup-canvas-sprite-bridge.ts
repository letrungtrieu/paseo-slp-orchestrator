// Client-side JS snippet that hooks HTMLImageElement.prototype.src and CanvasRenderingContext2D.prototype.drawImage
// and extracts Design-mode image/SVG/background-image/Canvas-sprite metadata for direct Codex image editing.

// Build the inline JavaScript snippet injected inside the Mockup Inspector Bridge IIFE.
// Assumes `lookupMockupAssetDataUri`, `reverseAssetPathByUri`, `buildElementSelector`, and `extractElementSnippet` are in scope.
export function buildMockupCanvasSpriteBridgeSnippet(): string {
  return `
  // Recover the relative disk path inside '.slp/mockup/' ('assets/hero.png') from a loopback preview URL or inlined data URI.
  function lookupOriginalAssetPath(rawUriOrPath, elementNode) {
    if (elementNode) {
      if (elementNode.__slpAssetPath) return elementNode.__slpAssetPath;
      if (elementNode.getAttribute) {
        var explicitAssetAttr = elementNode.getAttribute("data-slp-asset-path");
        if (explicitAssetAttr) return explicitAssetAttr;
      }
    }
    if (!rawUriOrPath || typeof rawUriOrPath !== "string") return "";
    var trimmedUri = rawUriOrPath.trim();
    if (Object.prototype.hasOwnProperty.call(reverseAssetPathByUri, trimmedUri)) {
      return reverseAssetPathByUri[trimmedUri];
    }
    // Strip the loopback preview server prefix ('http://127.0.0.1:<port>/<token>/') to recover the '.slp/mockup/' relative path.
    var loopbackMatch = trimmedUri.match(/^https?:\\/\\/127\\.0\\.0\\.1:\\d+\\/[0-9a-f]+\\/([^?#]+)/i);
    if (loopbackMatch && loopbackMatch[1]) {
      try { return decodeURIComponent(loopbackMatch[1]); } catch (_e) { return loopbackMatch[1]; }
    }
    if (!/^(?:data:|blob:|https?:)/i.test(trimmedUri)) {
      return trimmedUri.replace(/[?#].*$/, "").replace(/^(?:\\.\\/)*/, "");
    }
    return "";
  }

  // Hook HTMLImageElement.prototype.src so offscreen 'new Image()' instances used by Canvas 2D keep their file path and CORS mode.
  if (typeof HTMLImageElement !== "undefined" && HTMLImageElement.prototype) {
    var nativeImgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (nativeImgSrcDesc && typeof nativeImgSrcDesc.set === "function" && typeof nativeImgSrcDesc.get === "function") {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: true,
        enumerable: true,
        get: function () {
          return nativeImgSrcDesc.get.call(this);
        },
        set: function (rawValue) {
          var strVal = typeof rawValue === "string" ? rawValue.trim() : "";
          // Anonymous CORS lets sandboxed iframes crop spritesheet frames on <canvas> from the loopback server without tainting.
          if (!this.crossOrigin && strVal && !/^data:/i.test(strVal)) {
            try { this.crossOrigin = "anonymous"; } catch (_e) {}
          }
          var mappedDataUri = lookupMockupAssetDataUri(strVal);
          if (mappedDataUri) {
            var cleanRelPath = strVal.replace(/[?#].*$/, "").replace(/^(?:\\.\\/)*/, "");
            this.__slpAssetPath = reverseAssetPathByUri[mappedDataUri] || cleanRelPath;
            if (this.setAttribute) this.setAttribute("data-slp-asset-path", this.__slpAssetPath);
            nativeImgSrcDesc.set.call(this, mappedDataUri);
            return;
          }
          var resolvedPath = lookupOriginalAssetPath(strVal, this);
          if (resolvedPath) {
            this.__slpAssetPath = resolvedPath;
            if (this.setAttribute) this.setAttribute("data-slp-asset-path", resolvedPath);
          }
          nativeImgSrcDesc.set.call(this, rawValue);
        }
      });
    }
  }

  // Hook CanvasRenderingContext2D.prototype.drawImage so every sprite/image drawn onto a <canvas> is tracked with its file path and bounding box.
  if (typeof CanvasRenderingContext2D !== "undefined" && CanvasRenderingContext2D.prototype && typeof CanvasRenderingContext2D.prototype.drawImage === "function") {
    var nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    var croppedSpriteCache = {};

    CanvasRenderingContext2D.prototype.drawImage = function (imageSource) {
      var drawResult = nativeDrawImage.apply(this, arguments);
      try {
        var hostCanvas = this && this.canvas;
        if (!hostCanvas || !imageSource) return drawResult;

        // Recover source URI and disk asset path from either an HTMLImageElement or an offscreen <canvas> buffer.
        var rawSourceUri = imageSource.currentSrc || imageSource.src || (imageSource.getAttribute && imageSource.getAttribute("src")) || "";
        var sourceAssetPath = lookupOriginalAssetPath(rawSourceUri, imageSource);
        if (!rawSourceUri && imageSource.tagName && imageSource.tagName.toLowerCase() === "canvas" && typeof imageSource.toDataURL === "function") {
          try { rawSourceUri = imageSource.toDataURL("image/png"); } catch (_e) {}
          sourceAssetPath = sourceAssetPath || imageSource.id || "offscreen-canvas";
        }
        if (!rawSourceUri && !sourceAssetPath) return drawResult;

        // Normalize 3-arg, 5-arg, and 9-arg (spritesheet crop) drawImage signatures into source and destination rectangles.
        var naturalW = imageSource.naturalWidth || imageSource.width || 0;
        var naturalH = imageSource.naturalHeight || imageSource.height || 0;
        var sx = 0, sy = 0, sw = naturalW, sh = naturalH;
        var dx = 0, dy = 0, dw = naturalW, dh = naturalH;

        if (arguments.length === 3) {
          dx = Number(arguments[1]) || 0;
          dy = Number(arguments[2]) || 0;
        } else if (arguments.length === 5) {
          dx = Number(arguments[1]) || 0;
          dy = Number(arguments[2]) || 0;
          dw = Number(arguments[3]) || naturalW;
          dh = Number(arguments[4]) || naturalH;
        } else if (arguments.length >= 9) {
          sx = Number(arguments[1]) || 0;
          sy = Number(arguments[2]) || 0;
          sw = Number(arguments[3]) || naturalW;
          sh = Number(arguments[4]) || naturalH;
          dx = Number(arguments[5]) || 0;
          dy = Number(arguments[6]) || 0;
          dw = Number(arguments[7]) || sw;
          dh = Number(arguments[8]) || sh;
        }

        // Transform (dx, dy, dw, dh) by the active 2D context matrix so translated/scaled sprites record accurate canvas coordinates.
        var boxX = dx, boxY = dy, boxW = dw, boxH = dh;
        if (typeof this.getTransform === "function") {
          var mat = this.getTransform();
          if (mat && typeof mat.a === "number") {
            var x1 = mat.a * dx + mat.c * dy + mat.e;
            var y1 = mat.b * dx + mat.d * dy + mat.f;
            var x2 = mat.a * (dx + dw) + mat.c * (dy + dh) + mat.e;
            var y2 = mat.b * (dx + dw) + mat.d * (dy + dh) + mat.f;
            boxX = Math.min(x1, x2);
            boxY = Math.min(y1, y2);
            boxW = Math.abs(x2 - x1);
            boxH = Math.abs(y2 - y1);
          }
        }

        // If drawing a cropped frame from a spritesheet, generate a cropped preview URI so Design mode shows the exact sprite frame.
        var previewUri = rawSourceUri;
        var frameSuffix = "";
        if (arguments.length >= 9 && sw > 0 && sh > 0 && naturalW > 0 && naturalH > 0 && (sx > 0 || sy > 0 || sw < naturalW || sh < naturalH)) {
          frameSuffix = " [frame " + Math.round(sx) + "," + Math.round(sy) + " " + Math.round(sw) + "x" + Math.round(sh) + "]";
          var cropKey = (sourceAssetPath || rawSourceUri.slice(0, 64)) + frameSuffix;
          if (croppedSpriteCache[cropKey]) {
            previewUri = croppedSpriteCache[cropKey];
          } else {
            try {
              var cropCanvas = document.createElement("canvas");
              cropCanvas.width = Math.max(1, Math.round(sw));
              cropCanvas.height = Math.max(1, Math.round(sh));
              var cropCtx = cropCanvas.getContext("2d");
              if (cropCtx) {
                nativeDrawImage.call(cropCtx, imageSource, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
                previewUri = cropCanvas.toDataURL("image/png");
                croppedSpriteCache[cropKey] = previewUri;
              }
            } catch (_cropErr) {}
          }
        }

        // Deduplicate per-frame redraws in requestAnimationFrame loops while keeping the latest bounding box and z-order.
        if (!hostCanvas.__slpDrawnImages) hostCanvas.__slpDrawnImages = [];
        var drawnList = hostCanvas.__slpDrawnImages;
        var dedupeKey = (sourceAssetPath || previewUri.slice(0, 80)) + frameSuffix;
        var dimsText = (naturalW > 0 && naturalH > 0 ? naturalW + "x" + naturalH + "px · " : "") +
          "canvas(" + Math.round(boxX) + "," + Math.round(boxY) + " " + Math.round(boxW) + "x" + Math.round(boxH) + "px)";

        var existingIdx = -1;
        for (var dIdx = 0; dIdx < drawnList.length; dIdx++) {
          if (drawnList[dIdx].dedupeKey === dedupeKey) {
            existingIdx = dIdx;
            break;
          }
        }
        var spriteRecord = {
          dedupeKey: dedupeKey,
          assetPath: sourceAssetPath || "canvas-sprite",
          label: (sourceAssetPath || "canvas-sprite") + frameSuffix,
          imagePreviewUri: previewUri,
          imageDimensions: dimsText,
          x: boxX,
          y: boxY,
          width: Math.max(4, boxW),
          height: Math.max(4, boxH)
        };
        if (existingIdx !== -1) {
          drawnList.splice(existingIdx, 1);
        }
        drawnList.push(spriteRecord);
        if (drawnList.length > 48) drawnList.shift();
      } catch (_trackErr) {}
      return drawResult;
    };
  }

  // Hit-test individual sprites drawn onto a <canvas> via ctx.drawImage at viewport coordinates (clientX, clientY).
  function resolveCanvasSpriteAtPoint(canvasEl, clientX, clientY) {
    var drawnSprites = canvasEl && canvasEl.__slpDrawnImages;
    if (!drawnSprites || !drawnSprites.length) return null;
    var canvasSelector = buildElementSelector(canvasEl);

    if (typeof clientX === "number" && typeof clientY === "number" && canvasEl.getBoundingClientRect) {
      var rect = canvasEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        var scaleX = (canvasEl.width || rect.width) / rect.width;
        var scaleY = (canvasEl.height || rect.height) / rect.height;
        var localX = (clientX - rect.left) * scaleX;
        var localY = (clientY - rect.top) * scaleY;

        var matchingSprites = [];
        for (var idx = drawnSprites.length - 1; idx >= 0; idx--) {
          var sp = drawnSprites[idx];
          if (localX >= sp.x && localX <= sp.x + sp.width && localY >= sp.y && localY <= sp.y + sp.height) {
            matchingSprites.push(sp);
          }
        }
        if (matchingSprites.length > 0) {
          matchingSprites.sort(function (a, b) {
            return (a.width * a.height) - (b.width * b.height);
          });
          var hitSprite = matchingSprites[0];
          return {
            element: canvasEl,
            tagName: "canvas-img",
            selector: canvasSelector + " [sprite: " + hitSprite.label + "]",
            elementText: hitSprite.label.slice(0, 80),
            assetPath: hitSprite.assetPath,
            imagePreviewUri: hitSprite.imagePreviewUri,
            imageDimensions: hitSprite.imageDimensions
          };
        }
      }
    }

    var topSprite = drawnSprites[drawnSprites.length - 1];
    return {
      element: canvasEl,
      tagName: "canvas-img",
      selector: canvasSelector + " [sprite: " + topSprite.label + "]",
      elementText: topSprite.label.slice(0, 80),
      assetPath: topSprite.assetPath,
      imagePreviewUri: topSprite.imagePreviewUri,
      imageDimensions: topSprite.imageDimensions
    };
  }

  // Why: thumbnails render inside the parent Paseo window, so relative URLs must be anchored to the preview iframe's origin.
  function resolveAbsolutePreviewUri(rawUriOrPath) {
    if (!rawUriOrPath || typeof rawUriOrPath !== "string") return "";
    var trimmedUri = rawUriOrPath.trim();
    if (!trimmedUri || /^(?:data:|blob:|https?:)/i.test(trimmedUri)) return trimmedUri;
    try {
      return new URL(trimmedUri, document.baseURI || window.location.href).href;
    } catch (_urlErr) {
      return trimmedUri;
    }
  }

  // Extract the first 'url(...)' value from inline or computed CSS 'background-image'.
  function extractCssBackgroundImageUri(elementNode) {
    if (!elementNode || elementNode.nodeType !== 1 || typeof window.getComputedStyle !== "function") return "";
    // Why: prefer getComputedStyle so the browser resolves relative 'url(assets/...)' strings into full HTTP URLs.
    var computedBg = window.getComputedStyle(elementNode).backgroundImage || "";
    var inlineStyleBg = elementNode.style && elementNode.style.backgroundImage ? elementNode.style.backgroundImage : "";
    var activeBgSource = (computedBg && computedBg !== "none") ? computedBg : inlineStyleBg;
    if (!activeBgSource || activeBgSource === "none") return "";
    var urlMatch = activeBgSource.match(/url\\(\\s*(?:"([^"]+)"|'([^']+)'|([^)'"\\s]+))\\s*\\)/i);
    var extractedUrl = (urlMatch && (urlMatch[1] || urlMatch[2] || urlMatch[3]) || "").trim();
    return lookupMockupAssetDataUri(extractedUrl) || resolveAbsolutePreviewUri(extractedUrl);
  }

  // Report both intrinsic image resolution and on-screen rendered dimensions so Codex knows the target aspect ratio and size.
  function formatElementImageDimensions(naturalW, naturalH, elementNode) {
    var rect = elementNode && elementNode.getBoundingClientRect ? elementNode.getBoundingClientRect() : null;
    var renderedW = rect ? Math.round(rect.width) : 0;
    var renderedH = rect ? Math.round(rect.height) : 0;
    if (naturalW > 0 && naturalH > 0 && renderedW > 0 && renderedH > 0) {
      if (naturalW === renderedW && naturalH === renderedH) return naturalW + "x" + naturalH + "px";
      return naturalW + "x" + naturalH + "px (screen " + renderedW + "x" + renderedH + "px)";
    }
    if (naturalW > 0 && naturalH > 0) return naturalW + "x" + naturalH + "px";
    if (renderedW > 0 && renderedH > 0) return renderedW + "x" + renderedH + "px";
    return "";
  }

  // Extract visual asset details (file path, preview URL/URI, dimensions, label) when an element displays an image or <canvas> sprite.
  function extractElementImageMetadata(targetEl, clientX, clientY) {
    if (!targetEl || targetEl.nodeType !== 1) return null;
    var tag = targetEl.tagName.toLowerCase();

    if (tag === "img") {
      var imgSrc = targetEl.currentSrc || targetEl.getAttribute("src") || "";
      if (!imgSrc) return null;
      var imgAssetPath = lookupOriginalAssetPath(imgSrc, targetEl);
      var imgAlt = (targetEl.getAttribute("alt") || targetEl.getAttribute("title") || imgAssetPath || "image").trim();
      return {
        element: targetEl,
        tagName: "img",
        selector: buildElementSelector(targetEl),
        elementText: imgAlt.slice(0, 80),
        assetPath: imgAssetPath,
        imagePreviewUri: imgSrc,
        imageDimensions: formatElementImageDimensions(targetEl.naturalWidth || 0, targetEl.naturalHeight || 0, targetEl)
      };
    }

    var owningSvg = tag === "svg" ? targetEl : (targetEl.closest ? targetEl.closest("svg") : null);
    if (owningSvg) {
      var svgAssetPath = owningSvg.getAttribute("data-slp-asset-path") || "inline-svg";
      var svgPreviewUri = "";
      try {
        var serializedSvg = new XMLSerializer().serializeToString(owningSvg);
        svgPreviewUri = "data:" + "image/svg+xml;utf8," + encodeURIComponent(serializedSvg);
      } catch (_err) {}
      var svgLabel = (owningSvg.getAttribute("aria-label") || owningSvg.getAttribute("id") || svgAssetPath).trim();
      return {
        element: owningSvg,
        tagName: "svg",
        selector: buildElementSelector(owningSvg),
        elementText: svgLabel.slice(0, 80),
        assetPath: svgAssetPath,
        imagePreviewUri: svgPreviewUri,
        imageDimensions: formatElementImageDimensions(0, 0, owningSvg)
      };
    }

    if (tag === "canvas") {
      var hitCanvasSprite = resolveCanvasSpriteAtPoint(targetEl, clientX, clientY);
      if (hitCanvasSprite) return hitCanvasSprite;
      var canvasPreviewUri = "";
      try { canvasPreviewUri = targetEl.toDataURL("image/png"); } catch (_err) {}
      var canvasAssetPath = targetEl.getAttribute("data-slp-asset-path") || targetEl.id || "canvas";
      return {
        element: targetEl,
        tagName: "canvas",
        selector: buildElementSelector(targetEl),
        elementText: (targetEl.getAttribute("aria-label") || canvasAssetPath).slice(0, 80),
        assetPath: canvasAssetPath,
        imagePreviewUri: canvasPreviewUri,
        imageDimensions: formatElementImageDimensions(targetEl.width || 0, targetEl.height || 0, targetEl)
      };
    }

    var bgImageUri = extractCssBackgroundImageUri(targetEl);
    if (bgImageUri) {
      var bgAssetPath = lookupOriginalAssetPath(bgImageUri, targetEl);
      var bgLabel = (extractElementSnippet(targetEl) || bgAssetPath || "background-image").trim();
      return {
        element: targetEl,
        tagName: tag,
        selector: buildElementSelector(targetEl),
        elementText: bgLabel.slice(0, 80),
        assetPath: bgAssetPath,
        imagePreviewUri: bgImageUri,
        imageDimensions: formatElementImageDimensions(0, 0, targetEl)
      };
    }
    return null;
  }

  // Locate the visual image or <canvas> sprite at (clientX, clientY), piercing through transparent HUD/text overlays in Design mode.
  function resolveDesignImageTargetAtPoint(clientX, clientY, fallbackTarget) {
    if (typeof document.elementsFromPoint === "function" && typeof clientX === "number" && typeof clientY === "number") {
      var hitStack = document.elementsFromPoint(clientX, clientY) || [];
      for (var i = 0; i < hitStack.length; i++) {
        var hitMeta = extractElementImageMetadata(hitStack[i], clientX, clientY);
        if (hitMeta) return hitMeta;
      }
    }
    var currentEl = fallbackTarget;
    while (currentEl && currentEl.nodeType === 1 && currentEl !== document.body) {
      var ancestorMeta = extractElementImageMetadata(currentEl, clientX, clientY);
      if (ancestorMeta) return ancestorMeta;
      currentEl = currentEl.parentElement;
    }
    if (fallbackTarget && fallbackTarget.querySelector) {
      var nestedImg = fallbackTarget.querySelector("img, svg, canvas");
      if (nestedImg) {
        var nestedMeta = extractElementImageMetadata(nestedImg, clientX, clientY);
        if (nestedMeta) return nestedMeta;
      }
    }
    return null;
  }

  // Scan the live DOM and <canvas> drawImage buffers to broadcast all visible screen images/sprites to the Design drawer.
  function broadcastVisibleScreenImages() {
    if (!document.body) return;
    var discoveredImages = [];
    var seenKeys = {};
    var allNodes = document.body.querySelectorAll("*");
    for (var idx = 0; idx < allNodes.length; idx++) {
      var node = allNodes[idx];
      var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!rect || rect.width < 4 || rect.height < 4) continue;
      if (node.tagName && node.tagName.toLowerCase() === "canvas" && node.__slpDrawnImages && node.__slpDrawnImages.length > 0) {
        var canvasSel = buildElementSelector(node);
        for (var sIdx = 0; sIdx < node.__slpDrawnImages.length; sIdx++) {
          var sp = node.__slpDrawnImages[sIdx];
          var spSelector = canvasSel + " [sprite: " + sp.label + "]";
          if (seenKeys[spSelector]) continue;
          seenKeys[spSelector] = true;
          discoveredImages.push({
            selector: spSelector,
            tagName: "canvas-img",
            elementText: sp.label.slice(0, 80),
            assetPath: sp.assetPath,
            imagePreviewUri: sp.imagePreviewUri,
            imageDimensions: sp.imageDimensions
          });
          if (discoveredImages.length >= 48) break;
        }
        if (discoveredImages.length >= 48) break;
        continue;
      }
      var meta = extractElementImageMetadata(node);
      if (!meta || !meta.imagePreviewUri) continue;
      var dedupeKey = meta.selector + "::" + (meta.assetPath || meta.imagePreviewUri.slice(0, 64));
      if (seenKeys[dedupeKey]) continue;
      seenKeys[dedupeKey] = true;
      discoveredImages.push({
        selector: meta.selector,
        tagName: meta.tagName,
        elementText: meta.elementText,
        assetPath: meta.assetPath,
        imagePreviewUri: meta.imagePreviewUri,
        imageDimensions: meta.imageDimensions
      });
      if (discoveredImages.length >= 48) break;
    }
    window.parent.postMessage({ type: "slp-mockup-screen-images", images: discoveredImages }, "*");
  }
`;
}
