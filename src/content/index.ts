/**
 * Content script entry — M3.
 *
 * Lifecycle on document_idle:
 *   1. Activation gate: protocol + top-frame + user-configured exclusion list
 *      + localhostEnabled. Skips silently if any check fails.
 *   2. Compute the canonical article URL and derive articleId locally —
 *      sha256(canonicalUrl) — matches the proxy. Avoids triggering ingestion
 *      just to read existing highlights.
 *   3. List existing highlights from the proxy.
 *   4. Anchor ALL highlights against the clean DOM (no rendering yet), then
 *      render survivors as a separate pass. This is critical: rendering
 *      injects <mark> + a marker button into the text stream; doing it
 *      between matches would poison subsequent anchorings.
 *   5. For unmatched highlights: if the page might still be loading (SPA),
 *      retry with a MutationObserver up to N attempts before persisting
 *      orphan state. This avoids false-orphaning JS-rendered articles.
 *   6. Fetch comment + thread counts (two batched RPCs) and update marker
 *      icons.
 *   7. Expose a dev API on `window` via a main-world bridge so the user can
 *      drive M3 acceptance from the default page console.
 */

import styleSheetCss from "./anchor/styles.css?inline";
import {
  anchorFromRange,
  rangeFromAnchor,
  type AnchorMatchResult,
} from "./anchor/html-anchor.js";
import { anchorPdfFromRange } from "./anchor/pdf-anchor.js";
import {
  ensureStylesInjected,
  renderHighlight,
  type MarkerCounts,
  type RenderedHighlight,
} from "./anchor/render.js";
import { deriveArticleId } from "../shared/url.js";
import { extractArticleMetadata } from "../shared/article-detector.js";
import {
  type Anchor,
  type Comment,
  type Highlight,
  type Thread,
} from "../shared/types.js";
import { type RpcRequest, type RpcResponse } from "../shared/messages.js";
import { installSelectionTrigger, type SelectionState, type SelectionTriggerHandle } from "./selection-toolbar/trigger.js";
import { installShortcuts, type ShortcutsHandle } from "./selection-toolbar/shortcuts.js";
import { mountSelectionToolbar, type ToolbarMountHandle } from "./selection-toolbar/mount.js";
import {
  closeAllPopovers,
  closePopover,
  findHighlightAnchorRect,
  openPopover,
  rectForRange,
} from "./popover-manager.js";
import { mountSidebar, type SidebarMountHandle } from "./sidebar/sidebar-mount.js";
import { buildSidebarState } from "./sidebar/sidebar-state.js";
import { buildMemorySummary, type SummaryHighlightItem } from "../shared/memory-summary.js";
import { openWithClaude } from "../shared/claude-handoff.js";

/**
 * Safe subset of settings the content script may read. The proxy secret + URL
 * + slot live ONLY in the background SW; the content script never sees them.
 */
interface ContentActivationSettings {
  configured: boolean;
  exclusionDomains: string[];
  localhostEnabled: boolean;
  devMode: boolean;
  /** When false (default), highlights are local-only until the user adds a
   *  comment or sends an AI message. */
  autoPersistHighlights: boolean;
}

// ── Activation ──────────────────────────────────────────────────────────────

async function checkActivation(): Promise<
  { ok: true; settings: ContentActivationSettings } | { ok: false; reason: string }
