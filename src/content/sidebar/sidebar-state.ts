/**
 * Snapshot of the sidebar's view of the world. Built by content/index.ts and
 * pushed into the sidebar whenever the underlying state.records /
 * commentCounts / threadCounts maps mutate.
 *
 * Lives separately from the React component so the data shape is testable
 * and the React tree can render purely on this prop.
 */

import { type Comment, type Highlight, type Thread } from "../../shared/types.js";

export interface SidebarHighlightEntry {
  highlight: Highlight;
  commentCount: number;
  threadCount: number;
  /** First comment text (truncated by the renderer), if any — used as the preview. */
  firstCommentPreview: string | null;
  /** Snippet of the most recent thread's last message, if any. */
  latestThreadPreview: string | null;
  /** Whether the highlight is currently rendered on the page (false → orphan). */
  rendered: boolean;
}

export interface SidebarState {
  articleTitle: string;
  articleUrl: string;
  /** Live highlights (rendered === true). Sorted by createdAt asc. */
  live: SidebarHighlightEntry[];
  /** Orphans (rendered === false). Sorted by createdAt desc. */
  orphans: SidebarHighlightEntry[];
}

export type SidebarStateBuilderInput = {
  articleTitle: string;
  articleUrl: string;
  records: Map<string, { highlight: Highlight; rendered: { unrender: () => void } | null; orphan: boolean }>;
  comments: Comment[];
  threads: Thread[];
};

/**
 * Build a SidebarState from the content script's authoritative state.
 *
 * Pure function — exposed for unit tests; the runtime caller passes the
 * current Maps from content/index.ts.
 */
export function buildSidebarState(input: SidebarStateBuilderInput): SidebarState {
  // Group comments by highlightId, sorted by createdAt asc.
  const commentsByHl = new Map<string, Comment[]>();
  for (const c of input.comments) {
    const arr = commentsByHl.get(c.highlightId);
    if (arr) arr.push(c);
    else commentsByHl.set(c.highlightId, [c]);
  }
  for (const arr of commentsByHl.values()) arr.sort((a, b) => a.createdAt - b.createdAt);

  // Group threads by highlightId, sorted by lastMessageAt desc.
  const threadsByHl = new Map<string, Thread[]>();
  for (const t of input.threads) {
    const arr = threadsByHl.get(t.highlightId);
    if (arr) arr.push(t);
    else threadsByHl.set(t.highlightId, [t]);
  }
  for (const arr of threadsByHl.values()) arr.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  const entries: SidebarHighlightEntry[] = [];
  for (const rec of input.records.values()) {
    const cs = commentsByHl.get(rec.highlight.id) ?? [];
    const ts = threadsByHl.get(rec.highlight.id) ?? [];
    const firstComment = cs[0]?.text ?? null;
    const latestThread = ts[0];
    const latestMessage = latestThread?.messages[latestThread.messages.length - 1];
    const threadPreview = latestMessage ? `${latestMessage.role === "user" ? "You" : "AI"}: ${latestMessage.content}` : null;
    entries.push({
      highlight: rec.highlight,
      commentCount: cs.length,
      threadCount: ts.length,
      firstCommentPreview: firstComment,
      latestThreadPreview: threadPreview,
      rendered: !!rec.rendered,
    });
  }

  const live = entries.filter((e) => e.rendered).sort((a, b) => a.highlight.createdAt - b.highlight.createdAt);
  const orphans = entries.filter((e) => !e.rendered).sort((a, b) => b.highlight.createdAt - a.highlight.createdAt);

  return {
    articleTitle: input.articleTitle,
    articleUrl: input.articleUrl,
    live,
    orphans,
  };
}
