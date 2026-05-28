/**
 * Library app — top-level component.
 *
 * Data flow:
 *   - On mount: parallel listHighlights / listComments / listThreads / listTopics
 *     via background RPC.
 *   - Build ListItems: each highlight produces a "highlight" row; each comment
 *     and thread also produce their own rows so kind-filter and search work.
 *   - Search bar (250ms debounced) calls /memory/search; results re-rank the
 *     list with similarity scores.
 *   - Topic rail = articles. Clicking filters by articleId.
 *   - Kind chips: all | highlight | comment | thread.
 *   - Cross-tab updates: subscribes to chrome.storage.local["thilko_data_version"]
 *     change events and re-fetches when the timestamp updates.
 *
 * Connection state is also surfaced (small dot in header) so the user knows
 * when the backend is reachable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Comment,
  type ConnectionStatus,
  type Highlight,
  type Thread,
  type Topic,
} from "../shared/types.js";
import { type RpcRequest, type RpcResponse } from "../shared/messages.js";
import { type ArticleSummary, type KindFilter, type ListItem } from "./library-types.js";
import { SearchBar } from "./search-bar.js";
import { TopicRail } from "./topic-rail.js";
import { NoteList } from "./note-list.js";
import { NoteDetail } from "./note-detail.js";
import { buildMemorySummary, type SummaryHighlightItem } from "../shared/memory-summary.js";
import { openWithClaude } from "../shared/claude-handoff.js";

const DATA_VERSION_KEY = "thilko_data_version";

async function rpc<T>(req: RpcRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(req)) as RpcResponse | undefined;
  if (!r) throw new Error("Background SW did not respond");
  if (!r.ok) {
    const err = new Error(`${r.error.code}: ${r.error.message}`);
    (err as Error & { code?: string }).code = r.error.code;
    throw err;
  }
  return r.data as T;
}

interface SearchHitRaw {
  kind: string;
  item: Highlight | Comment | Thread;
  score?: number;
  snippet: string;
}

interface DataSnapshot {
  highlights: Highlight[];
  comments: Comment[];
  threads: Thread[];
  topics: Topic[];
}

export function App() {
  const [data, setData] = useState<DataSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Active query — drives /memory/search when non-empty. */
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHitRaw[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ kind: "unconfigured" });
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /** On narrow viewports, the detail pane is offscreen by default; toggled by row click. */
  const [detailMobileOpen, setDetailMobileOpen] = useState(false);

  // ── Data loading ────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const [hs, cs, ts, tp] = await Promise.all([
        rpc<{ highlights: Highlight[] }>({ kind: "listHighlights" }),
        rpc<{ comments: Comment[] }>({ kind: "listComments" }),
        rpc<{ threads: Thread[] }>({ kind: "listThreads" }),
        rpc<{ topics: Topic[] }>({ kind: "listTopics" }),
      ]);
      setData({
        highlights: hs.highlights,
        comments: cs.comments,
        threads: ts.threads,
        topics: tp.topics,
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-tab data-change subscription. Background bumps this timestamp on
  // every successful write so other tabs (e.g., this library) can re-fetch
  // without polling.
  useEffect(() => {
    const handler = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: chrome.storage.AreaName) => {
      if (areaName !== "local") return;
      if (!changes[DATA_VERSION_KEY]) return;
      void refresh();
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [refresh]);

  // Connection status pull + 4s poll while page is open.
  useEffect(() => {
    let canceled = false;
    const tick = async () => {
      try {
        const s = await rpc<ConnectionStatus>({ kind: "getConnectionStatus" });
        if (!canceled) setConnectionStatus(s);
      } catch {
        // ignore — surfaced in the header indicator
      }
    };
    void tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      canceled = true;
      window.clearInterval(id);
    };
  }, []);

  // ── Search ──────────────────────────────────────────────────────────────

  const onSearch = useCallback(async (q: string) => {
    setQuery(q);
    // Bump the sequence unconditionally so any in-flight request (including
    // when the user clears the box) is recognized as stale and ignored.
    const seq = ++searchSeq.current;
    if (q.length === 0) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const filters = topicFilter ? { articleId: topicFilter } : undefined;
      const r = await rpc<{ results: SearchHitRaw[] }>({ kind: "search", q, filters });
      if (searchSeq.current !== seq) return; // a newer query superseded us
      setSearchResults(r.results);
    } catch (e) {
      if (searchSeq.current !== seq) return;
      setToast({ kind: "error", text: `Search failed: ${e instanceof Error ? e.message : String(e)}` });
      setSearchResults([]);
    } finally {
      if (searchSeq.current === seq) setSearching(false);
    }
  }, [topicFilter]);

  // Re-run the search when topicFilter changes (only if a query is active).
  useEffect(() => {
    if (query.length > 0) {
      void onSearch(query);
    }
  }, [topicFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // ── Build the list ─────────────────────────────────────────────────────

  const articleMetaById = useMemo(() => {
    const m = new Map<string, { title: string; url: string }>();
    if (!data) return m;
    for (const t of data.topics) {
      m.set(t.id, { title: t.label, url: t.canonicalUrl ?? "" });
    }
    return m;
  }, [data]);

  const articles: ArticleSummary[] = useMemo(() => {
    if (!data) return [];
    const byId = new Map<string, ArticleSummary>();
    for (const h of data.highlights) {
      if (!byId.has(h.articleId)) {
        const meta = articleMetaById.get(h.articleId);
        byId.set(h.articleId, {
          articleId: h.articleId,
          title: meta?.title ?? "(untitled)",
          url: meta?.url ?? "",
        });
      }
    }
    return Array.from(byId.values());
  }, [data, articleMetaById]);

  const allItems: ListItem[] = useMemo(() => {
    if (!data) return [];
    const items: ListItem[] = [];

    const titleFor = (articleId: string): string => articleMetaById.get(articleId)?.title ?? "(untitled)";
    const urlFor = (articleId: string): string => articleMetaById.get(articleId)?.url ?? "";

    // Pre-group comments + threads by highlight so we can attach them to the
    // highlight rows for the detail pane.
    const commentsByHl = new Map<string, Comment[]>();
    for (const c of data.comments) {
      const arr = commentsByHl.get(c.highlightId);
      if (arr) arr.push(c);
      else commentsByHl.set(c.highlightId, [c]);
    }
    const threadsByHl = new Map<string, Thread[]>();
    for (const t of data.threads) {
      const arr = threadsByHl.get(t.highlightId);
      if (arr) arr.push(t);
      else threadsByHl.set(t.highlightId, [t]);
    }

    for (const h of data.highlights) {
      const cs = commentsByHl.get(h.id) ?? [];
      const ts = threadsByHl.get(h.id) ?? [];

      // Highlight row.
      const hPreview = cs[0]?.text ?? ts[0]?.messages[ts[0]?.messages.length - 1]?.content ?? "No notes yet on this highlight.";
      items.push({
        kind: "highlight",
        rowKey: `hl:${h.id}`,
        highlight: h,
        articleTitle: titleFor(h.articleId),
        articleUrl: urlFor(h.articleId),
        sortTimestamp: h.updatedAt,
        preview: hPreview,
        comments: cs,
        threads: ts,
      });

      // One row per comment.
      for (const c of cs) {
        items.push({
          kind: "comment",
          rowKey: `cm:${c.id}`,
          highlight: h,
          articleTitle: titleFor(h.articleId),
          articleUrl: urlFor(h.articleId),
          sortTimestamp: c.updatedAt,
          preview: c.text,
          comment: c,
        });
      }

      // One row per thread.
      for (const t of ts) {
        const lastMsg = t.messages[t.messages.length - 1];
        const preview = lastMsg ? `${lastMsg.role === "user" ? "You" : "AI"}: ${lastMsg.content}` : "(empty thread)";
        items.push({
          kind: "thread",
          rowKey: `th:${t.id}`,
          highlight: h,
          articleTitle: titleFor(h.articleId),
          articleUrl: urlFor(h.articleId),
          sortTimestamp: t.lastMessageAt,
          preview,
          thread: t,
        });
      }
    }

    return items;
  }, [data, articleMetaById]);

  // ── Apply filters ──────────────────────────────────────────────────────

  const filteredItems: ListItem[] = useMemo(() => {
    let items = allItems;
    if (topicFilter !== null) items = items.filter((i) => i.highlight.articleId === topicFilter);
    if (kindFilter !== "all") items = items.filter((i) => i.kind === kindFilter);
    if (searchResults !== null) {
      // Rank by the search response. Map result→ListItem when our list has it.
      const order = new Map<string, { idx: number; score?: number }>();
      let idx = 0;
      for (const r of searchResults) {
        const id = (r.item as { id?: string } | undefined)?.id;
        if (!id) continue;
        const rowKey = `${r.kind === "highlight" ? "hl" : r.kind === "comment" ? "cm" : "th"}:${id}`;
        if (!order.has(rowKey)) order.set(rowKey, { idx, score: r.score });
        idx++;
      }
      items = items
        .filter((i) => order.has(i.rowKey))
        .map((i) => ({ ...i, score: order.get(i.rowKey)?.score }) as ListItem)
        .sort((a, b) => (order.get(a.rowKey)?.idx ?? 1e9) - (order.get(b.rowKey)?.idx ?? 1e9));
    } else {
      // No search active — sort by most-recent activity.
      items = [...items].sort((a, b) => b.sortTimestamp - a.sortTimestamp);
    }
    return items;
  }, [allItems, topicFilter, kindFilter, searchResults]);

  const totalCount = allItems.filter((i) => i.kind === "highlight").length;

  const activeItem = useMemo(() => filteredItems.find((i) => i.rowKey === activeRowKey) ?? null, [filteredItems, activeRowKey]);

  // ── Open with Claude handlers (definitions live below activeComments/Threads) ──

  const reportHandoff = useCallback((result: { clipboardOk: boolean; tabOk: boolean }) => {
    const { clipboardOk, tabOk } = result;
    if (clipboardOk && tabOk) setToast({ kind: "ok", text: "Memory summary copied — paste it into Claude." });
    else if (!clipboardOk && tabOk) setToast({ kind: "error", text: "Clipboard blocked. Tab opened — copy from selection and paste." });
    else if (clipboardOk && !tabOk) setToast({ kind: "error", text: "Copied. Couldn't open Claude tab automatically." });
    else setToast({ kind: "error", text: "Couldn't copy or open Claude. Try again." });
  }, []);

  const handleOpenTopicInClaude = useCallback(async () => {
    if (!data || topicFilter === null) return;
    const meta = articleMetaById.get(topicFilter);
    const articleTitle = meta?.title ?? "(untitled)";
    const articleUrl = meta?.url ?? "";
    // Pre-group by highlight for efficient lookups inside the per-article build.
    const commentsByHl = new Map<string, Comment[]>();
    for (const c of data.comments) {
      const arr = commentsByHl.get(c.highlightId);
      if (arr) arr.push(c);
      else commentsByHl.set(c.highlightId, [c]);
    }
    const threadsByHl = new Map<string, Thread[]>();
    for (const t of data.threads) {
      const arr = threadsByHl.get(t.highlightId);
      if (arr) arr.push(t);
      else threadsByHl.set(t.highlightId, [t]);
    }
    const highlights: SummaryHighlightItem[] = data.highlights
      .filter((h) => h.articleId === topicFilter)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((h) => ({
        quote: h.anchor.quote.exact,
        createdAt: h.createdAt,
        orphaned: h.orphaned,
        comments: (commentsByHl.get(h.id) ?? []).map((c) => ({ text: c.text, createdAt: c.createdAt })),
        threads: (threadsByHl.get(h.id) ?? []).map((t) => ({
          lastMessageAt: t.lastMessageAt,
          messages: t.messages.map((m) => ({ role: m.role, content: m.content })),
        })),
      }));
    const summary = buildMemorySummary({
      kind: "topic",
      topic: { label: articleTitle },
      articles: [{ article: { title: articleTitle, canonicalUrl: articleUrl }, highlights }],
    });
    reportHandoff(await openWithClaude(summary));
  }, [data, topicFilter, articleMetaById, reportHandoff]);

  // Resolve the comments + threads for the selected item.
  const activeComments: Comment[] = useMemo(() => {
    if (!activeItem || !data) return [];
    return data.comments.filter((c) => c.highlightId === activeItem.highlight.id);
  }, [activeItem, data]);
  const activeThreads: Thread[] = useMemo(() => {
    if (!activeItem || !data) return [];
    return data.threads.filter((t) => t.highlightId === activeItem.highlight.id);
  }, [activeItem, data]);

  const handleOpenHighlightInClaude = useCallback(async () => {
    if (!activeItem) return;
    const h = activeItem.highlight;
    const item: SummaryHighlightItem = {
      quote: h.anchor.quote.exact,
      createdAt: h.createdAt,
      orphaned: h.orphaned,
      comments: activeComments.map((c) => ({ text: c.text, createdAt: c.createdAt })),
      threads: activeThreads.map((t) => ({
        lastMessageAt: t.lastMessageAt,
        messages: t.messages.map((m) => ({ role: m.role, content: m.content })),
      })),
    };
    const summary = buildMemorySummary({
      kind: "highlight",
      article: { title: activeItem.articleTitle, canonicalUrl: activeItem.articleUrl },
      highlight: item,
    });
    reportHandoff(await openWithClaude(summary));
  }, [activeItem, activeComments, activeThreads, reportHandoff]);

  // ── Status indicator ───────────────────────────────────────────────────

  const statusDotClass =
    connectionStatus.kind === "ok"
      ? "ok"
      : connectionStatus.kind === "unconfigured"
        ? "warn"
        : "error";
  const statusLabel =
    connectionStatus.kind === "ok"
      ? "Connected"
      : connectionStatus.kind === "unconfigured"
        ? "Not configured"
        : `Disconnected: ${connectionStatus.reason}`;

  // ── Info line ───────────────────────────────────────────────────────────

  let info: string | undefined;
  if (loadError) {
    info = `Couldn't load: ${loadError}`;
  } else if (searchResults !== null) {
    info = `${filteredItems.length} result${filteredItems.length === 1 ? "" : "s"} for "${query}"${searching ? " · refreshing" : ""}`;
  } else if (filteredItems.length > 0) {
    info = `${filteredItems.length} row${filteredItems.length === 1 ? "" : "s"}`;
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-title">
          Thilko<span className="app-title-sub"> — library</span>
        </div>
        <SearchBar onSearch={onSearch} loading={searching} />
        <div className="app-status" role="status">
          <span className={`dot ${statusDotClass}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
      </div>

      <div className="app-body">
        <TopicRail
          topics={data?.topics ?? []}
          activeArticleId={topicFilter}
          totalCount={totalCount}
          onSelect={setTopicFilter}
          onOpenActiveInClaude={() => { void handleOpenTopicInClaude(); }}
        />

        <NoteList
          items={filteredItems}
          activeRowKey={activeRowKey}
          kindFilter={kindFilter}
          onKindFilterChange={setKindFilter}
          onSelect={(item) => {
            setActiveRowKey(item.rowKey);
            setDetailMobileOpen(true);
          }}
          info={info}
          loading={loading}
        />

        <div className={`detail-pane-wrap${detailMobileOpen ? " detail-mobile-open" : ""}`}>
          <NoteDetail
            item={activeItem}
            comments={activeComments}
            threads={activeThreads}
            onOpenWithClaude={() => { void handleOpenHighlightInClaude(); }}
            onClose={() => setDetailMobileOpen(false)}
          />
        </div>
      </div>

      {toast ? <div className={`toast ${toast.kind}`} role="status">{toast.text}</div> : null}
    </div>
  );
}
