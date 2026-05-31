/**
 * PDF viewer page entry.
 *
 * URL: chrome-extension://<id>/src/pdf-viewer/viewer.html?file=<original-pdf-url>
 *
 * Lifecycle:
 *   1. Parse the original PDF URL from `?file=…`.
 *   2. Render pdf.js pages into the .viewer-pages container.
 *   3. Build a PageContext from the original URL + PDF metadata.
 *   4. Call bootLifecycle({ contentType: "pdf" }) — the same code path the
 *      content script uses for HTML, with the toolbar/sidebar/popover all
 *      mounted as shadow-DOM overlays on top of the rendered PDF.
 *
 * If anything fails (CORS-blocked PDF, attachment-only response, malformed
 * file), we show a banner with a "Open original" link so the user can fall
 * back to Chrome's built-in viewer.
 */

import "./pdf-viewer.css";
import { renderPdf, type PdfRenderResult } from "./pdf-renderer.js";
import { installFindBar } from "./find-bar.js";
import { bootLifecycle } from "../content/index.js";
import { deriveArticleId } from "../shared/url.js";
import type { RpcRequest, RpcResponse } from "../shared/messages.js";

async function fetchAutoPersistSetting(): Promise<boolean> {
  try {
    const req: RpcRequest = { kind: "getActivationSettings" };
    const r = (await chrome.runtime.sendMessage(req)) as RpcResponse | undefined;
    if (r && r.ok && r.data && typeof r.data === "object") {
      return Boolean((r.data as { autoPersistHighlights?: boolean }).autoPersistHighlights);
    }
  } catch {
    // ignore — fall back to default (false)
  }
  return false;
}

interface UrlParts {
  pdfUrl: string;
  isArxivPdf: boolean;
  ar5ivUrl: string | null;
}

function parseUrl(): UrlParts | null {
  // Raw extraction (no URLSearchParams) because the redirect URL is built by
  // Chrome's regexSubstitution as a literal splice:
  //   viewer.html?file=<ORIGINAL_URL_VERBATIM>
  // The ORIGINAL URL may contain `&` (additional query params), `+` (path
  // chars), and a trailing `#fragment`. URLSearchParams would split on the
  // first `&`, decode `+` to space, and discard the fragment. We instead
  // take everything after "?file=" as the search part of the URL, then
  // append `location.hash` so navigations like
  //   https://host/paper+v2.pdf?token=abc&x=1#page=3
  // survive intact.
  const FILE_PREFIX = "?file=";
  if (!location.search.startsWith(FILE_PREFIX)) return null;
  const raw = location.search.slice(FILE_PREFIX.length) + location.hash;
  if (raw.length === 0) return null;
  let pdfUrl: string;
  try {
    pdfUrl = new URL(raw).toString();
  } catch {
    return null;
  }
  const isArxivPdf = /^https?:\/\/(?:www\.)?arxiv\.org\/pdf\//i.test(pdfUrl);
  const ar5ivUrl = isArxivPdf ? pdfUrl.replace(/arxiv\.org\/pdf\//i, "ar5iv.org/abs/").replace(/\.pdf$/i, "") : null;
  return { pdfUrl, isArxivPdf, ar5ivUrl };
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const file = path.split("/").pop() ?? path;
    return file.replace(/\.pdf$/i, "") || u.hostname;
  } catch {
    return url;
  }
}

interface ViewerShell {
  toolbar: HTMLElement;
  /** Stage element — find bar overlays this. */
  pdfStage: HTMLDivElement;
  /** Outer scroll container — required by PDFViewer's layout math. */
  pdfContainer: HTMLDivElement;
  /** Inner div with class "pdfViewer" — where PDFViewer mounts pages. */
  pdfViewerEl: HTMLDivElement;
  titleEl: HTMLElement;
  metaEl: HTMLElement;
  bannerSlot: HTMLElement;
}

