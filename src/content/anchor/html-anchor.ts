/**
 * HTML anchoring — Anchor ↔ DOM Range.
 *
 * Built on @apache-annotator/dom (W3C Web Annotations TextQuoteSelector +
 * TextPositionSelector). Same library Hypothesis uses in production.
 *
 * Match strategy (tried in order, first hit wins):
 *
 *   1. EXACT  — TextQuote with stored prefix + exact + suffix.
 *   2. RELAXED — TextQuote without suffix, then without prefix.
 *      Catches the case where text adjacent to the highlight changed but the
 *      highlighted phrase is unchanged.
 *   3. EXACT (no context) — TextQuote with just `exact`. First match wins.
 *      Catches cases where both adjacent prefix and suffix drifted but the
 *      phrase itself is intact.
 *   4. POSITION — TextPositionSelector (start/end char offsets) stored on
 *      the anchor at creation time. Catches cases where the phrase shifted
 *      slightly (whitespace normalization) without changing position much.
 *   5. FUZZY  — Sliding-window Levenshtein search around the original text
 *      position. Catches the "edited slightly" case where a few characters
 *      inside the highlighted span have changed (typos, copy-edits, etc).
 *
 * Falling all of the above produces an orphan result, persisted via
 * `orphaned: true` on the highlight record.
 *
 * Anchor creation captures both selectors. Adding the position selector is
 * cheap and dramatically improves robustness on real-world article edits.
 */

import {
  createTextPositionSelectorMatcher,
  createTextQuoteSelectorMatcher,
  describeTextQuote,
} from "@apache-annotator/dom";
import type { TextPositionSelector, TextQuoteSelector } from "@apache-annotator/selector";
import { type Anchor, type AnchorHtml } from "../../shared/types.js";