> {
  const protocol = location.protocol;
  const isTopFrame = window.self === window.top;
  const hostname = location.hostname;

  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, reason: `Unsupported protocol ${protocol}` };
  }
  if (!isTopFrame) {
    return { ok: false, reason: "Embedded frame (M3 only activates on top-level documents)" };
  }

  // Background RPC returns only safe activation fields (no proxy secret).
  let settings: ContentActivationSettings;
  try {
    settings = await rpc<ContentActivationSettings>({ kind: "getActivationSettings" });
  } catch (e) {
    return { ok: false, reason: `Could not load activation settings: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!settings.configured) {
    return { ok: false, reason: "Extension is not configured" };
  }

  if (isLocalhost(hostname) && !settings.localhostEnabled) {
    return { ok: false, reason: "localhost is disabled in extension settings" };
  }

  if (matchesExclusionList(hostname, settings.exclusionDomains)) {
    return { ok: false, reason: `Hostname ${hostname} is in the exclusion list` };
  }

  return { ok: true, settings };
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  );
}

function matchesExclusionList(hostname: string, exclusions: string[]): boolean {
  for (const rule of exclusions) {
    const r = rule.trim().toLowerCase();
    if (r.length === 0) continue;
    if (hostname === r) return true;
    if (hostname.endsWith(`.${r}`)) return true;
  }
  return false;
}

// ── Background RPC ──────────────────────────────────────────────────────────

async function rpc<T>(req: RpcRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(req)) as RpcResponse | undefined;
  if (!r) throw new Error("Background SW did not respond");
  if (!r.ok) {
    const err = new Error(`${r.error.code}: ${r.error.message}`);
    (err as Error & { code?: string }).code = r.error.code;
    throw err;
  }
  return r.data as T;
}

// ── Page state ──────────────────────────────────────────────────────────────

interface PageContext {
  canonicalUrl: string;
  articleId: string;
  title: string;
  looksLikeArticle: boolean;
}

type MatchStrategy = Extract<AnchorMatchResult, { kind: "found" }>["strategy"];

interface RenderedRecord {
  highlight: Highlight;
  rendered: RenderedHighlight | null;
  orphan: boolean;
  /** strategy of the successful match, for diagnostics. */
  matchStrategy: MatchStrategy | null;
}

const state = {
  context: null as PageContext | null,
  /** "html" for normal web pages, "pdf" for the chrome-extension PDF viewer. */
  contentType: "html" as "html" | "pdf",
  /** True iff the user has opted into eager highlight persistence. When false,
   *  highlights stay local-only until a comment / AI message attaches. */
  autoPersistHighlights: false,
  records: new Map<string, RenderedRecord>(),
  commentCounts: new Map<string, number>(),
  threadCounts: new Map<string, number>(),
  /**
   * Latest server-side comments/threads for THIS article. Used by the sidebar
   * to render previews. Kept in sync with refreshAllMarkerCounts (which now
   * also pushes a snapshot to the sidebar).
   */
  comments: [] as Comment[],
  threads: [] as Thread[],
  /**
   * Per-highlight persist promises. Resolved entries mean "this highlight
   * lives on the proxy"; absence means "local-only, hasn't been saved yet".
   * `ensureHighlightPersisted` reads + populates this map idempotently — so
   * even concurrent callers (e.g. user adds a comment AND fires an Ask
   * Dabbis-AI thread in quick succession) all await the same createHighlight
   * round-trip.
   */
  pendingPersists: new Map<string, Promise<void>>(),
};

/**
 * Lazily persist a local highlight to Supermemory. Idempotent: returns the
 * cached promise if one is in flight or has already resolved. Throws if the
 * record isn't in state.records or if the create fails (caller decides how
 * to surface the error to the user).
 *
 * Used by both the comment flow (popover-manager.handleCreateComment) and
 * the Ask Dabbis-AI flow (ThreadView draft-mode send) to make sure the
 * highlight exists on the server BEFORE the attached content is written —
 * otherwise we'd strand orphan comments / threads referencing a customId
 * that doesn't resolve.
 */
async function ensureHighlightPersisted(highlightId: string): Promise<void> {
  const cached = state.pendingPersists.get(highlightId);
  if (cached) return cached;

  const rec = state.records.get(highlightId);
  if (!rec) throw new Error(`Internal: no local record for highlight ${highlightId}`);
  const ctx = state.context;
  if (!ctx) throw new Error("Internal: no page context");

  const promise = (async () => {
    try {
      await rpc({
        kind: "ensureArticle",
        url: ctx.canonicalUrl,
        title: ctx.title,
        contentType: state.contentType,
      });
    } catch (e) {
      // ensureArticle is best-effort here; createHighlight below can still
      // succeed because Supermemory indexes the article+highlight independently.
      log("ensureArticle failed (lazy persist)", e);
    }
    await rpc<{ highlight: Highlight }>({
      kind: "createHighlight",
      id: highlightId,
      articleId: rec.highlight.articleId,
      anchor: rec.highlight.anchor,
    });
  })();

  state.pendingPersists.set(highlightId, promise);
  try {
    await promise;
  } catch (e) {
    // Failed — let the next attempt re-create, don't pin the rejected promise.
    state.pendingPersists.delete(highlightId);
    throw e;
  }
}

/**
 * Delete a highlight everywhere: server (best-effort), DOM (unrender the
 * <mark>), and in-memory state. Closes the popover and refreshes the sidebar.
 * Used by the popover's overflow-menu "Delete highlight" action.
 *
 * Best-effort on the server: if the highlight was never persisted (local-only
 * in lazy-persist mode) OR the proxy returns 404, we still proceed with local
 * cleanup — keeping a stale local marker would be worse UX than a phantom
 * server delete.
 */
async function deleteHighlightLocally(highlightId: string): Promise<void> {
  const rec = state.records.get(highlightId);
  // Server delete only makes sense if we know the highlight made it there.
  // pendingPersists has a resolved entry for persisted highlights (live or
  // pre-loaded from listHighlights).
  if (state.pendingPersists.has(highlightId)) {
    try {
      await rpc({ kind: "deleteHighlight", id: highlightId });
    } catch (e) {
      log("deleteHighlight RPC failed (continuing with local cleanup)", e);
    }
  }
  rec?.rendered?.unrender();
  state.records.delete(highlightId);
  state.commentCounts.delete(highlightId);
  state.threadCounts.delete(highlightId);
  state.pendingPersists.delete(highlightId);
  closePopover(highlightId);
  notifySidebar();
}

/**
 * Push a fresh SidebarState into the mounted sidebar after any state mutation.
 * Safe to call even when the sidebar isn't open — the manager re-renders the
 * toggle button (badge count) and stays mute about the panel.
 */
function notifySidebar(): void {
  if (!sidebar) return;
  const ctx = state.context;
  if (!ctx) return;
  sidebar.setState(
    buildSidebarState({
      articleTitle: ctx.title,
      articleUrl: ctx.canonicalUrl,
      records: state.records as unknown as Parameters<typeof buildSidebarState>[0]["records"],
      comments: state.comments,
      threads: state.threads,
    }),
  );
}

// ── Marker click → open popover anchored to that highlight. ───────────────

function broadcastMarkerClick(highlightId: string): void {
  // Still dispatch for downstream listeners that may want to observe.
  document.dispatchEvent(new CustomEvent("thilko:marker-click", { detail: { highlightId } }));
  void openPopoverForHighlight(highlightId);
}

/**
 * Capture the user's text selection as an Anchor of the right type for the
 * current page context (HTML or PDF). PDF anchors additionally carry page
 * number + intra-page offset for future fast-path recovery.
 */
async function captureAnchor(range: Range): Promise<Anchor | null> {
  if (state.contentType === "pdf") return anchorPdfFromRange(range);
  return anchorFromRange(range);
}

async function openPopoverForHighlight(highlightId: string): Promise<void> {
  const rec = state.records.get(highlightId);
  const ctx = state.context;
  if (!rec || !ctx) return;
  const seed = seedFromState(highlightId);
  await openPopover({
    highlight: rec.highlight,
    articleTitle: ctx.title,
    articleContext: buildArticleContext(ctx),
    initialState: seed,
    startWithFreshThread: seed.threads.length > 0,
    ensureHighlightPersisted: () => ensureHighlightPersisted(highlightId),
    onDeleteRequested: () => deleteHighlightLocally(highlightId),
    onCountsChange: (counts) => updateMarkerForHighlight(highlightId, counts),
  });
}

/**
 * Build the popover's `initialState` from already-cached data so opening an
 * EXISTING highlight (sidebar row click, marker click) doesn't need to wait
 * on listComments + listThreads round-trips. state.comments and state.threads
 * are kept in sync with the server by refreshAllMarkerCounts; filtering them
 * by highlightId is free.
 *
 * The popover-manager skips its usual RPC pair when `initialState` is
 * supplied — but still fires a background refresh after mount to pick up
 * any out-of-band writes (another tab editing the same highlight, etc).
 */
function seedFromState(highlightId: string): { comments: Comment[]; threads: Thread[] } {
  const comments = state.comments.filter((c) => c.highlightId === highlightId);
  const threads = state.threads.filter((t) => t.highlightId === highlightId);
  return { comments, threads };
}

/**
 * Extract the article context used for AI per-turn prompts. v1 uses the
 * document.body innerText as the excerpt — assembleContext truncates if
 * needed. M5+ may refine to use a Readability-style extraction.
 */
function buildArticleContext(ctx: PageContext): { title: string; url: string; excerpt: string } {
  const excerpt = document.body?.innerText ?? "";
  return { title: ctx.title, url: ctx.canonicalUrl, excerpt };
}

/**
 * Look up the CURRENT rendered record (not whatever was captured at popover
 * creation time) and update its marker. Safe across re-anchoring passes that
 * destroy + recreate the RenderedHighlight for this id.
 */
function updateMarkerForHighlight(highlightId: string, counts: { comments: number; threads: number }): void {
  state.commentCounts.set(highlightId, counts.comments);
  state.threadCounts.set(highlightId, counts.threads);
  const rec = state.records.get(highlightId);
  rec?.rendered?.updateMarker(counts);
  // Sidebar previews/counts may have changed too; do a lightweight refetch.
  // refreshAllMarkerCounts already triggers notifySidebar at the end.
  refreshAllMarkerCounts().catch((e) => log("notifySidebar refresh failed", e));
}

// ── Core flow ───────────────────────────────────────────────────────────────

async function initPage(): Promise<void> {
  const gate = await checkActivation();
  if (!gate.ok) {
    log(`activation skipped: ${gate.reason}`);
    return;
  }

  const meta = extractArticleMetadata(document);
  const { canonical, articleId } = await deriveArticleId(location.href);
  await bootLifecycle({
    context: {
      canonicalUrl: canonical,
      articleId,
      title: meta.title,
      looksLikeArticle: meta.looksLikeArticle,
    },
    contentType: "html",
    enableDevBridge: gate.settings.devMode,
    autoPersistHighlights: gate.settings.autoPersistHighlights,
  });
}

/**
 * Shared lifecycle setup used by both the HTML content script (M3+) and the
 * PDF viewer (M8). Mounts selection toolbar + sidebar + popover manager,
 * loads existing highlights for the article, and schedules the SPA-aware
 * orphan stabilization pass.
 *
 * Caller is responsible for ensuring `ctx.canonicalUrl` and `ctx.articleId`
 * match the article being viewed (NOT the chrome-extension page URL for the
 * PDF viewer case).
 */
export async function bootLifecycle(opts: {
  context: PageContext;
  contentType: "html" | "pdf";
  enableDevBridge?: boolean;
  /** Mirrors the user setting; when true, toolbar actions persist immediately. */
  autoPersistHighlights?: boolean;
}): Promise<void> {
  state.context = opts.context;
  state.contentType = opts.contentType;
  state.autoPersistHighlights = opts.autoPersistHighlights ?? false;

  ensureStylesInjected(styleSheetCss);
  if (opts.enableDevBridge) {
    installMainWorldDevBridge();
    log("devMode is ON — window.__thilko_dev is exposed to this page. Disable in extension Options for safety.");
  }

  installSelectionUi();
  installSidebar();

  await loadAndRenderExistingHighlights({ allowOrphanPersist: false });

  // Schedule a stabilization pass: if content arrives after document_idle
  // (SPA hydration, lazy-loaded PDF pages, etc.), a MutationObserver fires
  // and re-attempts anchoring orphans for up to ~6s before persisting their
  // orphaned state.
  scheduleOrphanStabilization();

  // Auto-jump: if the URL has #thilko=<highlight-id>, scroll + open it. We do
  // this AFTER initial render so the mark exists in the DOM; the stabilization
  // pass above will catch the case where the highlight only re-anchors later
  // (it dispatches a "thilko:loaded" event that we also listen to).
  maybeAutoJumpFromHash();
}

// ── Selection toolbar + keyboard shortcuts ─────────────────────────────────

let toolbar: ToolbarMountHandle | null = null;
let selectionTrigger: SelectionTriggerHandle | null = null;
let shortcuts: ShortcutsHandle | null = null;

function installSelectionUi(): void {
  toolbar = mountSelectionToolbar({
    onComment: handleToolbarComment,
    onAskAi: handleToolbarAskAi,
  });

  selectionTrigger = installSelectionTrigger({
    onShow: (state) => toolbar?.show(state),
    onHide: () => toolbar?.hide(),
  });

  shortcuts = installShortcuts({
    onComment: handleToolbarComment,
    onAskAi: handleToolbarAskAi,
  });
}

/** Tear down all M4 UI surfaces. Safe to call multiple times. */
export function teardownSelectionUi(): void {
  selectionTrigger?.destroy();
  selectionTrigger = null;
  shortcuts?.destroy();
  shortcuts = null;
  toolbar?.destroy();
  toolbar = null;
  closeAllPopovers();
  sidebar?.destroy();
  sidebar = null;
  if (sidebarShortcutHandler) {
    document.removeEventListener("keydown", sidebarShortcutHandler, true);
    sidebarShortcutHandler = null;
  }
}

// ── Sidebar (M6) ────────────────────────────────────────────────────────────

let sidebar: SidebarMountHandle | null = null;
let sidebarShortcutHandler: ((e: KeyboardEvent) => void) | null = null;

function installSidebar(): void {
  sidebar = mountSidebar({
    onNoteClick: (highlightId) => {
      void openHighlightFromSidebar(highlightId);
    },
    onSendArticleToClaude: () => sendArticleToClaude(),
  });
  // Push current snapshot now so the toggle button appears immediately if
  // there's already at least one rendered highlight on the page.
  notifySidebar();

  // Cmd/Ctrl+Shift+S toggles the sidebar. Suppress when the keydown originates
  // from an editable host or Thilko's own UI (same rules as the toolbar
  // shortcut) so it doesn't steal focus from the user's typing.
  sidebarShortcutHandler = (e: KeyboardEvent) => {
    if (!e.shiftKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key.toLowerCase() !== "s") return;
    if (isFromEditableOrThilkoUi(e)) return;
    e.preventDefault();
    e.stopPropagation();
    sidebar?.toggle();
  };
  document.addEventListener("keydown", sidebarShortcutHandler, true);
}

function isFromEditableOrThilkoUi(e: KeyboardEvent): boolean {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    if (node.classList.contains("thilko-root")) return true;
    const tag = node.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if ((node as HTMLElement).isContentEditable) return true;
    if (node.getAttribute("role") === "textbox") return true;
  }
  return false;
}

/**
 * Sidebar "Open article in Claude" handler — assembles a SummaryArticleScope
 * from authoritative in-memory state (records + comments + threads) and
 * hands off via clipboard + new tab. Lives in content/index because that's
 * where the source-of-truth state lives.
 */
async function sendArticleToClaude(): Promise<{ clipboardOk: boolean; tabOk: boolean }> {
  const ctx = state.context;
  if (!ctx) return { clipboardOk: false, tabOk: false };
  const commentsByHl = new Map<string, Comment[]>();
  for (const c of state.comments) {
    const arr = commentsByHl.get(c.highlightId);
    if (arr) arr.push(c);
    else commentsByHl.set(c.highlightId, [c]);
  }
  const threadsByHl = new Map<string, Thread[]>();
  for (const t of state.threads) {
    const arr = threadsByHl.get(t.highlightId);
    if (arr) arr.push(t);
    else threadsByHl.set(t.highlightId, [t]);
  }
  // Order: live highlights first (by createdAt asc), then orphans (newest first).
  const live: SummaryHighlightItem[] = [];
  const orphans: SummaryHighlightItem[] = [];
  for (const rec of state.records.values()) {
    const item: SummaryHighlightItem = {
      quote: rec.highlight.anchor.quote.exact,
      createdAt: rec.highlight.createdAt,
      orphaned: rec.highlight.orphaned,
      comments: (commentsByHl.get(rec.highlight.id) ?? []).map((c) => ({ text: c.text, createdAt: c.createdAt })),
      threads: (threadsByHl.get(rec.highlight.id) ?? []).map((t) => ({
        lastMessageAt: t.lastMessageAt,
        messages: t.messages.map((m) => ({ role: m.role, content: m.content })),
      })),
    };
    if (rec.rendered) live.push(item);
    else orphans.push(item);
  }
  live.sort((a, b) => a.createdAt - b.createdAt);
  orphans.sort((a, b) => b.createdAt - a.createdAt);
  const summary = buildMemorySummary({
    kind: "article",
    article: { title: ctx.title || "(untitled)", canonicalUrl: ctx.canonicalUrl },
    highlights: [...live, ...orphans],
  });
  const result = await openWithClaude(summary);
  if (!result.clipboardOk || !result.tabOk) {
    log(`Open-with-Claude partial: clipboard=${result.clipboardOk} tab=${result.tabOk}`);
  }
  return result;
}

/**
 * URL-hash auto-jump: when the active URL ends with `#thilko=<highlight-id>`,
 * scroll to and open that highlight after the initial anchor pass. Used by
 * "↗ Open article" links in the library so clicking from there lands on the
 * specific note rather than the article's top.
 *
 * - Idempotent: we only fire once per page, even if hashchange events fire
 *   later (those route through navigation, which we don't touch).
 * - Tolerant: if the highlight hasn't anchored yet (still rendering), we
 *   register a one-shot listener and retry once orphan stabilization runs.
 * - We do NOT clear the hash from the URL — the user may want to share the
 *   deep link by copying the address bar.
 */
let autoJumpedHighlightId: string | null = null;

function parseHighlightIdFromHash(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  // Tolerate `#thilko=<id>` or `#thilko=<id>&extra=x` — match conservatively.
  const m = /^#thilko=([0-9a-fA-F-]{16,})/.exec(hash);
  return m && m[1] ? m[1] : null;
}

function maybeAutoJumpFromHash(): void {
  const id = parseHighlightIdFromHash(location.hash);
  if (!id) return;
  if (autoJumpedHighlightId === id) return; // already handled this page-load
  attemptAutoJump(id, /*attempt*/ 0);
}

function attemptAutoJump(highlightId: string, attempt: number): void {
  const rec = state.records.get(highlightId);
  if (rec) {
    autoJumpedHighlightId = highlightId;
    void openHighlightFromSidebar(highlightId);
    return;
  }
  // Not anchored yet — retry on a short ladder that overlaps with the orphan
  // stabilization window (~6s). After the budget, give up silently.
  if (attempt >= 6) return;
  window.setTimeout(() => attemptAutoJump(highlightId, attempt + 1), 1000);
}

/**
 * Smooth-scroll to a highlight's <mark>, flash it briefly to draw the eye,
 * then open the popover. Orphans have no mark — we just open the popover.
 */
async function openHighlightFromSidebar(highlightId: string): Promise<void> {
  const rec = state.records.get(highlightId);
  if (!rec) return;
  const ctx = state.context;
  if (!ctx) return;

  // Both the sidebar AND the popover live on the right edge of the viewport
  // — they fight for the same screen real estate. Close the sidebar first
  // so the popover that's about to mount has a clean spatial slot, and the
  // user can actually read the conversation they just asked for. The
  // floating sidebar-toggle button stays visible (in the bottom-right) so
  // they can re-open the list any time.
  sidebar?.setOpen(false);

  const mark = rec.rendered ? lastMarkForHighlight(highlightId) : null;
  if (mark) {
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
    mark.classList.add("thilko-hl-flash");
    window.setTimeout(() => mark.classList.remove("thilko-hl-flash"), 1100);
    // Don't await the scroll settling — the popover is pinned to the
    // viewport's right edge regardless of mark position, so it can mount
    // immediately while scroll completes underneath. This shaves ~400ms
    // off the perceived open latency.
  }

  const seed = seedFromState(highlightId);
  await openPopover({
    highlight: rec.highlight,
    articleTitle: ctx.title,
    articleContext: buildArticleContext(ctx),
    initialState: seed,
    startWithFreshThread: seed.threads.length > 0,
    anchorRect: mark ? undefined : undefined, // let manager pull fresh rect after scroll settle
    ensureHighlightPersisted: () => ensureHighlightPersisted(highlightId),
    onDeleteRequested: () => deleteHighlightLocally(highlightId),
    onCountsChange: (counts) => updateMarkerForHighlight(highlightId, counts),
  });
}

function waitForScrollSettle(target: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const FALLBACK_MS = 400;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      target.ownerDocument.removeEventListener("scrollend", onScrollEnd, true);
      resolve();
    };
    const onScrollEnd = () => finish();
    // `scrollend` is fairly new; not all browsers support it. The timeout is
    // the safety net.
    target.ownerDocument.addEventListener("scrollend", onScrollEnd, { once: true, capture: true });
    window.setTimeout(finish, FALLBACK_MS);
  });
}

