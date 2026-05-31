/**
 * A single row in the sidebar list — one highlight, one click target.
 */

import { type SidebarHighlightEntry } from "./sidebar-state.js";
import { Glyph } from "../ui/glyph.js";

/**
 * `previewMode` lets the sidebar choose which note kind the row should
 * preview. In the all-filter mode we auto-pick (comments first when both
 * exist); in the comments/threads filter modes we lock to that kind so the
 * user always sees the matching content for what they filtered on.
 */
export type PreviewMode = "auto" | "comment" | "thread";

export interface NoteRowProps {
  entry: SidebarHighlightEntry;
  previewMode?: PreviewMode;
  onClick: () => void;
}

export function NoteRow({ entry, previewMode = "auto", onClick }: NoteRowProps) {
  const { highlight, commentCount, threadCount, firstCommentPreview, latestThreadPreview } = entry;
  const quote = highlight.anchor.quote.exact;

  // `pending` rows look "live" — they belong to a page pdfjs hasn't rendered
  // yet. We never want to call them "Couldn't re-anchor" or stamp the orphan
  // badge; the textlayerrendered listener will bind them as the user scrolls.
  const isLiveLike = entry.rendered || entry.pending;

  let previewLine: string;
  if (previewMode === "comment") {
    previewLine = firstCommentPreview ?? (isLiveLike ? "No comments on this highlight" : "Couldn't re-anchor");
  } else if (previewMode === "thread") {
    previewLine = latestThreadPreview ?? (isLiveLike ? "No threads on this highlight" : "Couldn't re-anchor");
  } else {
    previewLine = firstCommentPreview ?? latestThreadPreview ?? (isLiveLike ? "No notes yet" : "Couldn't re-anchor");
  }

  return (
    <button type="button" className="note-row" onClick={onClick} aria-label={`Open highlight: ${truncate(quote, 80)}`}>
      <div className="note-row-quote">{truncate(quote, 140)}</div>
      <div className="note-row-preview">{truncate(previewLine, 120)}</div>
      <div className="note-row-meta">
        {commentCount > 0 ? (
          <span className="note-row-badge">
            <Glyph kind="note" size={12} className="note-row-badge-glyph" />
            {commentCount}
          </span>
        ) : null}
        {threadCount > 0 ? (
          <span className="note-row-badge">
            <Glyph kind="thread" size={12} className="note-row-badge-glyph" />
            {threadCount}
          </span>
        ) : null}
        {commentCount === 0 && threadCount === 0 && isLiveLike ? <span className="note-row-badge muted">🔖</span> : null}
        {!entry.rendered && !entry.pending ? <span className="note-row-badge orphan">orphan</span> : null}
        <span className="note-row-time">{formatTimestamp(highlight.createdAt)}</span>
      </div>
    </button>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
