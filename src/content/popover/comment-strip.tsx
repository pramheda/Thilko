/**
 * CommentStrip — the muted band of existing notes at the top of a Transcript.
 *
 * Design intent (post design-review PR2): comments are a *side channel* to
 * the conversation, not a peer surface. They appear above the chat turns as
 * quiet rows; hovering a row exposes an inline ✕ for deletion. No section
 * title, no per-row metadata — just the text and the ability to delete.
 *
 * When the user wants to ADD a note, they switch the Composer to note mode
 * (paperclip affordance) — there's no inline "add comment" composer in this
 * strip itself. That keeps the strip purely about reading + cleaning up
 * existing notes, separate from authoring.
 */

import { useCallback, useMemo, useState } from "react";
import { type Comment } from "../../shared/types.js";

export interface CommentStripProps {
  comments: Comment[];
  /** Best-effort delete. Strip optimistically removes on success, restores on failure. */
  onDelete: (id: string) => Promise<void>;
}

export function CommentStrip({ comments, onDelete }: CommentStripProps) {
  const sorted = useMemo(
    () => [...comments].sort((a, b) => a.createdAt - b.createdAt),
    [comments],
  );

  if (sorted.length === 0) return null;

  return (
    <div className="comment-strip" role="group" aria-label="Notes for this highlight">
      {sorted.map((c) => (
        <CommentRow key={c.id} comment={c} onDelete={onDelete} />
      ))}
    </div>
  );
}

function CommentRow({ comment, onDelete }: { comment: Comment; onDelete: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const handleDelete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(comment.id);
    } finally {
      setBusy(false);
    }
  }, [busy, comment.id, onDelete]);

  return (
    <div className={`comment-row${busy ? " busy" : ""}`}>
      <span className="comment-row-glyph" aria-hidden="true">📎</span>
      <span className="comment-row-text">{comment.text}</span>
      <button
        type="button"
        className="comment-row-delete"
        onClick={handleDelete}
        aria-label="Delete note"
        title="Delete note"
        disabled={busy}
      >
        ✕
      </button>
    </div>
  );
}