function lastMarkForHighlight(highlightId: string): HTMLElement | null {
  const marks = document.querySelectorAll<HTMLElement>(
    `mark.thilko-hl[data-thilko-id="${highlightId.replace(/"/g, '\\"')}"]`,
  );
  if (marks.length === 0) return null;
  return marks[marks.length - 1] ?? null;
}

async function handleToolbarComment(sel: SelectionState): Promise<void> {
  const ctx = state.context;
  if (!ctx) return;

  // 1) Synchronous: describe the anchor BEFORE we lose the Range to a DOM
  //    mutation. captureAnchor awaits internally but completes within a
  //    microtask for typical content; no network involved.
  const anchor = await captureAnchor(sel.range);
  if (!anchor) {
    log("could not describe selection as anchor");
    return;
  }

  // 2) Synchronous: clear the page selection + hide the toolbar so the user
  //    gets immediate visual confirmation that the click registered.
  window.getSelection()?.removeAllRanges();
  toolbar?.hide();

  // 3) Synchronous: generate the highlight ID client-side. The proxy accepts
  //    pre-supplied IDs (validated against ID_RE), so the same UUID we render
  //    against locally is the one persisted to Supermemory — no swap dance,
  //    no race with the network response.
  const highlightId = crypto.randomUUID();
  const now = Date.now();
  const localHighlight: Highlight = {
    id: highlightId,
    articleId: ctx.articleId,
    anchor,
    topicIds: [],
    createdAt: now,
    updatedAt: now,
    orphaned: false,
    ownerSlot: "", // backend fills this in; not used client-side
  };

  // 4) Synchronous: wrap the Range in <mark> + place marker. The captured
  //    Range from selectionState is still valid because no DOM mutation has
  //    happened yet.
  let rendered: RenderedHighlight | null = null;
  try {
    rendered = renderHighlight({
      highlightId,
      range: sel.range,
      counts: { comments: 0, threads: 0 },
      onMarkerClick: broadcastMarkerClick,
    });
  } catch (e) {
    log("instant highlight render failed", e);
    return;
  }
  state.records.set(highlightId, {
    highlight: localHighlight,
    rendered,
    orphan: false,
    matchStrategy: "exact",
  });
  // Tell the sidebar immediately so the new highlight shows up in the list
  // (and the toggle button's badge count) without waiting for the background
  // network round-trips below.
  notifySidebar();

  // 5) Synchronous: open the popover with empty seed state — no network.
  //    The popover-manager skips its usual listComments / listThreads round
  //    trips when initialState is supplied. Position over the now-rendered
  //    <mark> for visual continuity.
  const anchorRect = findHighlightAnchorRect(highlightId) ?? rectForRange(sel.range) ?? undefined;
  void openPopover({
    highlight: localHighlight,
    articleTitle: ctx.title,
    articleContext: buildArticleContext(ctx),
    focusOnMount: true,
    anchorRect,
    initialState: { comments: [], threads: [] },
    ensureHighlightPersisted: () => ensureHighlightPersisted(highlightId),
    onDeleteRequested: () => deleteHighlightLocally(highlightId),
    onCountsChange: (counts) => updateMarkerForHighlight(highlightId, counts),
  });

  // 6) Persist behavior depends on the autoPersistHighlights setting:
  //    - When true (legacy): persist eagerly in the background.
  //    - When false (default): the highlight stays local-only until the
  //      first comment or AI message attaches, at which point
  //      ensureHighlightPersisted() fires from inside the popover RPCs.
  if (state.autoPersistHighlights) {
    void ensureHighlightPersisted(highlightId).catch((e) => {
      log("eager createHighlight (Comment) failed", e);
      // Roll back the optimistic UI on hard failure.
      const rec = state.records.get(highlightId);
      rec?.rendered?.unrender();
      state.records.delete(highlightId);
      closePopover(highlightId);
      notifySidebar();
    });
  }
}