/** Maximum Levenshtein distance allowed during fuzzy match, as a ratio of the quote length. */
const FUZZY_MAX_DISTANCE_RATIO = 0.2;
/** Search window for fuzzy fallback, centered on the stored text position. */
const FUZZY_WINDOW_CHARS = 1500;
/** Skip fuzzy entirely for quotes longer than this — the O(window × length × edit) cost grows quickly. */
const FUZZY_MAX_QUOTE_CHARS = 400;
/** Number of leading chars used as a cheap substring prefilter before running Levenshtein. */
const FUZZY_PREFILTER_LEN = 12;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a persistable Anchor from a live DOM Range. Captures both a
 * TextQuoteSelector (with disambiguating prefix/suffix) and a
 * TextPositionSelector (character offsets in the scope's text). Returns null
 * if the range collapses to nothing or contains no text content.
 */
export async function anchorFromRange(range: Range): Promise<AnchorHtml | null> {
  if (range.collapsed) return null;
  const text = range.toString();
  if (text.length === 0) return null;

  const scope: Node = document.body ?? document.documentElement;
  const quote: TextQuoteSelector = await describeTextQuote(range, scope);
  const textPosition = computeTextPosition(range, scope);

  const anchor: AnchorHtml = {
    type: "html",
    quote: {
      exact: quote.exact,
      prefix: quote.prefix ?? "",
      suffix: quote.suffix ?? "",
    },
  };
  if (textPosition) {
    anchor.textPosition = textPosition;
  }
  return anchor;
}

export interface AnchorMatchFound {
  kind: "found";
  range: Range;
  /** How the match was located, for diagnostics. */
  strategy: "exact" | "no-suffix" | "no-prefix" | "no-context" | "position" | "fuzzy";
}
export interface AnchorMatchOrphan {
  kind: "orphan";
  reason: string;
}
export type AnchorMatchResult = AnchorMatchFound | AnchorMatchOrphan;

/**
 * Find a Range in the current document that matches the Anchor.
 *
 * Pure read-only: does NOT mutate the DOM. The returned Range references
 * live nodes in the current document. Callers MUST render synchronously
 * relative to the matching pass (no awaiting between match and wrap) or
 * re-fetch on subsequent calls — DOM mutations can invalidate the Range.
 */
export async function rangeFromAnchor(anchor: Anchor, scope?: Node): Promise<AnchorMatchResult> {
  // PDF anchors and HTML anchors share the same TextQuote+TextPosition
  // recovery logic — the difference is the SCOPE we hand the matcher:
  //   - HTML: document.body (or caller-supplied scope).
  //   - PDF: the `.viewer-page[data-page-number=N]` wrapper that this anchor
  //     was created against. PDFs frequently contain text repeated across
  //     pages (headers, footers, common phrases like "Conclusion"); searching
  //     document-wide would let the quote bind to the wrong page on reload.
  // If the PDF page wrapper isn't in the DOM yet (still rendering) we return
  // a specific orphan reason — the orphan stabilizer will retry once the
  // viewer finishes painting later pages.
  if (anchor.type !== "html" && anchor.type !== "pdf") {
    return { kind: "orphan", reason: `Unsupported anchor type '${(anchor as { type: string }).type}'` };
  }

  const { exact, prefix, suffix } = anchor.quote;
  if (!exact || exact.length === 0) {
    return { kind: "orphan", reason: "Anchor has empty exact text" };
  }

  let root: Node;
  if (scope) {
    root = scope;
  } else if (anchor.type === "pdf") {
    const pageEl = document.querySelector(`.viewer-page[data-page-number="${anchor.page}"]`);
    if (!pageEl) {
      return { kind: "orphan", reason: `PDF page ${anchor.page} not yet rendered` };
    }
    root = pageEl;
  } else {
    root = document.body ?? document.documentElement;
  }

  // 1. EXACT — full context.
  const exactMatch = await tryQuoteMatch({ exact, prefix, suffix }, root);
  if (exactMatch) return { kind: "found", range: exactMatch, strategy: "exact" };

  // 2. RELAXED — drop suffix.
  if (suffix && suffix.length > 0) {
    const m = await tryQuoteMatch({ exact, prefix, suffix: "" }, root);
    if (m) return { kind: "found", range: m, strategy: "no-suffix" };
  }

  // 2b. RELAXED — drop prefix.
  if (prefix && prefix.length > 0) {
    const m = await tryQuoteMatch({ exact, prefix: "", suffix }, root);
    if (m) return { kind: "found", range: m, strategy: "no-prefix" };
  }

  // 3. EXACT NO-CONTEXT — first hit anywhere in scope.
  if ((prefix && prefix.length > 0) || (suffix && suffix.length > 0)) {
    const m = await tryQuoteMatch({ exact, prefix: "", suffix: "" }, root);
    if (m) return { kind: "found", range: m, strategy: "no-context" };
  }

  // 4. POSITION — fall back to stored character offsets.
  //    HTML: textPosition is across document.body.
  //    PDF:  pageOffset is across the page wrapper (already our scope).
  if (anchor.type === "html" && anchor.textPosition) {
    const m = await tryPositionMatch(anchor.textPosition, root);
    if (m && (m.toString() === exact || isSimilarEnough(m.toString(), exact))) {
      return { kind: "found", range: m, strategy: "position" };
    }
  } else if (anchor.type === "pdf" && anchor.pageOffset) {
    const m = await tryPositionMatch(anchor.pageOffset, root);
    if (m && (m.toString() === exact || isSimilarEnough(m.toString(), exact))) {
      return { kind: "found", range: m, strategy: "position" };
    }
  }

  // 5. FUZZY — search a window around the original position.
  if (anchor.type === "html" && anchor.textPosition) {
    const m = await tryFuzzyMatch(exact, anchor.textPosition, root);
    if (m) return { kind: "found", range: m, strategy: "fuzzy" };
  } else if (anchor.type === "pdf" && anchor.pageOffset) {
    const m = await tryFuzzyMatch(exact, anchor.pageOffset, root);
    if (m) return { kind: "found", range: m, strategy: "fuzzy" };
  }

  return { kind: "orphan", reason: "No match found by exact, relaxed, position, or fuzzy strategies" };
}

// ── Internals ───────────────────────────────────────────────────────────────

async function tryQuoteMatch(
  parts: { exact: string; prefix: string; suffix: string },
  root: Node,
): Promise<Range | null> {
  const selector: TextQuoteSelector = {
    type: "TextQuoteSelector",
    exact: parts.exact,
    prefix: parts.prefix && parts.prefix.length > 0 ? parts.prefix : undefined,
    suffix: parts.suffix && parts.suffix.length > 0 ? parts.suffix : undefined,
  };
  try {
    const matcher = createTextQuoteSelectorMatcher(selector);
    for await (const range of matcher(root)) {
      return range;
    }
  } catch {
    // Matcher errors map to "no match", not orphan-with-reason — the next
    // strategy in the chain still gets a turn.
    return null;
  }
  return null;
}

async function tryPositionMatch(
  position: { start: number; end: number },
  root: Node,
): Promise<Range | null> {
  const selector: TextPositionSelector = {
    type: "TextPositionSelector",
    start: position.start,
    end: position.end,
  };
  try {
    const matcher = createTextPositionSelectorMatcher(selector);
    for await (const range of matcher(root)) {
      return range;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Slide a window across the document text around the original position and
 * pick the best fuzzy match. Returns a Range built by converting the
 * best-matching character offsets back into a TextPositionSelector match.
 */
async function tryFuzzyMatch(
  exact: string,
  position: { start: number; end: number },
  root: Node,
): Promise<Range | null> {
  // Skip fuzzy for very long quotes — the sliding-window scan becomes O(n²m)
  // and isn't useful when the user highlighted a paragraph (small char-level
  // edits in long text rarely change semantic meaning; relax-suffix/prefix
  // would have caught those cases already).
  if (exact.length > FUZZY_MAX_QUOTE_CHARS) return null;

  const text = getNodeText(root);
  if (text.length === 0) return null;
  const target = exact;
  const maxDist = Math.max(1, Math.floor(target.length * FUZZY_MAX_DISTANCE_RATIO));

  const center = Math.floor((position.start + position.end) / 2);
  const windowStart = Math.max(0, center - FUZZY_WINDOW_CHARS);
  const windowEnd = Math.min(text.length, center + FUZZY_WINDOW_CHARS);

  // Cheap prefilter: build a set of candidate start positions whose first
  // few chars are close to the target's first few chars. This eliminates the
  // bulk of (i, len) pairs before we ever call Levenshtein.
  const prefilterTarget = target.slice(0, Math.min(FUZZY_PREFILTER_LEN, target.length));
  const candidateStarts: number[] = [];
  const prefilterMaxDist = Math.min(2, Math.floor(prefilterTarget.length * FUZZY_MAX_DISTANCE_RATIO));
  for (let i = windowStart; i <= windowEnd - prefilterTarget.length; i++) {
    const head = text.slice(i, i + prefilterTarget.length);
    if (head === prefilterTarget) {
      candidateStarts.push(i);
      continue;
    }
    if (prefilterMaxDist > 0) {
      const d = boundedLevenshtein(head, prefilterTarget, prefilterMaxDist);
      if (d >= 0) candidateStarts.push(i);
    }
  }
  if (candidateStarts.length === 0) return null;

  let best: { start: number; end: number; dist: number } | null = null;
  const minLen = Math.max(1, target.length - maxDist);
  const maxLen = target.length + maxDist;

  for (const i of candidateStarts) {
    for (let len = minLen; len <= maxLen; len++) {
      if (i + len > text.length) break;
      const candidate = text.slice(i, i + len);
      const dist = boundedLevenshtein(candidate, target, maxDist);
      if (dist < 0) continue;
      if (!best || dist < best.dist) {
        best = { start: i, end: i + len, dist };
        if (dist === 0) break;
      }
    }
    if (best && best.dist === 0) break;
  }

  if (!best) return null;
  return tryPositionMatch({ start: best.start, end: best.end }, root);
}

/** Levenshtein distance with early termination if it exceeds `maxDistance`. */
function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDistance) return -1;
  // Single-row DP.
  let prev: number[] = new Array<number>(n + 1);
  let curr: number[] = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? Infinity) + 1;
      const ins = (curr[j - 1] ?? Infinity) + 1;
      const sub = (prev[j - 1] ?? Infinity) + cost;
      const v = Math.min(del, ins, sub);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDistance) return -1;
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? -1;
}

