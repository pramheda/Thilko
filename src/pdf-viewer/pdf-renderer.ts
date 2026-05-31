/**
 * pdf.js renderer using the official PDFViewer reference components.
 *
 * Replaces a hand-rolled implementation that produced soft pages with
 * partially-broken text layers. PDFViewer handles:
 *   - HiDPI / devicePixelRatio output scaling (real retina backing store,
 *     fixing the sharpness gap the old renderer had at pdf-renderer.ts:17)
 *   - Lazy text-layer rendering per visible page
 *   - Page-width fitting + scroll integration
 *   - Find dialog wiring (PDFFindController, used in Block 4)
 *   - Proper text-layer geometry (no "can't highlight this word" gaps
 *     for fonts whose char mapping pdf.js can recover)
 *
 * Asset wiring (Block 2):
 *   - cMapUrl + cMapPacked → Adobe CMap tables for CID-keyed (CJK) fonts.
 *   - standardFontDataUrl → 14 PDF standard fonts (Foxit-supplied Type 1
 *     equivalents) for documents that reference them by name without
 *     embedding the glyph data. Most LaTeX academic PDFs trip over this.
 *   - wasmUrl → jbig2 / openjpeg / qcms wasm helpers (image decoding,
 *     colour profile conversion).
 *   - useSystemFonts: true → fall back to the OS fonts when neither the
 *     PDF nor the standard-font bundle supplies a glyph.
 *   - enableXfa: true → render dynamic XFA forms (mostly enterprise
 *     paperwork; harmless for everything else).
 *
 * The three directories live at /cmaps/, /standard_fonts/, /wasm/ at the
 * extension root, copied from `node_modules/pdfjs-dist` into `dist/` by
 * the copyPdfjsAssets vite plugin. They are NOT in web_accessible_resources
 * because the pdf-viewer extension page (and its pdf.js worker) has same-
 * origin access to extension resources; WAR is only needed for resources
 * loaded by external web origins.
 *
 * Lazy-anchor handling for highlights on not-yet-rendered pages lives
 * in Block 3 (the caller treats unrendered text layers as pending,
 * not orphaned, and retries on the textlayerrendered event).
 */

import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import {
  EventBus,
  PDFViewer,
  PDFLinkService,
  PDFFindController,
} from "pdfjs-dist/web/pdf_viewer.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface PdfRenderResult {
  pdf: pdfjsLib.PDFDocumentProxy;
  title: string | null;
  /** EventBus exposed so the caller (viewer.tsx, bootLifecycle in Block 3,
   *  the find bar in Block 4) can listen for `textlayerrendered`, `pagesinit`,
   *  `pagesloaded`, find events, etc. */
  eventBus: EventBus;
  /** Find controller exposed for Block 4's compact find bar. */
  findController: PDFFindController;
  /** Returned so callers can drive scrolling / scale changes if needed. */
  viewer: PDFViewer;
}

export interface RenderPdfOptions {
  /** The original PDF URL to fetch. */
  url: string;
  /**
   * Scroll container. Must be positioned (relative/absolute/fixed) and
   * have a defined size so PDFViewer can compute page layout against it.
   * Typed as HTMLDivElement because PDFViewer's constructor refines its
   * input that way.
   */
  container: HTMLDivElement;
  /**
   * Inner div with class "pdfViewer" — PDFViewer adds its page elements
   * as children of this node. Must be a direct child of `container`.
   */
  viewer: HTMLDivElement;
}

/**
 * Fetch + mount a PDF into the given container/viewer. Resolves once the
 * document is loaded and PDFViewer has been wired with it; individual
 * page renders happen lazily as the user scrolls. Listen on the returned
 * eventBus for per-page completion via `textlayerrendered`.
 */
export async function renderPdf(opts: RenderPdfOptions): Promise<PdfRenderResult> {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });

  const pdfViewer = new PDFViewer({
    container: opts.container,
    viewer: opts.viewer,
    eventBus,
    linkService,
    findController,
  });
  linkService.setViewer(pdfViewer);

  const loadingTask = pdfjsLib.getDocument({
    url: opts.url,
    // Asset wiring — see file header. URLs MUST include the trailing slash.
    cMapUrl: chrome.runtime.getURL("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL("standard_fonts/"),
    wasmUrl: chrome.runtime.getURL("wasm/"),
    useSystemFonts: true,
    enableXfa: true,
  });
  const pdf = await loadingTask.promise;

  let title: string | null = null;
  try {
    const meta = await pdf.getMetadata();
    const info = (meta.info as Record<string, unknown> | undefined) ?? {};
    const raw = info.Title;
    if (typeof raw === "string" && raw.trim().length > 0) title = raw.trim();
  } catch {
    // metadata is optional
  }

  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);

  // Fit to page width once the first page's dimensions are known.
  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
  });

  return { pdf, title, eventBus, findController, viewer: pdfViewer };
}