async function handleToolbarAskAi(sel: SelectionState): Promise<void> {
  // Same instant pattern as Comment: synchronously render highlight + open
  // popover; persist + start AI thread in background.
  const ctx = state.context;
  if (!ctx) return;
  const anchor = await captureAnchor(sel.range);
  if (!anchor) return;

  window.getSelection()?.removeAllRanges();
  toolbar?.hide();

  const highlightId = crypto.randomUUID();
  const now = Date.now();
  const localHighlight: Highlight = {
    id: highlightId,
    articleId: ctx.articleId,
    anchor,
    topicIds: [],
    createdAt: now,
    updatedAt: now,
    orphaned: false,
    ownerSlot: "",
  };

  let rendered: RenderedHighlight | null = null;
  try {
    rendered = renderHighlight({
      highlightId,
      range: sel.range,
      counts: { comments: 0, threads: 0 },
      onMarkerClick: broadcastMarkerClick,
    });
  } catch (e) {
    log("instant highlight render failed (Ask AI)", e);
    return;
  }
  state.records.set(highlightId, {
    highlight: localHighlight,
    rendered,
    orphan: false,
    matchStrategy: "exact",
  });
  notifySidebar();

  const anchorRect = findHighlightAnchorRect(highlightId) ?? rectForRange(sel.range) ?? undefined;
  void openPopover({
    highlight: localHighlight,
    articleTitle: ctx.title,
    articleContext: buildArticleContext(ctx),
    focusOnMount: false,
    startWithFreshThread: true,
    anchorRect,
    initialState: { comments: [], threads: [] },
    ensureHighlightPersisted: () => ensureHighlightPersisted(highlightId),
    onDeleteRequested: () => deleteHighlightLocally(highlightId),
    onCountsChange: (counts) => updateMarkerForHighlight(highlightId, counts),
  });

  // Lazy by default — the popover's first send / first comment triggers
  // ensureHighlightPersisted. When autoPersistHighlights is on, fire eagerly
  // to keep the legacy behavior.
  if (state.autoPersistHighlights) {
    void ensureHighlightPersisted(highlightId).catch((e) => {
      log("eager createHighlight (Ask AI) failed", e);
      const rec = state.records.get(highlightId);
      rec?.rendered?.unrender();
      state.records.delete(highlightId);
      closePopover(highlightId);
      notifySidebar();
    });
  }
}

