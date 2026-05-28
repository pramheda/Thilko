/**
 * Viewport-aware positioning for floating widgets (selection toolbar,
 * popovers). Computes a host element's `top`/`left` so the widget appears
 * near the anchor but stays fully visible.
 *
 * All math is in viewport coordinates because the host element is
 * `position: fixed`.
 */

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ViewportFit {
  preferred: "above" | "below" | "right" | "left";
  width: number;
  height: number;
  margin?: number;
}

export interface PositionResult {
  top: number;
  left: number;
  placement: "above" | "below" | "right" | "left";
}

/**
 * Place a widget of `size` relative to `anchor`. If the preferred side
 * doesn't have room, flip to the opposite side. Clamp horizontally to the
 * viewport with a margin so the widget doesn't hang off-screen.
 */
export function placeNear(anchor: AnchorRect, fit: ViewportFit): PositionResult {
  const margin = fit.margin ?? 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let placement = fit.preferred;

  if (placement === "above" && anchor.top - fit.height < margin) {
    if (anchor.bottom + fit.height + margin <= vh) placement = "below";
  } else if (placement === "below" && anchor.bottom + fit.height > vh - margin) {
    if (anchor.top - fit.height >= margin) placement = "above";
  }

  let top: number;
  let left: number;

  switch (placement) {
    case "above":
      top = anchor.top - fit.height - margin;
      left = anchor.left + anchor.width / 2 - fit.width / 2;
      break;
    case "below":
      top = anchor.bottom + margin;
      left = anchor.left + anchor.width / 2 - fit.width / 2;
      break;
    case "left":
      top = anchor.top + anchor.height / 2 - fit.height / 2;
      left = anchor.left - fit.width - margin;
      break;
    case "right":
      top = anchor.top + anchor.height / 2 - fit.height / 2;
      left = anchor.right + margin;
      break;
  }

  // Clamp horizontally and vertically.
  left = Math.max(margin, Math.min(left, vw - fit.width - margin));
  top = Math.max(margin, Math.min(top, vh - fit.height - margin));

  return { top, left, placement };
}

/**
 * Get the bounding rect of a DOM Range in viewport coordinates. For
 * multi-rect selections (selection spans line breaks), returns the union of
 * the start and end client rects.
 */
export function rangeAnchorRect(range: Range): AnchorRect | null {
  const rects = range.getClientRects();
  if (rects.length === 0) {
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return rectFromDom(r);
  }
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;
  return {
    top: first.top,
    left: Math.min(first.left, last.left),
    right: Math.max(first.right, last.right),
    bottom: last.bottom,
    width: Math.max(first.right, last.right) - Math.min(first.left, last.left),
    height: last.bottom - first.top,
  };
}

/** Get the rect of an Element (the last <mark> in a multi-mark highlight). */
export function elementAnchorRect(el: Element): AnchorRect {
  return rectFromDom(el.getBoundingClientRect());
}

function rectFromDom(r: DOMRect): AnchorRect {
  return {
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}
