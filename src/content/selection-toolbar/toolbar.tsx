/**
 * Selection-toolbar React component.
 *
 * A small floating pill positioned above (or below, when near the top of the
 * viewport) the active selection. Two buttons: Comment and Ask AI.
 *
 * Ask AI is wired in M5; in M4 it shows a "coming soon" hint when clicked.
 */

import { useEffect, useRef, useState } from "react";
import { Mascot } from "../ui/mascot.js";
import { Glyph } from "../ui/glyph.js";

export interface ToolbarProps {
  selectionText: string;
  onComment: () => void;
  onAskAi: () => void;
  /** When set, briefly disables the buttons (e.g. during create-highlight). */
  busy?: boolean;
}

export function SelectionToolbar({ selectionText, onComment, onAskAi, busy }: ToolbarProps) {
  const [askedAi, setAskedAi] = useState(false);
  const askedTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (askedTimer.current !== null) window.clearTimeout(askedTimer.current);
    };
  }, []);

  const handleAskAi = () => {
    onAskAi();
    setAskedAi(true);
    if (askedTimer.current !== null) window.clearTimeout(askedTimer.current);
    askedTimer.current = window.setTimeout(() => setAskedAi(false), 1800);
  };

  const len = selectionText.length;
  const label = len > 0 ? `${len} chars selected` : "Selection";

  return (
    <div className="toolbar toolbar-with-mascot" role="toolbar" aria-label="Thilko selection toolbar">
      <span className="toolbar-mascot" aria-hidden="true">
        <Mascot size={48} decorative className="thilko-mascot-sidekick" />
      </span>
      <button
        type="button"
        onClick={onComment}
        disabled={!!busy}
        aria-label={`Add a comment to "${label}"`}
        title="Comment (Cmd/Ctrl+Shift+C)"
      >
        <Glyph kind="note" size={18} className="toolbar-glyph" />
        Comment
      </button>
      <span className="toolbar-divider" aria-hidden="true" />
      <button
        type="button"
        onClick={handleAskAi}
        disabled={!!busy}
        aria-label="Ask Dabbis-AI about the selection"
        title="Ask Dabbis-AI (Cmd/Ctrl+Shift+A)"
      >
        <Glyph kind="thread" size={18} className="toolbar-glyph" />
        {askedAi ? "Asking…" : "Ask AI"}
      </button>
    </div>
  );
}
