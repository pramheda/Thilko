/**
 * PDF anchoring.
 *
 * The PDF viewer renders each page as a `<div data-page-number="N">` wrapper
 * containing a `<canvas>` and a positioned text layer of `<span>` elements.
 * apache-annotator's TextQuote matcher operates on text nodes, so the same
 * re-anchoring code that works for HTML pages works here too. We just need
 * to ALSO capture the page number + intra-page character offset on creation
 * so future implementations can fast-skip to the right page or recover from
 * a quote that drifted across edits.
 */

import { describeTextQuote } from "@apache-annotator/dom";
import type { TextQuoteSelector } from "@apache-annotator/selector";
import { type Anchor, type AnchorPdf } from "../../shared/types.js";
import { anchorFromRange } from "./html-anchor.js";

/**
 * Build a persistable AnchorPdf from a live DOM Range inside the PDF viewer.
 * Returns null if the range collapses, contains no text, or can't be located
 * within a `[data-page-number]` page wrapper.
 */
export async function anchorPdfFromRange(range: Range): Promise<AnchorPdf | null> {
  if (range.collapsed) return null;
  const text = range.toString();
  if (text.length === 0) return null;

  const pageEl = findPageElement(range.startContainer);
  if (!pageEl) return null;
  const pageNumber = parseInt(pageEl.getAttribute("data-page-number") ?? "", 10);
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;

  // Quote — scoped to document.body so prefix/suffix can find disambiguating
  // text across the full PDF (the text-layer DOM lives there). The matcher
  // also walks that same scope on re-anchoring.
  const scope: Node = document.body ?? document.documentElement;
  const quote: TextQuoteSelector = await describeTextQuote(range, scope);

  // Page offset — character position of range start/end within the page's
  // concatenated text content. Robust to page-internal text mutation; not
  // currently used by rangeFromAnchor but persisted for future fast-path
  // recovery.
  const pageOffset = computePageOffset(range, pageEl);

  return {
    type: "pdf",
    quote: {
      exact: quote.exact,
      prefix: quote.prefix ?? "",
      suffix: quote.suffix ?? "",
    },
    page: pageNumber,
    pageOffset: pageOffset ?? { start: 0, end: text.length },
  };
}

/** Walk ancestors (and shadow boundaries) to find the closest [data-page-number] container. */
function findPageElement(node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n instanceof Element && n.hasAttribute("data-page-number")) {
      return n as HTMLElement;
    }
    n = n.parentNode;
  }
  return null;
}

/** Char offsets of `range` within `page`'s concatenated text content. */
function computePageOffset(range: Range, page: HTMLElement): { start: number; end: number } | null {
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  let chars = 0;
  let start: number | null = null;
  let end: number | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const len = t.data.length;
    if (start === null && n === range.startContainer) {
      start = chars + range.startOffset;
    }
    if (n === range.endContainer) {
      end = chars + range.endOffset;
      break;
    }
    chars += len;
  }
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/**
 * Convenience: works for either anchor type. Used by the lifecycle code so it
 * doesn't have to switch on contentType — picks the right anchor builder.
 */
export async function createAnchorFromRange(range: Range, contentType: "html" | "pdf"): Promise<Anchor | null> {
  if (contentType === "pdf") return anchorPdfFromRange(range);
  return anchorFromRange(range);
}
