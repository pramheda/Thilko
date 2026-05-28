/**
 * Typed message protocol between extension surfaces.
 *
 * - content script / options page → background SW: request (RpcRequest)
 * - background SW → caller: response (RpcResponse)
 *
 * Centralizing dispatch through the background SW keeps the Supermemory and
 * proxy traffic inside one process (better for caching, debugging, future
 * rate-limit coordination) and avoids surfacing the proxy secret to other
 * extension contexts unnecessarily.
 */

import {
  type Anchor,
  type ConnectionStatus,
  type Highlight,
  type Comment,
  type Thread,
  type ThreadMessage,
  type Topic,
} from "./types.js";

export type RpcRequest =
  | { kind: "getConnectionStatus" }
  | { kind: "recheckConnection" }
  | { kind: "getActivationSettings" }
  | { kind: "ensureArticle"; url: string; title: string; contentType?: "html" | "pdf" }
  | { kind: "createHighlight"; articleId: string; anchor: Anchor; topicIds?: string[]; id?: string }
  | { kind: "updateHighlight"; id: string; patch: Partial<{ anchor: Anchor; topicIds: string[]; orphaned: boolean }> }
  | { kind: "deleteHighlight"; id: string }
  | { kind: "listHighlights"; articleId?: string }
  | { kind: "createComment"; highlightId: string; articleId: string; text: string; id?: string }
  | { kind: "updateComment"; id: string; text: string }
  | { kind: "deleteComment"; id: string }
  | { kind: "listComments"; highlightId?: string; articleId?: string }
  | { kind: "createThread"; highlightId: string; articleId: string; messages?: ThreadMessage[] }
  | { kind: "appendToThread"; threadId: string; message: ThreadMessage }
  | { kind: "updateThread"; id: string; messages: ThreadMessage[] }
  | { kind: "deleteThread"; id: string }
  | { kind: "listThreads"; highlightId?: string; articleId?: string }
  | { kind: "search"; q: string; filters?: { kinds?: string[]; articleId?: string; highlightId?: string; topicId?: string } }
  | { kind: "listTopics" }
  | { kind: "openClaude" }
  | { kind: "openInChat"; target: "claude" | "chatgpt"; text: string }
  | { kind: "readOpLog" }
  | { kind: "clearOpLog" }
  | { kind: "resetAllData" };

export type RpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export type ConnectionStatusResult = ConnectionStatus;
export type EnsureArticleResult = { articleId: string; supermemoryDocId: string; status: string; canonicalUrl: string; title: string };
export type CreateHighlightResult = { highlight: Highlight };
export type UpdateHighlightResult = { highlight: Highlight };
export type DeleteResult = { ok: true };
export type ListHighlightsResult = { highlights: Highlight[] };
export type CreateCommentResult = { comment: Comment };
export type ListCommentsResult = { comments: Comment[] };
export type CreateThreadResult = { thread: Thread };
export type AppendToThreadResult = { thread: Thread; deduped: boolean };
export type ListThreadsResult = { threads: Thread[] };
export type SearchResult = { results: Array<{ kind: string; item: Highlight | Comment | Thread; score?: number; snippet: string }> };
export type ListTopicsResult = { topics: Topic[] };
