/**
 * Library-page-only types — flat shapes the list/detail renderers consume.
 *
 * The library page assembles these from the typed RPCs (listHighlights /
 * listComments / listThreads). When a search query is active, we instead use
 * `/memory/search` results and hydrate items per kind.
 */

import { type Comment, type Highlight, type Thread } from "../shared/types.js";

/**
 * An item in the main list. Each item points back to its highlight; the
 * kind discriminator drives the preview + the detail-pane content.
 *
 * For a highlight that has both comments and threads, the list shows one
 * row per kind so the user can find any of them via filter chips. (Tradeoff:
 * a chatty highlight shows up multiple times — but each row's detail is
 * coherent.)
 */
export interface ListItemBase {
  kind: "highlight" | "comment" | "thread";
  /** Stable react key; derived from the kind + the item id. */
  rowKey: string;
  highlight: Highlight;
  /** Cached canonical URL/title for the article that owns this highlight. */
  articleTitle: string;
  articleUrl: string;
  /** Most-recent timestamp for sorting — comment.updatedAt / thread.lastMessageAt / highlight.updatedAt. */
  sortTimestamp: number;
  /** Optional similarity score from /memory/search. */
  score?: number;
  /** Preview text for the row. */
  preview: string;
}

export interface ListItemHighlight extends ListItemBase {
  kind: "highlight";
  /** Comments/threads attached, used by the detail pane. */
  comments: Comment[];
  threads: Thread[];
}

export interface ListItemComment extends ListItemBase {
  kind: "comment";
  comment: Comment;
}

export interface ListItemThread extends ListItemBase {
  kind: "thread";
  thread: Thread;
}

export type ListItem = ListItemHighlight | ListItemComment | ListItemThread;

export type KindFilter = "all" | "highlight" | "comment" | "thread";

export interface ArticleSummary {
  articleId: string;
  title: string;
  url: string;
}
