/**
 * Mascot — the small scholarly companion that anchors the Thilko brand on
 * the selection toolbar and the popover header.
 *
 * The asset is a single 128px PNG bundled under public/mascot/ and exposed
 * via web_accessible_resources in manifest.json. We resolve the chrome-
 * extension URL once at module load with chrome.runtime.getURL — that URL
 * is stable for the lifetime of the extension, so caching it avoids a
 * lookup per render.
 *
 * Sizing:
 *   - 48 px on the selection toolbar (sidekick above)
 *   - 22 px on the popover header
 * Both well within the 128px source's downscale comfort zone.
 *
 * Decorative usages should pass `decorative` so screen readers ignore them.
 * The primary toolbar sidekick instance keeps the default aria-label.
 */

const MASCOT_URL: string = (() => {
  try {
    return chrome.runtime.getURL("mascot/mascot-idle.png");
  } catch {
    // Outside extension context (tests / SSR) — fall back to a relative path.
    return "/mascot/mascot-idle.png";
  }
})();

export interface MascotProps {
  /** Rendered width AND height in CSS pixels. Square. */
  size: number;
  /** Optional CSS class — for placement-specific layout (rotation, position). */
  className?: string;
  /** Pass true on decorative duplicates so screen readers don't repeat the persona. */
  decorative?: boolean;
}

export function Mascot({ size, className, decorative }: MascotProps) {
  return (
    <img
      src={MASCOT_URL}
      width={size}
      height={size}
      alt={decorative ? "" : "Thilko"}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? "presentation" : "img"}
      draggable={false}
      className={`thilko-mascot${className ? ` ${className}` : ""}`}
    />
  );
}
