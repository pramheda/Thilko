/**
 * Composer — the single input surface for the popover (PR2).
 *
 * Replaces the dual composers from PR1 (one inside CommentsSection, one
 * inside ThreadView). A paperclip-style affordance on the left toggles
 * between two modes:
 *
 *   - "note": save a Comment attached to the highlight.
 *   - "chat": send a message to Dabbis-AI in the conversation transcript.
 *
 * The DOM stays the same across modes — only the placeholder, the
 * paperclip's pressed state, and the parent's submit handler differ. This
 * means the textarea doesn't remount when switching, the cursor stays in
 * place, and any draft text the user typed is preserved across toggles.
 *
 * Submit semantics:
 *   - Enter (no modifiers) → submit
 *   - Shift+Enter → newline
 *   - Cmd/Ctrl+Enter → submit (parity with chat conventions)
 *
 * The parent (Transcript) owns the actual side effect — this component just
 * collects text and fires onSubmit(text, mode). The composer is a leaf in
 * the data flow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Glyph } from "../ui/glyph.js";

export type ComposerMode = "note" | "chat";

export interface ComposerProps {
  /** Initial mode when the popover opens — Comment toolbar → "note", Ask Dabbis-AI → "chat". */
  initialMode: ComposerMode;
  /** Disables the composer while a network round-trip is in flight. */
  busy?: boolean;
  /** When set, autofocus the textarea on mount. */
  autoFocus?: boolean;
  /** Parent does the actual save / send. */
  onSubmit: (text: string, mode: ComposerMode) => void | Promise<void>;
}

export function Composer({ initialMode, busy, autoFocus, onSubmit }: ComposerProps) {
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus on mount and on mode toggle so the user can start typing
  // immediately. Returning focus on toggle is what makes the affordance
  // feel like a switch rather than a tab.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus, mode]);

  const handleSubmit = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setDraft("");
    await onSubmit(text, mode);
  }, [draft, busy, mode, onSubmit]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  const placeholder = mode === "chat" ? "Ask Dabbis anything" : "Add a note";
  const submitLabel = mode === "chat" ? "Send" : "Save";

  return (
    <div className={`composer composer-${mode}`}>
      <button
        type="button"
        className={`composer-mode-toggle${mode === "note" ? " active" : ""}`}
        onClick={() => setMode((m) => (m === "note" ? "chat" : "note"))}
        aria-label={mode === "note" ? "Switch to AI chat" : "Switch to note"}
        title={mode === "note" ? "Switch to AI chat" : "Switch to note"}
        disabled={busy}
      >
        {/* The icon reflects the CURRENT mode's identity — note glyph when
         *  composing a note, thread glyph when chatting with Dabbis.
         *  Clicking switches to the OTHER mode. */}
        <Glyph kind={mode === "note" ? "note" : "thread"} size={20} className="composer-mode-glyph" />
      </button>
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        disabled={busy}
      />
      <button
        type="button"
        className="composer-submit primary"
        onClick={() => void handleSubmit()}
        disabled={draft.trim().length === 0 || busy}
      >
        {submitLabel}
      </button>
    </div>
  );
}
