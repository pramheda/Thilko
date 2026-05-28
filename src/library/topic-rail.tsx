/**
 * Topics rail — left column. Lists "All" plus one entry per article-with-
 * annotations (v1 interpretation per plan §1; semantic clusters union in
 * later when Supermemory ships the graph endpoint).
 *
 * Selecting a topic filters the note list to that article. Selecting "All"
 * clears the filter.
 */

import { type Topic } from "../shared/types.js";

export interface TopicRailProps {
  topics: Topic[];
  activeArticleId: string | null;
  totalCount: number;
  onSelect: (articleId: string | null) => void;
  /** Optional — shown as a chip when a topic is active. */
  onOpenActiveInClaude?: () => void;
}

export function TopicRail({ topics, activeArticleId, totalCount, onSelect, onOpenActiveInClaude }: TopicRailProps) {
  const sorted = [...topics].sort((a, b) => b.memoryCount - a.memoryCount);

  return (
    <aside className="topic-rail">
      <div className="topic-rail-title">Topics</div>
      <button
        type="button"
        className={`topic-row${activeArticleId === null ? " active" : ""}`}
        onClick={() => onSelect(null)}
        aria-pressed={activeArticleId === null}
      >
        <span className="topic-row-label">All notes</span>
        <span className="topic-row-count">{totalCount}</span>
      </button>
      {sorted.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`topic-row${activeArticleId === t.id ? " active" : ""}`}
          onClick={() => onSelect(t.id)}
          title={t.label}
          aria-pressed={activeArticleId === t.id}
        >
          <span className="topic-row-label">{t.label}</span>
          <span className="topic-row-count">{t.memoryCount}</span>
        </button>
      ))}
      {activeArticleId !== null && onOpenActiveInClaude ? (
        <button
          type="button"
          className="topic-open-claude"
          onClick={onOpenActiveInClaude}
          title="Copy a summary of every highlight in this topic and open Claude"
        >
          📤 Open all in Claude
        </button>
      ) : null}
    </aside>
  );
}