async function persistHighlightFromSelection(sel: SelectionState): Promise<Highlight | null> {
  const anchor = await captureAnchor(sel.range);
  if (!anchor) {
    log("could not describe selection as anchor");
    return null;
  }
  return persistAndRender(anchor);
}

interface LoadOptions {
  /** Whether to persist `orphaned: true` to the backend when a highlight
   *  fails to anchor. The first pass runs with this false (so SPA-rendered
   *  pages don't get false-orphaned); the stabilization pass sets it true. */
  allowOrphanPersist: boolean;
}

async function loadAndRenderExistingHighlights(opts: LoadOptions): Promise<void> {
  const ctx = state.context;
  if (!ctx) return;

  let highlights: Highlight[];
  try {
    const result = await rpc<{ highlights: Highlight[] }>({
      kind: "listHighlights",
      articleId: ctx.articleId,
    });
    highlights = result.highlights;
  } catch (e) {
    log("listHighlights failed (likely unconfigured/down):", e);
    return;
  }

  if (highlights.length === 0) {
    log(`no existing highlights for article ${ctx.articleId.slice(0, 12)}…`);
    return;
  }
  log(`anchoring ${highlights.length} existing highlight(s)`);

  // Phase 1: clear any prior thilko DOM. apache-annotator's highlightText
  // mutated the text stream; we must start from a clean DOM before anchoring.
  for (const r of state.records.values()) r.rendered?.unrender();
  state.records.clear();

  // Phase 2: anchor ALL highlights against the clean DOM. No rendering yet.
  const matches = await Promise.all(
    highlights.map(async (h) => ({ highlight: h, result: await rangeFromAnchor(h.anchor) })),
  );

  // Phase 3: render all survivors in order.
  for (const { highlight, result } of matches) {
    let rendered: RenderedHighlight | null = null;
    let orphan = false;
    let matchStrategy: MatchStrategy | null = null;

    if (result.kind === "found") {
      try {
        rendered = renderHighlight({
          highlightId: highlight.id,
          range: result.range,
          counts: getCounts(highlight.id),
          onMarkerClick: broadcastMarkerClick,
        });
        matchStrategy = result.strategy;
      } catch (e) {
        log(`render failed for ${highlight.id.slice(0, 8)}:`, e);
        orphan = true;
      }
    } else {
      orphan = true;
      log(`anchor not found for ${highlight.id.slice(0, 8)}: ${result.reason}`);
    }

    state.records.set(highlight.id, {
      highlight: { ...highlight, orphaned: orphan },
      rendered,
      orphan,
      matchStrategy,
    });
    // Pre-populate pendingPersists with a resolved promise for any highlight
    // we loaded from the server. ensureHighlightPersisted then short-circuits
    // for these instead of trying to re-create them.
    state.pendingPersists.set(highlight.id, Promise.resolve());

    // Persist orphan flag transitions only if explicitly allowed (post-stabilization).
    if (opts.allowOrphanPersist && highlight.orphaned !== orphan) {
      try {
        await rpc({ kind: "updateHighlight", id: highlight.id, patch: { orphaned: orphan } });
        log(`persisted orphan=${orphan} for ${highlight.id.slice(0, 8)}`);
      } catch (e) {
        log(`orphan persist failed for ${highlight.id.slice(0, 8)}:`, e);
      }
    }
  }

  // Phase 4: refresh marker counts in batch.
  await refreshAllMarkerCounts();
}

