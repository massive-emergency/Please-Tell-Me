console.log("viewer.js loaded");

// ================================
// PDF.js worker configuration
// ================================
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "pdfjs/pdf.worker.min.js"
);

// ================================
// Decode PDF from URL hash
// ================================
const base64 = location.hash.substring(1);
const pdfContainer = document.getElementById("pdf");
const statsEl = document.getElementById("stats");

if (!base64) {
  statsEl.textContent = "No PDF data found in URL. Upload a PDF first.";
  throw new Error("Missing PDF hash data");
}

const pdfData = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// ================================
// Geometry helpers
// ================================
function rectFromPoints(p) {
  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function clampRect(r, viewport) {
  const x = Math.max(0, Math.min(r.x, viewport.width));
  const y = Math.max(0, Math.min(r.y, viewport.height));
  const right = Math.max(0, Math.min(r.x + r.width, viewport.width));
  const bottom = Math.max(0, Math.min(r.y + r.height, viewport.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function boxesIntersect(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
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

// Ignore obvious page background / layout blocks
function looksLikeLayout(r, viewport) {
  const pageArea = viewport.width * viewport.height;
  const area = r.width * r.height;

  // too tiny => noise
  if (r.width < 12 || r.height < 8) return true;

  // huge => likely background/container
  if (area / pageArea > 0.30) return true;

  // spans almost entire width/height => likely layout
  if (r.width > viewport.width * 0.95) return true;
  if (r.height > viewport.height * 0.95) return true;

  return false;
}

// ================================
// Capture overlays from canvas ops
// (images, stickers, emojis, pasted shapes, etc.)
// ================================
function installOverlayCapture(ctx, overlayRegions, viewport) {
  // Transform a point with DOMMatrix (current canvas transform)
  function applyMatrix(m, x, y) {
    // DOMMatrix: a,b,c,d,e,f
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  // Capture a destination rect in *canvas coordinates*
  function captureDestRect(dx, dy, dw, dh, kind) {
    // guard
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dw) || !Number.isFinite(dh)) return;
    if (dw <= 0 || dh <= 0) return;

    const alpha = typeof ctx.globalAlpha === "number" ? ctx.globalAlpha : 1;
    // If you truly want ANY overlay even if transparent, drop this threshold to 0.
    // For now: ignore near-invisible draws.
    if (alpha < 0.05) return;

    const m = ctx.getTransform ? ctx.getTransform() : null;

    let r;
    if (m) {
      const p1 = applyMatrix(m, dx, dy);
      const p2 = applyMatrix(m, dx + dw, dy);
      const p3 = applyMatrix(m, dx + dw, dy + dh);
      const p4 = applyMatrix(m, dx, dy + dh);
      r = rectFromPoints([p1, p2, p3, p4]);
    } else {
      // fallback: no transform support
      r = { x: dx, y: dy, width: dw, height: dh };
    }

    r = clampRect(r, viewport);
    if (r.width < 12 || r.height < 8) return;
    if (looksLikeLayout(r, viewport)) return;

    overlayRegions.push({ ...r, alpha, kind });
  }

  // --- Hook drawImage ---
  const origDrawImage = ctx.drawImage.bind(ctx);
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

      captureDestRect(dx, dy, dw, dh, "image");
    } catch (e) {
      // swallow capture errors; never break render
    }

    return origDrawImage(...args);
  };

  // --- Hook fillRect (covers some “fat marker” / simple blocks) ---
  const origFillRect = ctx.fillRect.bind(ctx);
  ctx.fillRect = (x, y, w, h) => {
    try {
      // If you want to skip fully transparent fills, keep alpha threshold in captureDestRect
      captureDestRect(x, y, w, h, "fillRect");
    } catch (e) {}
    return origFillRect(x, y, w, h);
  };
}

// ================================
// Main
// ================================
(async () => {
  try {
    statsEl.textContent = "Loading PDF…";

    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    console.log("PDF loaded:", pdf.numPages, "pages");

    let total = 0;
    let recoverable = 0;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      statsEl.textContent = `Rendering page ${pageNum}/${pdf.numPages}…`;

      const page = await pdf.getPage(pageNum);
      const scale = 1.5;
      const viewport = page.getViewport({ scale });

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

      const ctx = canvas.getContext("2d");

      // Capture overlays during render
      const overlayRegions = [];
      installOverlayCapture(ctx, overlayRegions, viewport);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Extract text with boxes in viewport/canvas coords
      const textContent = await page.getTextContent();
      const textItems = textContent.items
        .filter((item) => item.str && item.str.trim())
        .map((item) => {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const x = tx[4];
          const y = tx[5];

          const w = Math.max((item.width || 0) * scale, 1);
          const h = Math.max((item.height || 0) * scale, 10);

          return {
            str: item.str,
            box: { x, y: y - h, width: w, height: h },
          };
        });

      // Dedupe overlays
      const regions = dedupeRegions(overlayRegions);

      console.log(`Page ${pageNum}: captured ${regions.length} overlay regions`);

      // For each overlay, decide recoverability and render interactive div
      let pageRedactions = 0;

      for (const r0 of regions) {
        // Count any overlay as a redaction (your requirement)
        pageRedactions++;
        total++;

        const el = document.createElement("div");
        el.className = "redaction";
        el.style.left = `${r0.x}px`;
        el.style.top = `${r0.y}px`;
        el.style.width = `${r0.width}px`;
        el.style.height = `${r0.height}px`;

        const hits = textItems
          .filter((t) => boxesIntersect(t.box, r0))
          .map((t) => t.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (hits) {
          recoverable++;
          el.classList.add("recoverable");
          el.dataset.text = hits;
        } else {
          el.classList.add("unrecoverable");
        }

        pageDiv.appendChild(el);
      }

      console.log(`Page ${pageNum}: counted ${pageRedactions} redactions`);
      pdfContainer.appendChild(pageDiv);
    }

    const pct = total ? Math.round((recoverable / total) * 100) : 0;
    statsEl.textContent = `Redactions: ${total} | Recoverable: ${recoverable} | Recovery: ${pct}%`;
  } catch (err) {
    console.error("Viewer fatal error:", err);
    statsEl.textContent = "Error loading PDF (see console)";
  }
})();
