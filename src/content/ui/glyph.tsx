/**
 * Glyph — the small Dabbis-branded pictograms used in the selection
 * toolbar, composer mode toggle, and sidebar filter chips/row badges.
 *
 * Two variants:
 *
 *   - "note"   → speech-bubble outline (Comment / save-as-note affordance)
 *   - "thread" → four-point sparkle    (Ask Dabbis-AI / chat-mode affordance)
 *
 * Both carry a small fixed-gold halo dot top-right — a quiet wink to the
 * Dabbis mascot's halo, which ties the in-pill glyphs back to the
 * brand without needing the character silhouette (illegible at 18px).
 *
 * The main shape uses `currentColor`, so the surrounding button's text
 * color drives it (lavender on rest, white on filter-chip.active, etc.).
 * The halo stays gold across states for a stable brand mark.
 *
 * Inline SVG instead of PNG — no asset load, perfect crispness at any
 * size, no halo/anti-aliasing problems on dark backgrounds.
 */

type GlyphKind = "note" | "thread";

/** The Dabbis-halo gold. Matches the mascot's halo ring color. */
const HALO_GOLD = "#E8C66B";

export interface GlyphProps {
  kind: GlyphKind;
  /** Rendered width AND height in CSS pixels. Square. */
  size: number;
  className?: string;
}

export function Glyph({ kind, size, className }: GlyphProps) {
  const cls = `thilko-glyph thilko-glyph-${kind}${className ? ` ${className}` : ""}`;
  if (kind === "note") {
    return (
      <svg
        className={cls}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        role="presentation"
        focusable="false"
      >
        {/* Rounded speech-bubble outline with a tail at lower-left. The
         *  stroke uses currentColor so the parent button's color paints it. */}
        <path
          d="M5 4 H17 A3 3 0 0 1 20 7 V13 A3 3 0 0 1 17 16 H10 L5.5 20 V16 H5 A3 3 0 0 1 2 13 V7 A3 3 0 0 1 5 4 Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Halo dot top-right — Dabbis brand tie-back. */}
        <circle cx="20.5" cy="3.5" r="2" fill={HALO_GOLD} />
      </svg>
    );
  }
  // "thread" → four-point sparkle
  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      role="presentation"
      focusable="false"
    >
      {/* Four-point sparkle, solid fill in currentColor. Outer points at
       *  ±9 from center (11,13); inner waist at ±3 for a tight star shape
       *  that holds its silhouette down to ~14px. */}
      <path
        d="M11 4 L13.1 10.9 L20 13 L13.1 15.1 L11 22 L8.9 15.1 L2 13 L8.9 10.9 Z"
        fill="currentColor"
      />
      {/* Halo dot top-right — matches the note glyph's position so the
       *  two icons read as a family. */}
      <circle cx="20.5" cy="3.5" r="2" fill={HALO_GOLD} />
    </svg>
  );
}
