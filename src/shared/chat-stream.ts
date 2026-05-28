/**
 * Typed protocol for the streaming-chat port between content script and
 * background SW.
 *
 * Lifecycle:
 *   1. Content script: chrome.runtime.connect({ name: "thilko-chat" })
 *   2. Content posts a `start` message with the chat request body.
 *   3. Background SW opens a streaming fetch to /memory/chat.
 *   4. Background SW parses SSE events as they arrive and forwards
 *      domain-level events (delta, done, error) to the content script.
 *   5. On disconnect (popover closed mid-stream), background aborts the
 *      upstream fetch.
 */

export interface ChatTurnWire {
  role: "user" | "assistant";
  content: string;
}

export interface ChatStreamStart {
  type: "start";
  /** Will be echoed in every event for client-side correlation. */
  requestId: string;
  systemPrompt: string;
  contextBlocks?: Array<{ label: string; text: string }>;
  history?: ChatTurnWire[];
  userMessage: string;
  model?: string;
}

export interface ChatStreamDelta {
  type: "delta";
  requestId: string;
  text: string;
}

export interface ChatStreamDone {
  type: "done";
  requestId: string;
  /** Full reconstructed assistant text (sum of all deltas). */
  finalText: string;
  /** Upstream usage info when available. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ChatStreamError {
  type: "error";
  requestId: string;
  code: string;
  message: string;
}

/**
 * Emitted when Dabbis's web_search tool kicks off a query. Codex doesn't
 * include the query text in the in-progress event itself — we only learn
 * the query when the search completes (in the output_item.done event's
 * action.queries[]). So `query` is null on `started` and only set on
 * `completed`. The popover UI shows an inline "Searching for…" indicator
 * while at least one search is active.
 *
 * `itemId` is the Codex item id (`ws_…`) so the client can match the
 * later completion event to the right started event when multiple
 * sequential searches run.
 */
export interface ChatStreamSearch {
  type: "search";
  requestId: string;
  /** Codex item id (`ws_…`). Stable across started/completed for one search. */
  itemId: string;
  status: "started" | "completed";
  /** The query string. Only present on `completed`. */
  query: string | null;
}

export type ChatStreamClientMessage = ChatStreamStart;
export type ChatStreamServerMessage = ChatStreamDelta | ChatStreamDone | ChatStreamError | ChatStreamSearch;

export const CHAT_PORT_NAME = "thilko-chat";
