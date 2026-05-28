/**
 * Manages popover lifecycles: open/close/get-or-create per highlightId.
 * Multiple popovers can coexist; each has its own shadow-DOM host on
 * document.body.
 *
 * The manager:
 *   - Owns mount/unmount of React roots inside shadow hosts.
 *   - Loads the initial comments + threads for a highlight before mounting.
 *   - Hands the popover component callbacks that talk to the typed RPC
 *     layer so the secret never crosses into the React tree.
 *   - Surfaces count changes back to the calling code (so M3's marker icons
 *     update in place).
 */

import { createElement } from "react";
import { mountInShadow, type ShadowMount } from "./ui/shadow-mount.js";
import { elementAnchorRect, placeNear, rangeAnchorRect, type AnchorRect } from "./ui/positioning.js";
import { Popover } from "./popover/popover.js";
import styleSheetCss from "./ui/styles.css?inline";
import { type Comment, type Highlight, type Thread } from "../shared/types.js";
import { type RpcRequest, type RpcResponse } from "../shared/messages.js";

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

export interface OpenPopoverOptions {
  highlight: Highlight;
  articleTitle: string;
  /** Source article context used to assemble AI per-turn prompts. */
  articleContext: { title: string; url: string; excerpt: string };
  focusOnMount?: boolean;
  /** Auto-open a fresh AI thread (Ask AI flow). */
  startWithFreshThread?: boolean;
  /**
   * Anchor for initial positioning. If omitted, the manager tries to find a
   * rendered <mark> for the highlight; if there's no rendered mark, the
   * popover opens centered.
   */
  anchorRect?: AnchorRect;
  /**
   * If supplied, the popover mounts IMMEDIATELY with this data — no
   * listComments/listThreads round-trips. Use when the caller already knows
   * what's attached (e.g. brand-new highlight from the selection toolbar has
   * neither comments nor threads). Manager still fires a background refresh
   * after mount to catch out-of-band writes.
   */
  initialState?: { comments: Comment[]; threads: Thread[] };
  /**
   * Idempotent promise that resolves when the highlight exists on the proxy.
   * In lazy-persist mode (default), this is called by the popover's first
   * createComment and by the draft-thread first send to flush the highlight
   * before its attached content. In eager mode, by the time this is invoked
   * the create has already happened, so it short-circuits via the cached
   * resolved promise.
   */
  ensureHighlightPersisted?: () => Promise<void>;
  /** Called when the user picks "Delete highlight" from the overflow menu.
   *  Owner must: best-effort RPC deleteHighlight if persisted, then unrender
   *  the <mark>, drop from in-memory state, and close the popover. */
  onDeleteRequested?: () => Promise<void>;
  /** Called when comment/thread counts change, so the marker icon can refresh. */
  onCountsChange?: (counts: { comments: number; threads: number }) => void;
}

interface ManagedPopover {
  highlightId: string;
  /** Set after async loads complete and the mount is created. While loading, `mount` is null. */
  mount: ShadowMount | null;
}

const open = new Map<string, ManagedPopover>();

