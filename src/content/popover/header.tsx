/**
 * Popover header — drag handle + quoted subject + overflow + close.
 *
 * The header is the drag target (see drag.ts). Buttons inside trap pointer
 * events so clicks don't initiate a drag.
 *
 * Design note (post design-review PR1): the header now shows the HIGHLIGHTED
 * QUOTE itself, not the article title. The user is already looking at the
 * article behind the popover — repeating the title was chrome talking to
 * itself. The quote is the subject of this conversation, so it lives at the
 * top. Long quotes truncate; the full text is still in the title attribute
 * for tooltip / accessibility.
 *
 * The ⋯ overflow menu replaces the dedicated "Open with Claude" footer
 * button and the per-record Delete actions, collapsing rare/destructive
 * choices into a single quiet affordance.
 */

import { useEffect, useRef, useState, type Ref } from "react";
import { Mascot } from "../ui/mascot.js";

export interface PopoverHeaderProps {
  /** The one-line quote displayed across the header. Truncated visually. */
  quote: string;
  /** Forwarded to the outer header element so the drag hook can listen on it. */
  handleRef: Ref<HTMLDivElement>;
  onCollapse: () => void;
  onClose: () => void;
  /** Toggle the header-only "minimized" state. Different from collapse-to-chip
   *  (which is now hidden in the overflow menu): minimize keeps the popover
   *  pinned at the right edge of the viewport with just the header showing,
   *  ready to be expanded back. */
  onToggleMinimized: () => void;
  /** Reflects the current minimized state — drives the icon shown on the
   *  minimize button. */
  minimized: boolean;
  /** Overflow menu callbacks. */
  onDeleteHighlight: () => void;
  onOpenWithClaude: () => void;
  onOpenWithChatgpt: () => void;
  onCopyQuote: () => void;
}

export function PopoverHeader(props: PopoverHeaderProps) {
  const { quote, handleRef, onCollapse, onClose, onToggleMinimized, minimized, onDeleteHighlight, onOpenWithClaude, onOpenWithChatgpt, onCopyQuote } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the menu on outside click + Escape. Bound to the document so it
  // catches clicks anywhere — including outside the popover, which collapses
  // the menu without dismissing the popover itself.
  //
  // Shadow-DOM caveat: this popover lives inside a shadow root. When an event
  // crosses the shadow boundary into `document`, `e.target` is RETARGETED to
  // the shadow host element, NOT the original menu item inside the shadow.
  // So `menuRef.current.contains(e.target)` is always `false` for clicks on
  // the menu — which would close the menu before the menu-item onClick fires,
  // making every menu item silently do nothing. Use `composedPath()` instead,
  // which preserves the original element list including everything inside
  // shadow roots.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const menu = menuRef.current;
      if (!menu) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.includes(menu)) return; // click was inside the menu wrap
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  const fire = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    fn();
  };

  return (
    <div className="popover-header" ref={handleRef}>
      <span className="popover-header-mascot" aria-hidden="true">
        <Mascot size={20} decorative />
      </span>
      <div className="popover-header-quote" title={quote}>
        {quote}
      </div>
      <div className="popover-header-actions">
        <div className="popover-header-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="popover-header-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More"
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="popover-header-menu" role="menu" onMouseDown={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={fire(onCopyQuote)}>
                Copy quote
              </button>
              <button type="button" role="menuitem" onClick={fire(onOpenWithClaude)}>
                Open with Claude
              </button>
              <button type="button" role="menuitem" onClick={fire(onOpenWithChatgpt)}>
                Open with ChatGPT
              </button>
              <button type="button" role="menuitem" onClick={fire(onCollapse)}>
                Collapse to chip
              </button>
              <div className="popover-header-menu-sep" aria-hidden="true" />
              <button type="button" role="menuitem" className="danger" onClick={fire(onDeleteHighlight)}>
                Delete highlight
              </button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="popover-header-minimize"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMinimized();
          }}
          aria-label={minimized ? "Restore popover" : "Minimize popover"}
          title={minimized ? "Restore" : "Minimize"}
        >
          {minimized ? "▢" : "−"}
        </button>
        <button
          type="button"
          className="popover-header-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close popover"
          title="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
