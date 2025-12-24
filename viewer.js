/* viewer.js — Please Tell Me (MV3-safe, no base64)
   - Loads PDF bytes from chrome.storage.session via URL hash token
   - Renders all pages
   - Detects potential "redactions" as ANY overlay:
       * PDF annotations (rect-based)
       * Canvas vector fills (fillRect) with effective alpha > threshold
       * Canvas bitmaps (drawImage)
   - Positions overlays correctly by mapping through ctx.getTransform()
   - Progress + counters in stats bar, brand/version on right
*/

console.log("viewer.js loaded");

// =============================
// Config
// =============================
const APP_NAME = "Please Tell Me";
const VERSION = "v0.1";
const SCALE = 1.5;

// Ignore near-invisible draws (effective alpha below this)
const MIN_EFFECTIVE_ALPHA = 0.10;

// PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "pdfjs/pdf.worker.min.js"
);

// =============================
// DOM
// =============================
const statsEl = document.getElementById("stats");
const pdfContainer = document.getElementById("pdf");

if (!statsEl || !pdfContainer) {
  throw new Error("viewer.html must contain #stats and #pdf elements");
}

// -----------------------------
// Stats UI (expects your viewer.html structure; will populate it if present)
// -----------------------------
function setStatus(text) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = text;
}