/** Open (or bring forward) the popover for a highlight. Returns when mounted. */
export async function openPopover(opts: OpenPopoverOptions): Promise<void> {
  const existing = open.get(opts.highlight.id);
  if (existing) {
    // Already open OR in-flight — bring forward if mounted, otherwise let the
    // in-flight call finish and become the active popover.
    if (existing.mount) bringToFront(existing.mount.host);
    return;
  }

  // Reserve the slot BEFORE any await so a second openPopover call for the
  // same id during these RPCs short-circuits via the `existing` check above.
  const managed: ManagedPopover = { highlightId: opts.highlight.id, mount: null };
  open.set(opts.highlight.id, managed);

  // Load initial comments + threads, OR use the caller-provided seed.
  let initialComments: Comment[] = [];
  let initialThreads: Thread[] = [];
  if (opts.initialState) {
    initialComments = opts.initialState.comments;
    initialThreads = opts.initialState.threads;
  } else {
    try {
      const cs = await rpc<{ comments: Comment[] }>({ kind: "listComments", highlightId: opts.highlight.id });
      initialComments = cs.comments;
    } catch (e) {
      console.warn("[thilko] popover listComments failed", e);
    }
    try {
      const ts = await rpc<{ threads: Thread[] }>({ kind: "listThreads", highlightId: opts.highlight.id });
      initialThreads = ts.threads;
    } catch (e) {
      console.warn("[thilko] popover listThreads failed", e);
    }
  }

  // If someone closed us mid-fetch, abandon.
  if (open.get(opts.highlight.id) !== managed) return;

  // Compute initial position.
  // Pinned to the RIGHT edge of the viewport so the popover doesn't sit on
  // top of the text the user is reading. Vertically aligned with the
  // highlight (when we know its rect) so the user still has spatial sense
  // of which note this is — clamped into the viewport with a margin.
  const anchor =
    opts.anchorRect ??
    findHighlightAnchorRect(opts.highlight.id) ??
    null;

  const POPOVER_WIDTH = 380;
  const POPOVER_ESTIMATED_HEIGHT = 360;
  const MARGIN = 20;
  const left = Math.max(MARGIN, window.innerWidth - POPOVER_WIDTH - MARGIN);
  const desiredTop = anchor ? anchor.top - 8 : 80;
  const top = Math.max(
    MARGIN,
    Math.min(desiredTop, window.innerHeight - POPOVER_ESTIMATED_HEIGHT - MARGIN),
  );
  const placement = { top, left, placement: "right" as const };

  const mount = mountInShadow({
    styles: styleSheetCss,
    hostClasses: ["thilko-popover-host"],
    hostStyle: {
      width: `${POPOVER_WIDTH}px`,
      height: "auto",
      top: `${placement.top}px`,
      left: `${placement.left}px`,
    },
  });

  // RPC callbacks bound to this highlight.
  const handleCreateComment = async (input: { id: string; text: string }): Promise<Comment> => {
    // Lazy-persist: make sure the highlight itself exists on the proxy before
    // creating a comment that references it by id. ensureHighlightPersisted
    // is idempotent — pre-existing highlights resolve immediately.
    if (opts.ensureHighlightPersisted) {
      await opts.ensureHighlightPersisted();
    }
    const r = await rpc<{ comment: Comment }>({
      kind: "createComment",
      id: input.id,
      highlightId: opts.highlight.id,
      articleId: opts.highlight.articleId,
      text: input.text,
    });
    return r.comment;
  };
  const handleDeleteComment = async (id: string): Promise<void> => {
    await rpc({ kind: "deleteComment", id });
  };
  const handleReload = async (): Promise<{ comments: Comment[]; threads: Thread[] }> => {
    const [cs, ts] = await Promise.all([
      rpc<{ comments: Comment[] }>({ kind: "listComments", highlightId: opts.highlight.id }),
      rpc<{ threads: Thread[] }>({ kind: "listThreads", highlightId: opts.highlight.id }),
    ]);
    return { comments: cs.comments, threads: ts.threads };
  };

  managed.mount = mount;

  const close = () => closePopover(opts.highlight.id);

  mount.reactRoot.render(
    createElement(Popover, {
      highlight: opts.highlight,
      initialComments,
      initialThreads,
      articleTitle: opts.articleTitle,
      articleCanonicalUrl: opts.articleContext.url,
      articleContext: opts.articleContext,
      hostElement: mount.host,
      focusOnMount: opts.focusOnMount ?? false,
      startWithFreshThread: opts.startWithFreshThread ?? false,
      rpc: { createComment: handleCreateComment, deleteComment: handleDeleteComment, reload: handleReload },
      ensureHighlightPersisted: opts.ensureHighlightPersisted,
      onDeleteRequested: opts.onDeleteRequested,
      onClose: close,
      onCountsChange: opts.onCountsChange ?? (() => {}),
    }),
  );
}

export function closePopover(highlightId: string): void {
  const p = open.get(highlightId);
  if (!p) return;
  open.delete(highlightId);
  p.mount?.destroy();
}

export function closeAllPopovers(): void {
  for (const id of Array.from(open.keys())) closePopover(id);
}

export function isPopoverOpen(highlightId: string): boolean {
  return open.has(highlightId);
}

/** Looks up the LAST rendered <mark> for a highlight, returns its anchor rect, or null. */
export function findHighlightAnchorRect(highlightId: string): AnchorRect | null {
  const marks = document.querySelectorAll<HTMLElement>(
    `mark.thilko-hl[data-thilko-id="${escapeAttr(highlightId)}"]`,
  );
  if (marks.length === 0) return null;
  const last = marks[marks.length - 1];
  if (!last) return null;
  return elementAnchorRect(last);
}

/** Re-place a popover near a given DOM Range (e.g. fresh from selection). */
export function rectForRange(range: Range): AnchorRect | null {
  return rangeAnchorRect(range);
}

function bringToFront(host: HTMLElement): void {
  // We assign z-index inside the shadow's CSS, but at the host level the
  // browser still uses DOM order for siblings with the same z-index. Move
  // this host to the end so it visually overlaps any earlier popovers.
  if (host.parentNode) host.parentNode.appendChild(host);
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}
