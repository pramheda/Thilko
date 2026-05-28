/**
 * Thin wrapper around pdfjs-dist for the Thilko viewer.
 *
 * Renders a PDF document into a sequence of `<div class="viewer-page"
 * data-page-number="N">` wrappers, each containing a `<canvas>` for the
 * visual + a `<div class="textLayer">` for selectable text. The text-layer
 * structure follows pdf.js conventions exactly so apache-annotator's
 * TextQuote matcher works on the resulting DOM with no special-casing.
 *
 * The worker is bundled from `pdfjs-dist/build/pdf.worker.mjs` (loaded via
 * Vite's `?url` import) — no CDN, no external fetch.
 */

import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const RENDER_SCALE = 1.5;

export interface PdfRenderResult {
  pdf: pdfjsLib.PDFDocumentProxy;
  title: string | null;
}

/**
 * Fetch + render a PDF into `container`. Resolves once every page's canvas
 * AND text layer have been painted. Throws on fetch failure or pdfjs error
 * so the caller can show an error banner.
 */
export async function renderPdf(url: string, container: HTMLElement): Promise<PdfRenderResult> {
  const loadingTask = pdfjsLib.getDocument({ url });
  const pdf = await loadingTask.promise;

  let title: string | null = null;
  try {
    const meta = await pdf.getMetadata();
    const info = (meta.info as Record<string, unknown> | undefined) ?? {};
    const raw = info.Title;
    if (typeof raw === "string" && raw.trim().length > 0) title = raw.trim();
  } catch {
    // metadata is optional; carry on
  }

  container.replaceChildren();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const pageEl = document.createElement("div");
    pageEl.className = "viewer-page";
    pageEl.setAttribute("data-page-number", String(pageNumber));
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;
    container.appendChild(pageEl);

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    pageEl.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(`canvas 2d context unavailable on page ${pageNumber}`);

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    textLayerEl.style.setProperty("--scale-factor", String(RENDER_SCALE));
    pageEl.appendChild(textLayerEl);

    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    const textContent = await page.getTextContent();
    // pdf.js 5.x exposes the TextLayer class for rendering selectable text.
    // It paints positioned spans inside the textLayer container.
    const TextLayerCtor = (pdfjsLib as unknown as { TextLayer?: new (opts: {
      textContentSource: unknown;
      container: HTMLElement;
      viewport: pdfjsLib.PageViewport;
    }) => { render: () => Promise<void> } }).TextLayer;
    if (!TextLayerCtor) throw new Error("pdfjs.TextLayer constructor unavailable (expected pdfjs ^5)");
    const layer = new TextLayerCtor({ textContentSource: textContent, container: textLayerEl, viewport });
    await layer.render();
  }

  return { pdf, title };
}