/**
 * Some articles render their main content via JS after document_idle (SPAs,
 * lazy hydration). If any highlights orphaned on the first pass, give the
 * page a chance to settle: watch for DOM mutations and retry anchoring up
 * to a small number of times. Once stable (no new mutations for a beat) or
 * after a cap, persist orphan states.
 */
function scheduleOrphanStabilization(): void {
  const STABILIZE_MAX_RUNS = 5;
  const STABILIZE_SETTLE_MS = 800;
  const STABILIZE_DEADLINE_MS = 6000;

  let runs = 0;
  let pending: number | null = null;
  let deadline: number | null = null;
  let done = false;
  /**
   * Set to true while our own anchor/render is running so the MutationObserver
   * doesn't react to highlights we just rendered.
   */
  let thilkoMutating = false;
  const start = Date.now();

  const orphansLeft = (): number => {
    let n = 0;
    for (const r of state.records.values()) if (r.orphan) n++;
    return n;
  };

  const finalize = async (): Promise<void> => {
    if (done) return;
    done = true;
    if (pending !== null) clearTimeout(pending);
    if (deadline !== null) clearTimeout(deadline);
    obs.disconnect();
    try {
      thilkoMutating = true;
      // Final pass — actually persist orphan state this time.
      await loadAndRenderExistingHighlights({ allowOrphanPersist: true });
    } finally {
      thilkoMutating = false;
    }
  };

  const reattempt = async (): Promise<void> => {
    if (done) return;
    runs++;
    log(`stabilization re-attempt ${runs}/${STABILIZE_MAX_RUNS} (orphans: ${orphansLeft()})`);
    try {
      thilkoMutating = true;
      await loadAndRenderExistingHighlights({ allowOrphanPersist: false });
    } finally {
      thilkoMutating = false;
    }
    if (orphansLeft() === 0 || runs >= STABILIZE_MAX_RUNS) {
      await finalize();
    }
  };

  const obs = new MutationObserver(() => {
    if (done || thilkoMutating) return;
    if (Date.now() - start > STABILIZE_DEADLINE_MS) return; // deadline will fire
    if (pending !== null) clearTimeout(pending);
    pending = self.setTimeout(reattempt, STABILIZE_SETTLE_MS);
  });

  if (orphansLeft() === 0) return; // nothing to stabilize

  obs.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Hard deadline — single shot.
  deadline = self.setTimeout(() => {
    finalize().catch((e) => log("stabilization finalize failed", e));
  }, STABILIZE_DEADLINE_MS);
}

