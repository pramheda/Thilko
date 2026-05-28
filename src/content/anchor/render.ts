/**
 * DOM rendering for anchored highlights.
 *
 * Responsibilities:
 *   - Wrap a Range in <mark class="thilko-hl" data-thilko-id="..."> via
 *     apache-annotator's highlightText (handles split selections across
 *     multiple text nodes correctly).
 *   - Place a marker button immediately after the last wrapping element
 *     so the user has a click target (no popover wiring in M3; handler is
 *     a stub broadcasting a CustomEvent for M4 to subscribe to).
 *   - Provide an unrender function so the content script can clean up if
 *     a highlight is deleted, re-anchored, or the page is being torn down.
 *
 * Style isolation: all visual rules live in styles.css and are scoped by
 * the .thilko-hl / .thilko-marker class names. Host pages cannot override
 * us because every property is !important. Stylesheet injection happens
 * once per content-script lifecycle.
 */

import { highlightText } from "@apache-annotator/dom";

const STYLE_TAG_ID = "thilko-content-styles";

/** Inject the highlight stylesheet exactly once per document. */
export function ensureStylesInjected(stylesheetCss: string): void {
  if (document.getElementById(STYLE_TAG_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_TAG_ID;
  style.textContent = stylesheetCss;
  // Insert at the END of <head> so any later host-page <style> can't override
  // unless it uses !important on the same selector (which we win against via
  // class specificity).
  const head = document.head ?? document.documentElement;
  head.appendChild(style);
}

/** Counts that drive the marker's visible icons. */
export interface MarkerCounts {
  comments: number;
  threads: number;
}

export interface RenderedHighlight {
  highlightId: string;
  /** Removes the <mark> wrapping and the marker button. */
  unrender: () => void;
  /** Updates marker counts in place (cheap; no re-wrap). */
  updateMarker: (counts: MarkerCounts) => void;
}

export interface RenderOptions {
  highlightId: string;
  range: Range;
  counts: MarkerCounts;
  onMarkerClick: (highlightId: string) => void;
}

/**
 * Wrap a Range and append a marker button.
 *
 * The Range is consumed (apache-annotator may split text nodes during
 * wrapping). The returned RenderedHighlight provides undo + update affordances.
 */
export function renderHighlight(opts: RenderOptions): RenderedHighlight {
  const { highlightId, range, counts, onMarkerClick } = opts;

  // 1) Wrap the range with our tagged <mark>. apache-annotator handles
  //    multi-element ranges by emitting multiple sibling <mark>s.
  const unhighlight = highlightText(range, "mark", {
    class: "thilko-hl",
    "data-thilko-id": highlightId,
  });

  // 2) Place a marker button right after the last <mark> for this highlight.
  const allMarks = document.querySelectorAll<HTMLElement>(
    `mark.thilko-hl[data-thilko-id="${escapeAttr(highlightId)}"]`,
  );
  const lastMark = allMarks.length > 0 ? allMarks[allMarks.length - 1] : null;
  let marker: HTMLButtonElement | null = null;
  if (lastMark) {
    marker = buildMarker(highlightId, counts, onMarkerClick);
    lastMark.insertAdjacentElement("afterend", marker);
  }

  return {
    highlightId,
    unrender: () => {
      try {
        unhighlight();
      } catch (e) {
        console.warn("[thilko] unhighlight failed", e);
      }
      marker?.remove();
    },
    updateMarker: (next) => {
      if (!marker) return;
      const replaced = buildMarker(highlightId, next, onMarkerClick);
      marker.replaceWith(replaced);
      marker = replaced;
    },
  };
}

function buildMarker(highlightId: string, counts: MarkerCounts, onClick: (id: string) => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "thilko-marker";
  btn.setAttribute("data-thilko-marker-id", highlightId);
  btn.setAttribute("aria-label", buildAriaLabel(counts));
  btn.appendChild(buildMarkerContent(counts));
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(highlightId);
  });
  return btn;
}

/** Cached extension-relative URLs for the bundled glyphs. Resolved once per
 *  content-script lifetime since chrome.runtime.getURL is a sync call but
 *  not free. Wrapped in try/catch so this module loads in environments
 *  without chrome.runtime (tests, SSR). */
const GLYPH_URL: { note: string; thread: string } = (() => {
  try {
    return {
      note: chrome.runtime.getURL("mascot/glyphs/dabbis-note.png"),
      thread: chrome.runtime.getURL("mascot/glyphs/dabbis-thread.png"),
    };
  } catch {
    return { note: "", thread: "" };
  }
})();

function makeGlyph(kind: "note" | "thread"): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "thilko-marker-icon";
  img.setAttribute("src", GLYPH_URL[kind]);
  img.setAttribute("alt", "");
  img.setAttribute("aria-hidden", "true");
  img.setAttribute("draggable", "false");
  return img;
}

function buildMarkerContent(counts: MarkerCounts): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (counts.comments > 0) {
    frag.appendChild(makeGlyph("note"));
    if (counts.comments > 1) {
      const c = document.createElement("span");
      c.className = "thilko-marker-count";
      c.textContent = String(counts.comments);
      frag.appendChild(c);
    }
  }
  if (counts.threads > 0) {
    const icon = makeGlyph("thread");
    icon.style.setProperty("margin-left", counts.comments > 0 ? "4px" : "0", "important");
    frag.appendChild(icon);
    if (counts.threads > 1) {
      const c = document.createElement("span");
      c.className = "thilko-marker-count";
      c.textContent = String(counts.threads);
      frag.appendChild(c);
    }
  }
  if (counts.comments === 0 && counts.threads === 0) {
    // Visible "this is a highlight" affordance with no attachments yet.
    // Uses the note glyph in a slightly faded state — the user is about to
    // either add a note or start a thread, and Dabbis-with-quill reads
    // closer to that pending state than a generic bookmark emoji did.
    const icon = makeGlyph("note");
    icon.style.setProperty("opacity", "0.55", "important");
    frag.appendChild(icon);
  }
  return frag;
}

function buildAriaLabel(counts: MarkerCounts): string {
  if (counts.comments === 0 && counts.threads === 0) return "Highlight — no notes yet";
  const parts: string[] = [];
  if (counts.comments > 0) parts.push(`${counts.comments} comment${counts.comments === 1 ? "" : "s"}`);
  if (counts.threads > 0) parts.push(`${counts.threads} AI thread${counts.threads === 1 ? "" : "s"}`);
  return `Highlight — ${parts.join(", ")}`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}