function setProgressBar(pct) {
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function setCounts({ annotations, vectors, images }) {
  const a = document.getElementById("count-annotations");
  const v = document.getElementById("count-vectors");
  const i = document.getElementById("count-images");
  if (a) a.textContent = `Annotations: ${annotations}`;
  if (v) v.textContent = `Vectors: ${vectors}`;
  if (i) i.textContent = `Images: ${images}`;
}

function setBrandRight() {
  const right = document.getElementById("stats-right");
  if (right) {
    right.innerHTML = `${APP_NAME} <span class="version">${VERSION}</span>`;
  }
}

function setFinalTotals({ totalRedactions, recoverable }) {
  const pct = totalRedactions ? Math.round((recoverable / totalRedactions) * 100) : 0;

  // Keep your existing layout: left has status/progress, center has counts.
  // We’ll put totals into the center line by appending if you want,
  // but safest: update status to include totals.
  setStatus(`Analysis complete`);
  setProgressBar(100);

  // If you want totals visible (recommended), we’ll inject into stats-center as a single text node.
  const center = document.getElementById("stats-center");
  if (center) {
    // Preserve the three spans, then append totals after them.
    let totalsEl = document.getElementById("ptm-totals");
    if (!totalsEl) {
      totalsEl = document.createElement("span");
      totalsEl.id = "ptm-totals";
      totalsEl.style.marginLeft = "14px";
      center.appendChild(totalsEl);
    }
    totalsEl.textContent = `Redactions: ${totalRedactions} · Recoverable: ${recoverable} · Recovery: ${pct}%`;
  }
}

// Let UI paint between heavy steps
function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

// =============================
// Geometry helpers
// =============================
function boxesIntersect(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function clampRect(r, viewport) {
  const x = Math.max(0, Math.min(r.x, viewport.width));
  const y = Math.max(0, Math.min(r.y, viewport.height));
  const right = Math.max(0, Math.min(r.x + r.width, viewport.width));
  const bottom = Math.max(0, Math.min(r.y + r.height, viewport.height));
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function rectFromPoints(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function approxEqual(a, b, eps = 1.5) {
  return Math.abs(a - b) <= eps;
}

function dedupeRegions(regions) {
  const out = [];
  for (const r of regions) {
    const hit = out.find(
      (o) =>
        approxEqual(o.x, r.x) &&
        approxEqual(o.y, r.y) &&
        approxEqual(o.width, r.width) &&
        approxEqual(o.height, r.height)
    );
    if (!hit) out.push(r);
  }
  return out;
}

// Filters to avoid giant “layout/background” overlays
function looksLikeLayout(r, viewport) {
  const pageArea = viewport.width * viewport.height;
  const area = r.width * r.height;

  // Noise
  if (r.width < 10 || r.height < 8) return true;

  // Huge background/container
  if (area / pageArea > 0.35) return true;

  // Near full-page spans
  if (r.width > viewport.width * 0.95) return true;
  if (r.height > viewport.height * 0.95) return true;

  return false;
}

// =============================
// Alpha helpers (vector opacity)
// =============================
function parseCssAlpha(style) {
  // Handles: rgba(r,g,b,a) and rgb(r,g,b)
  if (!style || typeof style !== "string") return 1;
  const s = style.trim().toLowerCase();
  if (s.startsWith("rgba(")) {
    const inside = s.slice(5, -1);
    const parts = inside.split(",").map((p) => p.trim());
    const a = parseFloat(parts[3]);
    return Number.isFinite(a) ? a : 1;
  }
  // rgb(...) => alpha 1
  return 1;
}

function effectiveAlpha(ctx, styleAlpha = 1) {
  const ga = typeof ctx.globalAlpha === "number" ? ctx.globalAlpha : 1;
  return ga * styleAlpha;
}

// =============================
// Detection: Annotations (rects)
// =============================
async function getAnnotationRegions(page, viewport) {
  const regions = [];
  const annotations = await page.getAnnotations();

  for (const ann of annotations) {
    if (!ann.rect || !Array.isArray(ann.rect) || ann.rect.length !== 4) continue;

    const [x1, y1, x2, y2] = ann.rect;

    // PDF space -> viewport space
    const p1 = pdfjsLib.Util.transform(viewport.transform, [1, 0, 0, 1, x1, y1]);
    const p2 = pdfjsLib.Util.transform(viewport.transform, [1, 0, 0, 1, x2, y2]);

    const r = clampRect(
      rectFromPoints([{ x: p1[4], y: p1[5] }, { x: p2[4], y: p2[5] }]),
      viewport
    );

    if (!looksLikeLayout(r, viewport)) regions.push(r);
  }

  return dedupeRegions(regions);
}

// =============================
// Detection: Canvas overlays (bitmaps + fillRect) with proper transform mapping
// =============================
function installCanvasOverlayCapture(ctx, viewport, overlayRegions, counts) {
  const origDrawImage = ctx.drawImage.bind(ctx);
  const origFillRect = ctx.fillRect.bind(ctx);

  function mapRectThroughTransform(x, y, w, h) {
    const m = ctx.getTransform ? ctx.getTransform() : null;
    if (!m) return clampRect({ x, y, width: w, height: h }, viewport);

    const p1 = { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
    const p2 = { x: m.a * (x + w) + m.c * y + m.e, y: m.b * (x + w) + m.d * y + m.f };
    const p3 = { x: m.a * (x + w) + m.c * (y + h) + m.e, y: m.b * (x + w) + m.d * (y + h) + m.f };
    const p4 = { x: m.a * x + m.c * (y + h) + m.e, y: m.b * x + m.d * (y + h) + m.f };

    const r = clampRect(rectFromPoints([p1, p2, p3, p4]), viewport);
    return r;
  }

  function addRegion(r, kind, effA) {
    if (!r || r.width <= 0 || r.height <= 0) return;
    if (looksLikeLayout(r, viewport)) return;

    overlayRegions.push({ ...r, kind, alpha: effA });
    if (kind === "image") counts.images++;
    if (kind === "vector") counts.vectors++;
  }

  ctx.drawImage = (...args) => {
    try {
      // drawImage(img, dx, dy)
      // drawImage(img, dx, dy, dw, dh)
      // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
      let dx, dy, dw, dh;

      if (args.length === 3) {
        const img = args[0];
        dx = args[1];
        dy = args[2];
        dw = img?.width ?? 0;
        dh = img?.height ?? 0;
      } else if (args.length === 5) {
        dx = args[1];
        dy = args[2];
        dw = args[3];
        dh = args[4];
      } else if (args.length === 9) {
        dx = args[5];
        dy = args[6];
        dw = args[7];
        dh = args[8];
      }

      // Ignore tiny icons
      if (dw >= 12 && dh >= 8) {
        // Images have no fillStyle alpha; just globalAlpha
        const effA = effectiveAlpha(ctx, 1);
        if (effA >= MIN_EFFECTIVE_ALPHA) {
          const r = mapRectThroughTransform(dx, dy, dw, dh);
          addRegion(r, "image", effA);
        }
      }
    } catch (_) {
      // never break render
    }
    return origDrawImage(...args);
  };

  ctx.fillRect = (x, y, w, h) => {
    try {
      if (w >= 12 && h >= 8) {
        const styleA = parseCssAlpha(ctx.fillStyle);
        const effA = effectiveAlpha(ctx, styleA);

        // Only count opaque-ish vector fills
        if (effA >= MIN_EFFECTIVE_ALPHA) {
          const r = mapRectThroughTransform(x, y, w, h);
          addRegion(r, "vector", effA);
        }
      }
    } catch (_) {}
    return origFillRect(x, y, w, h);
  };
}

// =============================
// Main
// =============================
(async () => {
  try {
    setBrandRight();

    const token = location.hash.substring(1);
    if (!token) {
      setStatus("No document token found. Upload a PDF first.");
      return;
    }

    // NOTE: requires "storage" permission in manifest + MV3 session storage
    const result = await chrome.storage.session.get(token);
    const pdfData = result[token];

    if (!pdfData) {
      setStatus("Document expired. Please re-upload.");
      return;
    }

    // Free memory immediately
    chrome.storage.session.remove(token);

    setStatus("Loading PDF…");
    setProgressBar(2);
    setCounts({ annotations: 0, vectors: 0, images: 0 });
    await nextFrame();

    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    console.log("PDF loaded:", pdf.numPages, "pages");

    const totalPages = pdf.numPages;

    let totalRedactions = 0;
    let recoverable = 0;

    let annCount = 0;
    let vecCount = 0;
    let imgCount = 0;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pctPages = Math.round(((pageNum - 1) / totalPages) * 100);
      setStatus(`Scanning page ${pageNum} of ${totalPages}`);
      setProgressBar(pctPages);
      setCounts({ annotations: annCount, vectors: vecCount, images: imgCount });
      await nextFrame();

      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: SCALE });

      // Page wrapper
      const pageDiv = document.createElement("div");
      pageDiv.className = "page";
      pageDiv.style.width = `${viewport.width}px`;
      pageDiv.style.height = `${viewport.height}px`;

      // Canvas
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      pageDiv.appendChild(canvas);
      pdfContainer.appendChild(pageDiv);

      const ctx = canvas.getContext("2d");

      // Capture canvas overlays during render
      const overlayRegions = [];
      const counts = { vectors: 0, images: 0 };
      installCanvasOverlayCapture(ctx, viewport, overlayRegions, counts);

      // Render page
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Annotation overlays
      const annRegions = await getAnnotationRegions(page, viewport);
      annCount += annRegions.length;

      // Update counters from canvas capture
      vecCount += counts.vectors;
      imgCount += counts.images;

      // Extract text boxes in viewport space
      const textContent = await page.getTextContent();
      const textItems = textContent.items
        .filter((item) => item.str && item.str.trim())
        .map((item) => {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const x = tx[4];
          const y = tx[5];

          // Conservative box sizing
          const w = Math.max((item.width || 0) * SCALE, 1);
          const h = Math.max((item.height || 0) * SCALE, 12);

          return {
            str: item.str,
            box: { x, y: y - h, width: w, height: h },
          };
        });

      // Merge candidates (ANY overlay is a redaction candidate)
      const merged = dedupeRegions([
        ...annRegions.map((r) => ({ ...r, kind: "annotation" })),
        ...overlayRegions.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, kind: r.kind })),
      ]).filter((r) => !looksLikeLayout(r, viewport));

      console.log(`Page ${pageNum}: found ${merged.length} redactions`);

      // Render overlays and compute recoverability
      for (const r of merged) {
        totalRedactions++;

        const el = document.createElement("div");
        el.className = "redaction";
        el.style.left = `${r.x}px`;
        el.style.top = `${r.y}px`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;

        const hit = textItems
          .filter((t) => boxesIntersect(t.box, r))
          .map((t) => t.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (hit) {
          recoverable++;
          el.classList.add("recoverable");
          el.dataset.text = hit;
        } else {
          el.classList.add("unrecoverable");
        }

        pageDiv.appendChild(el);
      }

      // Progress update after finishing the page
      const pctDone = Math.round((pageNum / totalPages) * 100);
      setProgressBar(pctDone);
      setCounts({ annotations: annCount, vectors: vecCount, images: imgCount });
      await nextFrame();
    }

    setFinalTotals({ totalRedactions, recoverable });
  } catch (err) {
    console.error("Viewer fatal error:", err);
    setStatus("Error loading PDF (see console)");
  }
})();
