/**
 * Typed RPC client for the Codex+Memory proxy.
 *
 * All calls send Bearer PROXY_SECRET + X-Token-Slot, matching the contract in
 * the proxy's memory.ts. Used from the background service worker; not from
 * content scripts or library page directly (browser secret hygiene).
 */

import {
  type Anchor,
  type Article,
  type Comment,
  type HealthResponse,
  type Highlight,
  type Thread,
  type ThreadMessage,
  type Topic,
} from "./types.js";

export interface ProxyCreds {
  proxyUrl: string;
  proxySecret: string;
  slot: string;
}

export class ProxyApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RawErrorBody {
  error?: { code?: string; message?: string };
}

async function request<T>(
  creds: ProxyCreds,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${creds.proxyUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.proxySecret}`,
    "X-Token-Slot": creds.slot,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = init.signal ? undefined : new AbortController();
  const timeoutMs = init.timeoutMs ?? 30_000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: init.signal ?? controller?.signal,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ProxyApiError(0, "timeout", `Request timed out after ${timeoutMs}ms`);
    }
    throw new ProxyApiError(0, "network", e instanceof Error ? e.message : String(e));
  }
  if (timer) clearTimeout(timer);

  const text = await response.text();
  if (!response.ok) {
    let parsed: RawErrorBody | undefined;
    try {
      parsed = text ? (JSON.parse(text) as RawErrorBody) : undefined;
    } catch {
      // text not JSON
    }
    throw new ProxyApiError(
      response.status,
      parsed?.error?.code ?? `http_${response.status}`,
      parsed?.error?.message ?? (text || `HTTP ${response.status}`),
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ProxyApiError(
      response.status,
      "bad_response",
      `Could not parse response as JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function health(creds: ProxyCreds, opts: { timeoutMs?: number } = {}): Promise<HealthResponse> {
  return request<HealthResponse>(
    creds,
    "GET",
    `/health?slot=${encodeURIComponent(creds.slot)}`,
    undefined,
    { timeoutMs: opts.timeoutMs ?? 5_000 },
  );
}

export interface PingResponse {
  ok: true;
  slot: string;
  memoryReady: boolean;
  serverTime: number;
}

/**
 * Auth-validating ping. Verifies that PROXY_SECRET + slot are accepted by the
 * proxy. Returns memoryReady=false when SUPERMEMORY_API_KEY is not set on the
 * proxy. Cheaper than any other memory route — does NOT call Supermemory.
 * Used for periodic connection checks so the indicator distinguishes
 * "wrong secret" from "Codex token expired".
 */
export async function ping(creds: ProxyCreds, opts: { timeoutMs?: number } = {}): Promise<PingResponse> {
  return request<PingResponse>(
    creds,
    "POST",
    "/memory/ping",
    {},
    { timeoutMs: opts.timeoutMs ?? 5_000 },
  );
}

export interface ArticleEnsureResponse {
  articleId: string;
  supermemoryDocId: string;
  status: "exists" | "queued" | string;
  canonicalUrl: string;
  title: string;
}

export async function ensureArticle(
  creds: ProxyCreds,
  input: { url: string; title: string; contentType?: "html" | "pdf" },
): Promise<ArticleEnsureResponse> {
  return request<ArticleEnsureResponse>(creds, "POST", "/memory/article", input);
}

// Highlight CRUD ────────────────────────────────────────────────────────────

export interface CreateHighlightInput {
  id?: string;
  articleId: string;
  anchor: Anchor;
  topicIds?: string[];
  orphaned?: boolean;
}

export async function createHighlight(
  creds: ProxyCreds,
  input: CreateHighlightInput,
): Promise<{ highlight: Highlight }> {
  return request(creds, "POST", "/memory/highlight", { op: "create", highlight: input });
}

export async function updateHighlight(
  creds: ProxyCreds,
  id: string,
  patch: Partial<{ anchor: Anchor; topicIds: string[]; orphaned: boolean }>,
): Promise<{ highlight: Highlight }> {
  return request(creds, "POST", "/memory/highlight", { op: "update", id, patch });
}

export async function deleteHighlight(creds: ProxyCreds, id: string): Promise<{ ok: true }> {
  return request(creds, "POST", "/memory/highlight", { op: "delete", id });
}

export async function listHighlights(
  creds: ProxyCreds,
  filter: { articleId?: string } = {},
): Promise<{ highlights: Highlight[] }> {
  return request(creds, "POST", "/memory/highlight", { op: "list", ...filter });
}

// Comment CRUD ──────────────────────────────────────────────────────────────

export interface CreateCommentInput {
  id?: string;
  highlightId: string;
  articleId: string;
  text: string;
}

export async function createComment(
  creds: ProxyCreds,
  input: CreateCommentInput,
): Promise<{ comment: Comment }> {
  return request(creds, "POST", "/memory/note", { op: "create", comment: input });
}

export async function updateComment(
  creds: ProxyCreds,
  id: string,
  patch: Partial<{ text: string }>,
): Promise<{ comment: Comment }> {
  return request(creds, "POST", "/memory/note", { op: "update", id, patch });
}

export async function deleteComment(creds: ProxyCreds, id: string): Promise<{ ok: true }> {
  return request(creds, "POST", "/memory/note", { op: "delete", id });
}

export async function listComments(
  creds: ProxyCreds,
  filter: { highlightId?: string; articleId?: string } = {},
): Promise<{ comments: Comment[] }> {
  return request(creds, "POST", "/memory/note", { op: "list", ...filter });
}

// Thread CRUD ───────────────────────────────────────────────────────────────

export interface CreateThreadInput {
  highlightId: string;
  articleId: string;
  messages?: ThreadMessage[];
}

export async function createThread(
  creds: ProxyCreds,
  input: CreateThreadInput,
): Promise<{ thread: Thread }> {
  return request(creds, "POST", "/memory/thread", { op: "create", thread: input });
}

export async function appendToThread(
  creds: ProxyCreds,
  threadId: string,
  message: ThreadMessage,
): Promise<{ thread: Thread; deduped: boolean }> {
  return request(creds, "POST", "/memory/thread", { op: "append", threadId, message });
}

/**
 * Replace a thread's messages array in a single atomic write. Used when we
 * need to persist multiple messages as one turn (user + assistant) without
 * a window where only the user message is stored.
 */
export async function updateThread(
  creds: ProxyCreds,
  id: string,
  patch: Partial<{ messages: ThreadMessage[] }>,
): Promise<{ thread: Thread }> {
  return request(creds, "POST", "/memory/thread", { op: "update", id, patch });
}

export async function deleteThread(creds: ProxyCreds, id: string): Promise<{ ok: true }> {
  return request(creds, "POST", "/memory/thread", { op: "delete", id });
}

export async function listThreads(
  creds: ProxyCreds,
  filter: { highlightId?: string; articleId?: string } = {},
): Promise<{ threads: Thread[] }> {
  return request(creds, "POST", "/memory/thread", { op: "list", ...filter });
}

// Search + topics ───────────────────────────────────────────────────────────

export interface SearchHit {
  kind: "highlight" | "comment" | "thread" | string;
  item: Highlight | Comment | Thread;
  score?: number;
  snippet: string;
}

export async function search(
  creds: ProxyCreds,
  q: string,
  filters?: { kinds?: string[]; articleId?: string; highlightId?: string; topicId?: string },
): Promise<{ results: SearchHit[] }> {
  return request(creds, "POST", "/memory/search", { q, filters });
}

export async function listTopics(creds: ProxyCreds): Promise<{ topics: Topic[] }> {
  return request(creds, "POST", "/memory/topics", {});
}

// Reference for downstream code — re-export so importers don't need types.js too.
export type { Article, Highlight, Comment, Thread, ThreadMessage, Topic };