function getCounts(highlightId: string): MarkerCounts {
  return {
    comments: state.commentCounts.get(highlightId) ?? 0,
    threads: state.threadCounts.get(highlightId) ?? 0,
  };
}

async function refreshAllMarkerCounts(): Promise<void> {
  const ctx = state.context;
  if (!ctx) return;
  let comments: Comment[] = [];
  let threads: Thread[] = [];
  try {
    const cs = await rpc<{ comments: Comment[] }>({ kind: "listComments", articleId: ctx.articleId });
    comments = cs.comments;
  } catch (e) {
    log("listComments failed", e);
  }
  try {
    const ts = await rpc<{ threads: Thread[] }>({ kind: "listThreads", articleId: ctx.articleId });
    threads = ts.threads;
  } catch (e) {
    log("listThreads failed", e);
  }

  state.comments = comments;
  state.threads = threads;
  state.commentCounts.clear();
  state.threadCounts.clear();
  for (const c of comments) {
    state.commentCounts.set(c.highlightId, (state.commentCounts.get(c.highlightId) ?? 0) + 1);
  }
  for (const t of threads) {
    state.threadCounts.set(t.highlightId, (state.threadCounts.get(t.highlightId) ?? 0) + 1);
  }
  for (const rec of state.records.values()) {
    if (rec.rendered) rec.rendered.updateMarker(getCounts(rec.highlight.id));
  }
  notifySidebar();
}

// ── Dev API ─────────────────────────────────────────────────────────────────
//
// Content scripts run in an isolated JS world by default — `window` and
// document are shared with the page, but variable bindings are not. To make
// the dev API reachable from the page's default console (without users having
// to switch contexts), we inject a small <script> element that defines a
// global on the main world's window and uses postMessage to round-trip
// requests to us.

