/**
 * Note detail — right column. Shows the highlight + every comment + every
 * thread attached, plus actions (Open article, Open with Claude).
 */

import { type ListItem, type ListItemHighlight } from "./library-types.js";
import { type Comment, type Thread } from "../shared/types.js";

export interface NoteDetailProps {
  item: ListItem | null;
  /** Comments + threads for this item's highlight. Provided by the parent so
   *  the detail pane can be pure. */
  comments: Comment[];
  threads: Thread[];
  /** Called when the user clicks "Open with Claude" — stub for M9. */
  onOpenWithClaude: () => void;
  /** On narrow viewports, the detail pane can be dismissed back to the list. */
  onClose?: () => void;
}

export function NoteDetail({ item, comments, threads, onOpenWithClaude, onClose }: NoteDetailProps) {
  if (!item) {
    return (
      <aside className="detail-pane">
        <div className="detail-empty">
          <div style={{ fontSize: 28 }}>📑</div>
          <div>Select a row to see the full note.</div>
        </div>
      </aside>
    );
  }

  const { highlight, articleTitle, articleUrl } = item;
  /**
   * Only build a deep-link URL when we actually have an article URL. If the
   * proxy hasn't returned canonicalUrl yet (rare edge), fall back to the
   * empty string so the anchor is inert rather than navigating to "#thilko=…"
   * on the library page itself.
   */
  const openUrl = articleUrl ? `${articleUrl}#thilko=${encodeURIComponent(highlight.id)}` : "";
  const sortedComments = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  const sortedThreads = [...threads].sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return (
    <aside className="detail-pane">
      <div className="detail-header">
        <div className="detail-eyebrow-row">
          <div className="detail-eyebrow">Article</div>
          {onClose ? (
            <button type="button" className="detail-close" onClick={onClose} aria-label="Back to list">
              ✕
            </button>
          ) : null}
        </div>
        <div className="detail-article">{articleTitle || "(untitled)"}</div>
        {articleUrl ? (
          <div className="detail-article-url">
            <a href={articleUrl} target="_blank" rel="noopener noreferrer">{articleUrl}</a>
          </div>
        ) : (
          <div className="detail-article-url" style={{ color: "var(--muted)" }}>
            (article URL not yet indexed)
          </div>
        )}
      </div>

      <div className="detail-quote">"{highlight.anchor.quote.exact}"</div>

      <div className="detail-body">
        <section>
          <h3 className="detail-section-title">💬 Comments ({sortedComments.length})</h3>
          {sortedComments.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>No comments on this highlight.</div>
          ) : (
            sortedComments.map((c) => (
              <div className="detail-comment" key={c.id}>
                <div>{c.text}</div>
                <div className="detail-comment-meta">{formatTimestamp(c.createdAt)}</div>
              </div>
            ))
          )}
        </section>

        <section>
          <h3 className="detail-section-title">✨ Threads ({sortedThreads.length})</h3>
          {sortedThreads.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>No AI threads on this highlight.</div>
          ) : (
            sortedThreads.map((t) => (
              <ThreadCard key={t.id} thread={t} />
            ))
          )}
        </section>
      </div>

      <div className="detail-actions">
        {openUrl ? (
          <a className="primary" href={openUrl} target="_blank" rel="noopener noreferrer">
            ↗ Open article
          </a>
        ) : (
          <button type="button" className="primary" disabled title="Article URL not yet available">
            ↗ Open article
          </button>
        )}
        <button type="button" onClick={onOpenWithClaude} title="Coming in M9">
          📤 Open with Claude
        </button>
      </div>
    </aside>
  );
}

function ThreadCard({ thread }: { thread: Thread }) {
  const messages = thread.messages;
  return (
    <div className="detail-thread">
      <div className="detail-thread-meta">
        {messages.length} message{messages.length === 1 ? "" : "s"} · {formatTimestamp(thread.lastMessageAt)}
      </div>
      {messages.map((m, i) => (
        <div className="detail-thread-msg" key={`${m.role}-${m.createdAt}-${i}`}>
          <span className="detail-thread-msg-role">{m.role === "user" ? "You" : "AI"}</span>
          <span>{m.content}</span>
        </div>
      ))}
    </div>
  );
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// (Reserved for a future highlight-only detail render variant if needed.)
export type _ListItemHighlight = ListItemHighlight;
