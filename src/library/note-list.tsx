/**
 * Note list — middle column. Renders ListItem rows, supports active
 * selection, and reflects a `loading` state from the parent.
 */

import { type ListItem, type KindFilter } from "./library-types.js";

export interface NoteListProps {
  items: ListItem[];
  activeRowKey: string | null;
  /** Filter chips. */
  kindFilter: KindFilter;
  onKindFilterChange: (k: KindFilter) => void;
  onSelect: (item: ListItem) => void;
  /** Information label shown in the toolbar (e.g., "3 results · semantic search"). */
  info?: string;
  loading?: boolean;
}

const KINDS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "comment", label: "💬 Comments" },
  { value: "thread", label: "✨ Threads" },
  { value: "highlight", label: "🔖 Highlights" },
];

export function NoteList({ items, activeRowKey, kindFilter, onKindFilterChange, onSelect, info, loading }: NoteListProps) {
  return (
    <div className="list-pane">
      <div className="list-toolbar" role="toolbar" aria-label="Filter notes">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            className={`filter-chip${kindFilter === k.value ? " active" : ""}`}
            onClick={() => onKindFilterChange(k.value)}
            aria-pressed={kindFilter === k.value}
          >
            {k.label}
          </button>
        ))}
        {info ? <div className="list-toolbar-info">{info}</div> : null}
      </div>

      <div className="list" aria-busy={loading ? "true" : "false"}>
        {items.length === 0 ? (
          <div className="list-empty">
            {loading ? "Loading…" : "No notes here yet. Highlight text on any article to start."}
          </div>
        ) : (
          items.map((item) => (
            <button
              key={item.rowKey}
              type="button"
              className={`list-row${activeRowKey === item.rowKey ? " active" : ""}`}
              onClick={() => onSelect(item)}
            >
              <div className="list-row-article" title={item.articleTitle}>{item.articleTitle || "(untitled)"}</div>
              <div className="list-row-quote">{truncate(item.highlight.anchor.quote.exact, 200)}</div>
              <div className="list-row-preview">{truncate(item.preview, 220)}</div>
              <div className="list-row-meta">
                <KindBadge item={item} />
                {item.score !== undefined ? <span className="list-row-badge score">match {(item.score * 100).toFixed(0)}%</span> : null}
                <span className="list-row-time">{formatTimestamp(item.sortTimestamp)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function KindBadge({ item }: { item: ListItem }) {
  if (item.kind === "comment") return <span className="list-row-badge">💬 comment</span>;
  if (item.kind === "thread") {
    const n = item.thread.messages.length;
    return <span className="list-row-badge">✨ {n} msg{n === 1 ? "" : "s"}</span>;
  }
  return <span className="list-row-badge muted">🔖 highlight</span>;
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
