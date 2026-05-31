/**
 * Compact in-document find bar for the Thilko PDF viewer.
 *
 * Driven by pdfjs's PDFFindController (instantiated in pdf-renderer.ts).
 * We don't reach into the controller directly — communication is via the
 * shared EventBus that PDFViewer + PDFFindController already use:
 *
 *   - DISPATCH `find` with state to start / continue / re-run a search.
 *   - LISTEN `updatefindcontrolstate` for found / not-found / wrapped /
 *     pending UI feedback and the live match counts.
 *   - LISTEN `updatefindmatchescount` for the current/total counter that
 *     updates progressively as later pages are scanned.
 *
 * Keyboard model: Cmd-F / Ctrl-F opens (and focuses); Esc closes; Enter
 * jumps to next; Shift-Enter jumps to prev. We swallow these keys only
 * when the find bar owns focus, so the rest of the viewer keeps working.
 */

import type { EventBus, PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";

// Match pdfjs's `FindState` enum values (FOUND=0, NOT_FOUND=1, WRAPPED=2, PENDING=3).
// We don't import the enum because it isn't part of the type-export surface.
const FIND_STATE_FOUND = 0;
const FIND_STATE_NOT_FOUND = 1;
const FIND_STATE_WRAPPED = 2;
const FIND_STATE_PENDING = 3;

interface MatchesCount {
  current: number;
  total: number;
}

interface FindControlState {
  state: number;
  previous?: boolean;
  matchesCount?: MatchesCount;
  rawQuery?: string;
}

interface FindMatchesCount {
  matchesCount: MatchesCount;
}

export interface InstallFindBarOptions {
  /** Stage element where the find bar is appended (positioned absolutely). */
  stage: HTMLElement;
  /** Same EventBus as PDFViewer / PDFFindController. */
  eventBus: EventBus;
  /** Passed so we could later expose paged-find APIs; currently unused. */
  findController: PDFFindController;
}

export interface FindBarHandle {
  open(): void;
  close(): void;
  destroy(): void;
}

export function installFindBar(opts: InstallFindBarOptions): FindBarHandle {
  const { stage, eventBus } = opts;

  // ── DOM ────────────────────────────────────────────────────────────────────
  const bar = document.createElement("div");
  bar.className = "thilko-find-bar";
  bar.setAttribute("role", "search");
  bar.setAttribute("aria-label", "Find in document");
  bar.hidden = true;

  const input = document.createElement("input");
  input.type = "search";
  input.className = "thilko-find-input";
  input.placeholder = "Find in document";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Find in document");

  const status = document.createElement("span");
  status.className = "thilko-find-status";
  status.setAttribute("aria-live", "polite");

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "thilko-find-btn";
  prevBtn.setAttribute("aria-label", "Previous match");
  prevBtn.title = "Previous (Shift+Enter)";
  prevBtn.textContent = "↑";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "thilko-find-btn";
  nextBtn.setAttribute("aria-label", "Next match");
  nextBtn.title = "Next (Enter)";
  nextBtn.textContent = "↓";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "thilko-find-btn thilko-find-close";
  closeBtn.setAttribute("aria-label", "Close find bar");
  closeBtn.title = "Close (Esc)";
  closeBtn.textContent = "×";

  bar.append(input, status, prevBtn, nextBtn, closeBtn);
  stage.appendChild(bar);

  // ── State ──────────────────────────────────────────────────────────────────
  let currentMatches: MatchesCount = { current: 0, total: 0 };

  function dispatchFind(type: "" | "again", findPrevious: boolean): void {
    eventBus.dispatch("find", {
      source: bar,
      type,
      query: input.value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }

  function renderStatus(state: FindControlState | null): void {
    bar.classList.remove("thilko-find-notfound", "thilko-find-wrapped");
    if (!input.value) {
      status.textContent = "";
      return;
    }
    if (state?.state === FIND_STATE_NOT_FOUND) {
      bar.classList.add("thilko-find-notfound");
      status.textContent = "Not found";
      return;
    }
    if (state?.state === FIND_STATE_PENDING) {
      status.textContent = "Searching…";
      return;
    }
    if (currentMatches.total === 0) {
      status.textContent = state?.state === FIND_STATE_PENDING ? "Searching…" : "";
      return;
    }
    if (state?.state === FIND_STATE_WRAPPED) {
      bar.classList.add("thilko-find-wrapped");
    }
    status.textContent = `${currentMatches.current} of ${currentMatches.total}`;
  }

  // ── Event subscriptions ────────────────────────────────────────────────────
  eventBus.on("updatefindcontrolstate", (evt: FindControlState) => {
    if (evt.matchesCount) currentMatches = evt.matchesCount;
    renderStatus(evt);
  });
  eventBus.on("updatefindmatchescount", (evt: FindMatchesCount) => {
    currentMatches = evt.matchesCount;
    renderStatus(null);
  });

  // ── DOM events ─────────────────────────────────────────────────────────────
  input.addEventListener("input", () => dispatchFind("", false));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dispatchFind("again", e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  prevBtn.addEventListener("click", () => {
    dispatchFind("again", true);
    input.focus();
  });
  nextBtn.addEventListener("click", () => {
    dispatchFind("again", false);
    input.focus();
  });
  closeBtn.addEventListener("click", () => close());

  /**
   * Detect whether the keystroke originated inside an editable element,
   * walking through shadow-DOM boundaries. Thilko's toolbar / sidebar /
   * popover all live inside closed-ish shadow roots, so at this
   * window-capture listener `e.target` is the shadow host, NOT the inner
   * input. composedPath() exposes the full chain. We treat the find-bar's
   * own input as the exception so Cmd/Ctrl+F refocuses + opens cleanly
   * even when it already has focus.
   */
  function eventOriginatesInEditable(e: KeyboardEvent): boolean {
    const path = e.composedPath() as EventTarget[];
    for (const node of path) {
      if (node === input) continue;
      if (!(node instanceof Element)) continue;
      const tag = node.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (node instanceof HTMLElement && node.isContentEditable) return true;
      if (node.getAttribute("role") === "textbox") return true;
    }
    return false;
  }

  /** Whether the event originated inside our own find bar (input or buttons). */
  function eventOriginatesInFindBar(e: KeyboardEvent): boolean {
    const path = e.composedPath() as EventTarget[];
    return path.includes(bar);
  }

  // Global Cmd/Ctrl+F to open. Skip when an editable elsewhere owns focus
  // so we don't hijack typing in sidebar comments / toolbar inputs (those
  // are mounted inside shadow roots — see eventOriginatesInEditable).
  function onGlobalKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      if (eventOriginatesInEditable(e)) return;
      e.preventDefault();
      open();
    } else if (e.key === "Escape" && !bar.hidden) {
      // Close on Esc — but only from the find bar itself or from the
      // viewer body. Closing while the user is editing a sidebar comment
      // would surprise them.
      if (eventOriginatesInFindBar(e) || !eventOriginatesInEditable(e)) {
        close();
      }
    }
  }
  window.addEventListener("keydown", onGlobalKey, { capture: true });

  function open(): void {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value) {
      // Re-run last search so highlights come back if `findbarclose`
      // previously cleared them.
      dispatchFind("", false);
    }
  }

  function close(): void {
    bar.hidden = true;
    // Tell pdfjs to clear the highlight overlay.
    eventBus.dispatch("findbarclose", { source: bar });
  }

  function destroy(): void {
    window.removeEventListener("keydown", onGlobalKey, { capture: true });
    bar.remove();
  }

  return { open, close, destroy };
}