interface DevApiRequest {
  type: "thilko-dev-req";
  rid: number;
  method: string;
  args: unknown[];
}
interface DevApiResponse {
  type: "thilko-dev-res";
  rid: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const devApi = {
  async getContext(): Promise<PageContext | null> {
    return state.context;
  },
  async listLocalRecords(): Promise<Array<{ id: string; orphan: boolean; rendered: boolean; matchStrategy: unknown }>> {
    return Array.from(state.records.values()).map((r) => ({
      id: r.highlight.id,
      orphan: r.orphan,
      rendered: !!r.rendered,
      matchStrategy: r.matchStrategy,
    }));
  },
  async createHighlightFromSelection(): Promise<Highlight | null> {
    return createFromSelection();
  },
  async createHighlightFromQuote(input: { exact: string; prefix?: string; suffix?: string }): Promise<Highlight | null> {
    return createFromAnchorInput(input);
  },
  async refreshFromBackend(): Promise<void> {
    return loadAndRenderExistingHighlights({ allowOrphanPersist: true });
  },
  async refreshMarkerCounts(): Promise<void> {
    return refreshAllMarkerCounts();
  },
};

function installMainWorldDevBridge(): void {
  // Listen for requests from the page world.
  window.addEventListener("message", async (ev: MessageEvent<unknown>) => {
    if (ev.source !== window) return;
    const data = ev.data as DevApiRequest | undefined;
    if (!data || data.type !== "thilko-dev-req" || typeof data.rid !== "number" || typeof data.method !== "string") {
      return;
    }
    const method = devApi[data.method as keyof typeof devApi];
    let res: DevApiResponse;
    if (typeof method !== "function") {
      res = { type: "thilko-dev-res", rid: data.rid, ok: false, error: `Unknown method: ${data.method}` };
    } else {
      try {
        const result = await (method as (...args: unknown[]) => Promise<unknown>)(...(data.args ?? []));
        res = { type: "thilko-dev-res", rid: data.rid, ok: true, data: result };
      } catch (e) {
        res = { type: "thilko-dev-res", rid: data.rid, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    window.postMessage(res, "*");
  });

  // Inject the page-world shim. The shim defines window.__thilko_dev and routes
  // every method call through postMessage to the listener above.
  const script = document.createElement("script");
  script.id = "thilko-dev-bridge";
  script.textContent = `(() => {
    if (window.__thilko_dev) return;
    let nextRid = 1;
    const pending = new Map();
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.type !== "thilko-dev-res" || typeof d.rid !== "number") return;
      const p = pending.get(d.rid);
      if (!p) return;
      pending.delete(d.rid);
      if (d.ok) p.resolve(d.data);
      else p.reject(new Error(d.error || "thilko-dev error"));
    });
    function call(method, args) {
      return new Promise((resolve, reject) => {
        const rid = nextRid++;
        pending.set(rid, { resolve, reject });
        window.postMessage({ type: "thilko-dev-req", rid, method, args: args || [] }, "*");
      });
    }
    const proxy = {};
    for (const name of [
      "getContext",
      "listLocalRecords",
      "createHighlightFromSelection",
      "createHighlightFromQuote",
      "refreshFromBackend",
      "refreshMarkerCounts",
    ]) {
      proxy[name] = (...args) => call(name, args);
    }
    Object.defineProperty(window, "__thilko_dev", {
      value: proxy,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  })();`;
  (document.head ?? document.documentElement).appendChild(script);
  script.remove(); // Inline scripts execute synchronously on insertion; the proxy is now live.
}

async function createFromSelection(): Promise<Highlight | null> {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    log("no active selection");
    return null;
  }
  const range = sel.getRangeAt(0);
  const anchor = await anchorFromRange(range);
  if (!anchor) {
    log("could not describe selection as anchor");
    return null;
  }
  return persistAndRender(anchor);
}

async function createFromAnchorInput(input: { exact: string; prefix?: string; suffix?: string }): Promise<Highlight | null> {
  // Validate the anchor by resolving against the current DOM BEFORE persisting.
  // Refuse to create a record we can't render — that just produces orphan junk.
  const candidate: Anchor = {
    type: "html",
    quote: { exact: input.exact, prefix: input.prefix ?? "", suffix: input.suffix ?? "" },
  };
  const probe = await rangeFromAnchor(candidate);
  if (probe.kind !== "found") {
    log(`createFromAnchorInput: anchor does not resolve in current DOM (${probe.reason})`);
    return null;
  }
  // Re-derive the anchor from the resolved Range so we also capture textPosition.
  const enriched = await anchorFromRange(probe.range);
  return persistAndRender(enriched ?? candidate);
}

async function persistAndRender(anchor: Anchor): Promise<Highlight | null> {
  const ctx = state.context;
  if (!ctx) {
    log("no page context — cannot create highlight");
    return null;
  }

  try {
    await rpc({
      kind: "ensureArticle",
      url: ctx.canonicalUrl,
      title: ctx.title,
      contentType: state.contentType,
    });
  } catch (e) {
    log("ensureArticle failed", e);
    return null;
  }

  let created: Highlight;
  try {
    const r = await rpc<{ highlight: Highlight }>({
      kind: "createHighlight",
      articleId: ctx.articleId,
      anchor,
    });
    created = r.highlight;
  } catch (e) {
    log("createHighlight failed", e);
    return null;
  }

  // Anchor the newly-created highlight in isolation, then render. Same
  // anchor-then-render discipline as the bulk path.
  const result = await rangeFromAnchor(created.anchor);
  let rendered: RenderedHighlight | null = null;
  let orphan = false;
  let matchStrategy: RenderedRecord["matchStrategy"] = null as RenderedRecord["matchStrategy"];
  if (result.kind === "found") {
    try {
      rendered = renderHighlight({
        highlightId: created.id,
        range: result.range,
        counts: getCounts(created.id),
        onMarkerClick: broadcastMarkerClick,
      });
      matchStrategy = result.strategy as RenderedRecord["matchStrategy"];
    } catch (e) {
      log(`render failed for newly created highlight:`, e);
      orphan = true;
    }
  } else {
    log(`could not anchor newly created highlight: ${result.reason}`);
    orphan = true;
  }
  state.records.set(created.id, { highlight: { ...created, orphaned: orphan }, rendered, orphan, matchStrategy });
  await refreshAllMarkerCounts();
  return created;
}

function log(...args: unknown[]): void {
  console.log("[thilko]", ...args);
}

// ── Boot ────────────────────────────────────────────────────────────────────

initPage().catch((e) => log("init failed", e));