/** Cheap similarity check used after a position-based match — guards against the position drifting onto unrelated text. */
function isSimilarEnough(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  if (Math.abs(candidate.length - target.length) > target.length * 0.3) return false;
  const dist = boundedLevenshtein(candidate, target, Math.max(2, Math.floor(target.length * 0.3)));
  return dist >= 0;
}

/** Compute character offsets of a Range relative to a scope node's textContent. */
function computeTextPosition(range: Range, scope: Node): { start: number; end: number } | null {
  // Walk text nodes in document order, accumulating offsets.
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let charsSeen = 0;
  let start: number | null = null;
  let end: number | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const len = t.data.length;
    if (start === null && n === range.startContainer) {
      start = charsSeen + range.startOffset;
    }
    if (n === range.endContainer) {
      end = charsSeen + range.endOffset;
      break;
    }
    // Handle the case where start/end containers are above text nodes (e.g.
    // element nodes when the range was created by selectNodeContents).
    if (start === null && t.parentNode === range.startContainer && walker.currentNode === range.startContainer.childNodes[range.startOffset]) {
      start = charsSeen;
    }
    charsSeen += len;
  }
  if (start === null || end === null) return null;
  if (end < start) return null;
  return { start, end };
}

/** Concatenate text content of all descendant text nodes, in document order. */
function getNodeText(scope: Node): string {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    parts.push((n as Text).data);
  }
  return parts.join("");
}