function renderShell(): ViewerShell {
  const root = document.getElementById("root");
  if (!root) throw new Error("no #root element");
  const viewer = document.createElement("div");
  viewer.className = "viewer";

  const toolbar = document.createElement("div");
  toolbar.className = "viewer-toolbar";
  const titleEl = document.createElement("div");
  titleEl.className = "viewer-title";
  titleEl.textContent = "Loading…";
  const metaEl = document.createElement("div");
  metaEl.className = "viewer-meta";
  toolbar.appendChild(titleEl);
  toolbar.appendChild(metaEl);
  viewer.appendChild(toolbar);

  const bannerSlot = document.createElement("div");
  viewer.appendChild(bannerSlot);

  // PDFViewer's constructor asserts its container is `position: absolute`
  // (pdf_viewer.mjs:7992). We satisfy this by wrapping the scroll container
  // in a flex item (.pdf-stage) that grows to fill remaining vertical space,
  // then letting .pdf-container fill the stage absolutely. The inner
  // .pdfViewer div is where PDFViewer mounts page wrappers as children.
  const pdfStage = document.createElement("div");
  pdfStage.className = "pdf-stage";
  const pdfContainer = document.createElement("div");
  pdfContainer.id = "viewerContainer";
  pdfContainer.className = "pdf-container";
  const pdfViewerEl = document.createElement("div");
  pdfViewerEl.className = "pdfViewer";
  pdfContainer.appendChild(pdfViewerEl);
  pdfStage.appendChild(pdfContainer);
  viewer.appendChild(pdfStage);

  root.replaceChildren(viewer);
  return { toolbar, pdfStage, pdfContainer, pdfViewerEl, titleEl, metaEl, bannerSlot };
}

function showError(slot: HTMLElement, pdfUrl: string, reason: string): void {
  const box = document.createElement("div");
  box.className = "viewer-error";
  box.textContent = `Couldn't load the PDF in Thilko: ${reason}`;
  const actions = document.createElement("div");
  actions.className = "viewer-error-actions";
  const link = document.createElement("a");
  link.href = pdfUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open the original PDF in Chrome's viewer";
  actions.appendChild(link);
  box.appendChild(actions);
  slot.replaceChildren(box);
}

function showBanner(slot: HTMLElement, parts: UrlParts): void {
  if (!parts.isArxivPdf || !parts.ar5ivUrl) return;
  const banner = document.createElement("div");
  banner.className = "viewer-banner";
  banner.innerHTML = "💡 This is an arXiv PDF. An HTML version may be available at ";
  const link = document.createElement("a");
  link.href = parts.ar5ivUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "ar5iv";
  banner.appendChild(link);
  banner.appendChild(document.createTextNode(" — annotations work better there."));
  slot.appendChild(banner);
}

async function init(): Promise<void> {
  const parts = parseUrl();
  if (!parts) {
    const root = document.getElementById("root");
    if (root) root.textContent = "Missing ?file= parameter.";
    return;
  }

  const { pdfUrl } = parts;
  document.title = `Thilko — ${deriveTitleFromUrl(pdfUrl)}`;

  const { pdfStage, pdfContainer, pdfViewerEl, titleEl, metaEl, bannerSlot } = renderShell();
  showBanner(bannerSlot, parts);

  // Mount the PDF. PDFViewer renders pages lazily as the user scrolls;
  // bootLifecycle's anchor flow treats not-yet-rendered text layers as
  // pending rather than orphaned and retries on the textlayerrendered
  // event (delivered via the EventBus we pass through below).
  let title = deriveTitleFromUrl(pdfUrl);
  let pdfEventBus: PdfRenderResult["eventBus"] | null = null;
  try {
    const result = await renderPdf({
      url: pdfUrl,
      container: pdfContainer,
      viewer: pdfViewerEl,
    });
    if (result.title) title = result.title;
    titleEl.textContent = title;
    metaEl.textContent = `${result.pdf.numPages} page${result.pdf.numPages === 1 ? "" : "s"}`;
    pdfEventBus = result.eventBus;
    installFindBar({ stage: pdfStage, eventBus: result.eventBus, findController: result.findController });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(bannerSlot, pdfUrl, msg);
    return;
  }

  // Build PageContext from the ORIGINAL PDF URL so articleId matches anything
  // the user already annotated on this PDF, and so the proxy ingests it under
  // its real URL (not the chrome-extension viewer URL).
  const { canonical, articleId } = await deriveArticleId(pdfUrl);
  document.title = `Thilko — ${title}`;

  const autoPersistHighlights = await fetchAutoPersistSetting();
  await bootLifecycle({
    context: {
      canonicalUrl: canonical,
      articleId,
      title,
      looksLikeArticle: true,
    },
    contentType: "pdf",
    autoPersistHighlights,
    pdfEventBus: pdfEventBus ?? undefined,
  });
}

init().catch((e) => {
  console.error("[thilko/pdf-viewer] init failed", e);
});
