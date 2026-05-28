/**
 * Selection-toolbar trigger.
 *
 * Listens for `selectionchange` on document and decides whether the floating
 * toolbar should be shown for the current selection.
 *
 * Suppression rules (plan §6 M4 step 1):
 *   - Selection inside <input>, <textarea>, [contenteditable] → suppress.
 *   - Selection inside any Thilko shadow host (toolbar/popover itself) → suppress.
 *   - Selection text length < MIN_CHARS → suppress.
 *   - Selection collapsed → suppress.
 *   - Selection has no client rect (off-screen) → suppress.
 *
 * The toolbar is hidden during active selection (mouse-down on host page) and
 * shown when the user releases. We do this by debouncing `selectionchange`
 * with a small idle window, and by suppressing while the host page reports a
 * primary pointer button is pressed.
 */

import { isInsideThilkoUi } from "../ui/shadow-mount.js";
import { rangeAnchorRect } from "../ui/positioning.js";

export interface SelectionState {
  range: Range;
  text: string;
}

export interface TriggerOptions {
  /** Minimum selection length for the toolbar to appear. */
  minChars?: number;
  /** Idle ms after selectionchange before notifying — gives the user time to finish dragging. */
  settleMs?: number;
  /** Called when the current selection should show the toolbar. */
  onShow: (state: SelectionState) => void;
  /** Called when the toolbar should hide (selection cleared or suppressed). */
  onHide: () => void;
}

const DEFAULT_MIN_CHARS = 3;
const DEFAULT_SETTLE_MS = 180;

export interface SelectionTriggerHandle {
  destroy: () => void;
  /** Currently-shown selection, if any. */
  current: () => SelectionState | null;
  /** Force a re-evaluation (useful when something programmatic might have changed the selection). */
  reevaluate: () => void;
}

export function installSelectionTrigger(opts: TriggerOptions): SelectionTriggerHandle {
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;

  let pointerDown = false;
  let settleTimer: number | null = null;
  let currentlyShown: SelectionState | null = null;

  const onPointerDown = (e: PointerEvent) => {
    // Mouse drag, touch drag, pen drag — all defer evaluation until release.
    if (e.button !== undefined && e.button !== 0) return; // ignore right-clicks for drag tracking
    if (isInsideThilkoUi(e.target as Node)) return; // user is interacting with our UI
    pointerDown = true;
    // Hide while the user is actively dragging to select.
    if (currentlyShown) {
      currentlyShown = null;
      opts.onHide();
    }
  };

  const onPointerUp = () => {
    pointerDown = false;
    // Defer slightly so selectionchange has time to coalesce.
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = self.setTimeout(evaluate, settleMs);
  };

  const onSelectionChange = () => {
    if (pointerDown) return; // wait for release
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = self.setTimeout(evaluate, settleMs);
  };

  const onScroll = () => {
    // Selection coords change as the page scrolls; if shown, we just hide.
    if (currentlyShown) {
      currentlyShown = null;
      opts.onHide();
    }
  };

  const onKeydown = (e: KeyboardEvent) => {
    // Escape clears the selection (and our toolbar).
    if (e.key === "Escape" && currentlyShown) {
      currentlyShown = null;
      opts.onHide();
    }
  };

  const evaluate = () => {
    settleTimer = null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (currentlyShown) {
        currentlyShown = null;
        opts.onHide();
      }
      return;
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      if (currentlyShown) {
        currentlyShown = null;
        opts.onHide();
      }
      return;
    }
    const text = range.toString();
    if (text.trim().length < minChars) {
      if (currentlyShown) {
        currentlyShown = null;
        opts.onHide();
      }
      return;
    }
    if (rangeIntersectsEditable(range) || rangeIntersectsThilkoUi(range)) {
      if (currentlyShown) {
        currentlyShown = null;
        opts.onHide();
      }
      return;
    }
    // Geometry check — selection with no on-screen rect (offscreen scroll,
    // display:none container, etc.) can't be anchored to a toolbar position.
    if (!rangeAnchorRect(range)) {
      if (currentlyShown) {
        currentlyShown = null;
        opts.onHide();
      }
      return;
    }
    const state: SelectionState = { range, text };
    currentlyShown = state;
    opts.onShow(state);
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  // Touch users may release outside the document (e.g., into the toolbar);
  // pointerup on window catches those.
  window.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  document.addEventListener("keydown", onKeydown, true);

  return {
    destroy: () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeydown, true);
      if (currentlyShown) {
        currentlyShown = null;
        opts.onHide();
      }
    },
    current: () => currentlyShown,
    reevaluate: evaluate,
  };
}

function rangeIntersectsEditable(range: Range): boolean {
  return ancestorMatches(range.startContainer, isEditable) || ancestorMatches(range.endContainer, isEditable);
}

function rangeIntersectsThilkoUi(range: Range): boolean {
  return isInsideThilkoUi(range.startContainer) || isInsideThilkoUi(range.endContainer);
}

function isEditable(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // Some libraries use role="textbox" on a div.
  if (el.getAttribute?.("role") === "textbox") return true;
  return false;
}

function ancestorMatches(node: Node | null, predicate: (el: Element) => boolean): boolean {
  let n: Node | null = node;
  while (n) {
    if (n instanceof Element && predicate(n)) return true;
    n = n.parentNode;
  }
  return false;
}

/** Pull the current Range + text out of the live Selection. Useful for keyboard shortcuts. */
export function readCurrentSelection(minChars: number = DEFAULT_MIN_CHARS): SelectionState | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const text = range.toString();
  if (text.trim().length < minChars) return null;
  if (rangeIntersectsEditable(range) || rangeIntersectsThilkoUi(range)) return null;
  if (!rangeAnchorRect(range)) return null;
  return { range, text };
}
