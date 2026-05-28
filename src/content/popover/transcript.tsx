/**
 * Transcript — the unified conversation surface (PR2).
 *
 * This replaces the old CommentsSection + ThreadsSection split. One grid
 * holds everything: a quiet CommentStrip at the top, then the chat turns
 * (user + assistant) in chronological order, then a live streaming bubble
 * while Dabbis is thinking.
 *
 * Layout: CSS grid `24px 1fr`. The 24px gutter exists ONLY so the mascot
 * has a column to land in on the first assistant turn. On subsequent
 * assistant turns the gutter is empty (and on user turns too), but the
 * column stays so prose never jitters between turns. User turns get an
 * accent left-stripe.
 *
 * Threading model: v1 consolidates to ONE conversation per highlight.
 * Messages from all existing `threads` are flattened chronologically into
 * a single transcript. New sends append to the most recent thread, or
 * create a new thread with the initial turn if none exists.
 *
 * Streaming flow (ported from the retired ThreadView):
 *   1. User submits a turn via Composer.
 *   2. Optimistically push the user turn into local state.
 *   3. Open chrome.runtime.connect port to the background SW.
 *   4. As deltas arrive, accumulate into a streaming assistant bubble.
 *   5. On `done`: persist atomically via createThread (new) or updateThread
 *      (existing) so there's no window where the user turn is on the server
 *      without its assistant pair.
 *   6. On `error` or disconnect: roll back the optimistic user turn so the
 *      conversation stays consistent with what's persisted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Comment, type Thread, type ThreadMessage } from "../../shared/types.js";
import { Markdown } from "./markdown.js";
import { CommentStrip } from "./comment-strip.js";
import { Composer, type ComposerMode } from "./composer.js";
import { Mascot } from "../ui/mascot.js";
import {
  CHAT_PORT_NAME,
  type ChatStreamClientMessage,
  type ChatStreamServerMessage,
} from "../../shared/chat-stream.js";
import { assembleContext, type ArticleContext, type HighlightContext } from "./context-budget.js";
import { type RpcRequest, type RpcResponse } from "../../shared/messages.js";

async function rpc<T>(req: RpcRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(req)) as RpcResponse | undefined;
  if (!r) throw new Error("Background SW did not respond");
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as T;
}

export interface TranscriptProps {
  highlightId: string;
  articleId: string;
  article: ArticleContext;
  highlightContext: HighlightContext;

  /** Existing comments (passed from Popover's state). */
  comments: Comment[];
  /** Existing threads. May be empty for fresh highlights. */
  threads: Thread[];

  /** Parent-supplied side effects. */
  onAddComment: (text: string) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
  onThreadsChanged: (next: Thread[]) => void;

  /** Idempotent — flush local highlight to proxy before first attached write. */
  ensureHighlightPersisted?: () => Promise<void>;

  /** Comment toolbar → "note"; Ask Dabbis-AI toolbar → "chat". */
  initialMode: ComposerMode;
  /** Focus the composer on mount (true for fresh-from-toolbar opens). */
  autoFocus?: boolean;
}

/** A turn that's actually displayed in the transcript. */
interface DisplayedTurn {
  key: string;
  role: "user" | "assistant";
  content: string;
}

interface LiveStream {
  requestId: string;
  port: chrome.runtime.Port;
  text: string;
  userTurn: ThreadMessage;
  /** Web searches Dabbis has kicked off this turn. Each entry is one
   *  search item from Codex (matched by itemId between started/completed).
   *  Order is chronological; an "active" entry has no query yet. */
  searches: Array<{ itemId: string; status: "active" | "done"; query: string | null }>;
}

export function Transcript(props: TranscriptProps) {
  const {
    highlightId,
    articleId,
    article,
    highlightContext,
    comments,
    threads,
    onAddComment,
    onDeleteComment,
    onThreadsChanged,
    ensureHighlightPersisted,
    initialMode,
    autoFocus,
  } = props;

  // Local optimistic state. The persisted source of truth is `threads`; this
  // mirror exists so we can render the user turn the moment they press Send,
  // before the network round-trip completes.
  const [optimisticTurns, setOptimisticTurns] = useState<ThreadMessage[]>([]);
  const [live, setLive] = useState<LiveStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Always points at the current `live` state. The unmount cleanup uses
   * this (not the captured value) so closing the popover during a stream
   * actually disconnects the port — which in turn signals the background
   * to abort the upstream Codex call.
   */
  const liveRef = useRef<LiveStream | null>(null);
  liveRef.current = live;

  // Disconnect any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      const current = liveRef.current;
      if (current) {
        try { current.port.disconnect(); } catch { /* noop */ }
      }
    };
  }, []);

  // Auto-dismiss errors.
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(id);
  }, [error]);

  // Compose the flat, chronological message list:
  //   1. Persisted messages from every thread, sorted by createdAt.
  //   2. Optimistic turns that haven't been merged back into `threads` yet.
  // Optimistic turns sort by createdAt too, so they slot in chronologically.
  const allTurns: DisplayedTurn[] = useMemo(() => {
    const persisted: ThreadMessage[] = [];
    for (const t of threads) persisted.push(...t.messages);
    const merged = [...persisted, ...optimisticTurns].sort((a, b) => a.createdAt - b.createdAt);
    return merged.map((m, i): DisplayedTurn => ({
      key: `${m.role}-${m.createdAt}-${i}`,
      role: m.role,
      content: m.content,
    }));
  }, [threads, optimisticTurns]);

  // Index of the first assistant turn — only that turn gets a mascot in the
  // gutter. Subsequent assistant turns leave col 1 empty so prose stays
  // aligned but the mascot doesn't repeat.
  const firstAssistantIndex = useMemo(
    () => allTurns.findIndex((t) => t.role === "assistant"),
    [allTurns],
  );

  // Scroll to bottom whenever the transcript grows.
  useEffect(() => {
    const s = scrollerRef.current;
    if (s) s.scrollTop = s.scrollHeight;
  }, [allTurns.length, live?.text]);

  // ── Submit handlers ─────────────────────────────────────────────────────

  const handleNoteSubmit = useCallback(async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      if (ensureHighlightPersisted) await ensureHighlightPersisted();
      await onAddComment(text);
    } catch (e) {
      setError(`Couldn't save note: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [ensureHighlightPersisted, onAddComment]);

  const handleChatSubmit = useCallback(async (text: string) => {
    if (live) return; // already streaming
    setError(null);

    const now = Date.now();
    const userTurn: ThreadMessage = { role: "user", content: text, createdAt: now };
    setOptimisticTurns((prev) => [...prev, userTurn]);

    // Build the per-turn context. History excludes the user turn we just
    // added — it's sent via the dedicated `userMessage` field.
    const historyMessages: ThreadMessage[] = [];
    for (const t of threads) historyMessages.push(...t.messages);
    historyMessages.push(...optimisticTurns);

    const assembled = assembleContext({
      article,
      highlight: highlightContext,
      history: historyMessages,
      userMessage: text,
    });

    const requestId = crypto.randomUUID();
    const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
    const liveState: LiveStream = { requestId, port, text: "", userTurn, searches: [] };
    setLive(liveState);

    /**
     * Track whether `done` fired — used by the disconnect handler to decide
     * whether to roll back. Mirrors the contract in plan §6 M5: an
     * interrupted stream must leave the assistant turn EITHER fully present
     * or absent, never half-present.
     */
    let completed = false;

    port.onMessage.addListener((msg: ChatStreamServerMessage) => {
      if (msg.requestId !== requestId) return;
      if (msg.type === "delta") {
        setLive((prev) => (prev ? { ...prev, text: prev.text + msg.text } : prev));
      } else if (msg.type === "search") {
        // Track each search as one entry. `started` events arrive before we
        // know the query; `completed` carries it. Match by itemId so
        // sequential searches stay in order even if events interleave.
        setLive((prev) => {
          if (!prev) return prev;
          const idx = prev.searches.findIndex((s) => s.itemId === msg.itemId);
          if (msg.status === "started") {
            if (idx >= 0) return prev; // already tracked
            return { ...prev, searches: [...prev.searches, { itemId: msg.itemId, status: "active", query: null }] };
          }
          // completed
          if (idx < 0) {
            return { ...prev, searches: [...prev.searches, { itemId: msg.itemId, status: "done", query: msg.query }] };
          }
          const next = [...prev.searches];
          next[idx] = { ...next[idx]!, status: "done", query: msg.query };
          return { ...prev, searches: next };
        });
      } else if (msg.type === "done") {
        completed = true;
        const finalText = msg.finalText.length > 0 ? msg.finalText : liveState.text;
        finishStream(finalText).catch((e) => {
          console.error("[thilko] transcript finishStream failed", e);
          setError(`Couldn't save the response: ${e instanceof Error ? e.message : String(e)}`);
          setLive(null);
        });
      } else if (msg.type === "error") {
        rollback(`AI: ${msg.message}`);
      }
    });
    port.onDisconnect.addListener(() => {
      if (completed) return;
      rollback("Stream ended before completion. Try again.");
    });

    /** Drop the optimistic user turn + abandon any partial assistant text. */
    function rollback(message: string) {
      setError(message);
      setOptimisticTurns((prev) => prev.filter((m) => m !== userTurn));
      setLive(null);
    }

    const start: ChatStreamClientMessage = {
      type: "start",
      requestId,
      systemPrompt: assembled.systemPrompt,
      contextBlocks: assembled.contextBlocks,
      history: assembled.history.map((t) => ({ role: t.role, content: t.content })),
      userMessage: assembled.userMessage,
    };
    port.postMessage(start);

    async function finishStream(finalAssistantText: string): Promise<void> {
      const assistantTurn: ThreadMessage = {
        role: "assistant",
        content: finalAssistantText,
        createdAt: Date.now(),
      };

      // Persist the pair atomically. Two paths:
      //   - No thread yet → createThread with [userTurn, assistantTurn].
      //   - Existing thread(s) → updateThread on the most recent thread with
      //     its prior messages plus the new pair.
      try {
        if (ensureHighlightPersisted) await ensureHighlightPersisted();

        if (threads.length === 0) {
          const newMessages: ThreadMessage[] = [userTurn, assistantTurn];
          const r = await rpc<{ thread: Thread }>({
            kind: "createThread",
            highlightId,
            articleId,
            messages: newMessages,
          });
          onThreadsChanged([...threads, r.thread]);
        } else {
          const target = threads[threads.length - 1];
          if (!target) throw new Error("Internal: thread index out of bounds");
          const newMessages: ThreadMessage[] = [...target.messages, userTurn, assistantTurn];
          const r = await rpc<{ thread: Thread }>({
            kind: "updateThread",
            id: target.id,
            messages: newMessages,
          });
          onThreadsChanged(threads.map((t) => (t.id === r.thread.id ? r.thread : t)));
        }
        // Drop the optimistic turns now that they're in `threads`. The new
        // server-issued messages will render in their place on the next
        // memo recompute.
        setOptimisticTurns((prev) => prev.filter((m) => m !== userTurn));
      } catch (e) {
        setError(`Couldn't save the turn: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLive(null);
      }
    }
  }, [
    live, threads, optimisticTurns, article, highlightContext,
    ensureHighlightPersisted, highlightId, articleId, onThreadsChanged,
  ]);

  const handleSubmit = useCallback(async (text: string, mode: ComposerMode) => {
    if (mode === "note") await handleNoteSubmit(text);
    else await handleChatSubmit(text);
  }, [handleNoteSubmit, handleChatSubmit]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <div className="transcript" ref={scrollerRef}>
        <CommentStrip comments={comments} onDelete={onDeleteComment} />
        {allTurns.map((turn, i) => (
          <Turn
            key={turn.key}
            role={turn.role}
            content={turn.content}
            showMascot={turn.role === "assistant" && i === firstAssistantIndex}
          />
        ))}
        {live && live.text.length === 0 && live.searches.length > 0 ? (
          <SearchingIndicator
            key="__searching__"
            searches={live.searches}
            showMascot={firstAssistantIndex === -1}
          />
        ) : null}
        {live && live.text.length > 0 ? (
          <Turn
            key="__live__"
            role="assistant"
            content={live.text}
            showMascot={firstAssistantIndex === -1}
          />
        ) : null}
        {live && live.text.length === 0 && live.searches.length === 0 ? (
          <PendingIndicator
            key="__pending__"
            showMascot={firstAssistantIndex === -1}
          />
        ) : null}
        {error ? <div className="transcript-error" role="status">{error}</div> : null}
      </div>
      <Composer
        initialMode={initialMode}
        busy={busy || !!live}
        autoFocus={autoFocus}
        onSubmit={handleSubmit}
      />
    </>
  );
}

/**
 * A single turn.
 *
 * - User turns render right-aligned in a soft accent-tinted pill with a
 *   notched bottom-right corner. No border, no shadow, no stripe — the
 *   asymmetry of treatment is the "from you" tell.
 * - Assistant turns render left-aligned as plain prose. The Dabbis mascot
 *   sits in the 20px left gutter on the FIRST assistant turn only;
 *   subsequent assistant turns leave the gutter empty so prose stays
 *   column-aligned across the conversation.
 */
function Turn({
  role, content, showMascot,
}: {
  role: "user" | "assistant";
  content: string;
  showMascot: boolean;
}) {
  if (role === "user") {
    return (
      <div className="turn turn-user">
        <div className="turn-prose">
          <Markdown source={content} streaming={false} />
        </div>
      </div>
    );
  }
  return (
    <div className="turn turn-assistant">
      <div className="turn-gutter" aria-hidden="true">
        {showMascot ? <Mascot size={20} decorative className="turn-mascot" /> : null}
      </div>
      <div className="turn-prose">
        <Markdown source={content} streaming={false} />
      </div>
    </div>
  );
}

/**
 * "Dabbis is thinking" — shown when we've kicked off a chat but no deltas
 * (and no search activity) have arrived yet. The mascot breathes; no text.
 * As soon as the first delta or first search event arrives, this collapses
 * and is replaced by the search indicator or the assistant turn.
 */
function PendingIndicator({ showMascot }: { showMascot: boolean }) {
  return (
    <div className="turn turn-assistant turn-pending">
      <div className="turn-gutter" aria-hidden="true">
        {showMascot ? <Mascot size={20} decorative className="turn-mascot turn-mascot-breathing" /> : null}
      </div>
      <div className="turn-prose">
        <span className="turn-pending-label">Dabbis is thinking…</span>
      </div>
    </div>
  );
}

/**
 * "Searching the web" — shown when Codex's web_search tool is running.
 * Multiple sequential searches stack as rows; older (completed) ones are
 * dimmed with a ✓; the most recent active one is italic with a ↗. The
 * mascot in the gutter breathes for the duration. The whole block animates
 * to max-height: 0 the moment the first assistant delta arrives.
 */
function SearchingIndicator({
  searches, showMascot,
}: {
  searches: Array<{ itemId: string; status: "active" | "done"; query: string | null }>;
  showMascot: boolean;
}) {
  // Visible cap = 3; older ones collapse into a "+N more" line.
  const MAX_VISIBLE = 3;
  const overflow = Math.max(0, searches.length - MAX_VISIBLE);
  const visible = searches.slice(-MAX_VISIBLE);
  return (
    <div className="turn turn-assistant turn-searching">
      <div className="turn-gutter" aria-hidden="true">
        {showMascot ? <Mascot size={20} decorative className="turn-mascot turn-mascot-breathing" /> : null}
      </div>
      <div className="turn-prose">
        <div className="turn-searching-label">SEARCHING THE WEB</div>
        {overflow > 0 ? <div className="turn-searching-overflow">+{overflow} earlier</div> : null}
        {visible.map((s) => (
          <div
            key={s.itemId}
            className={`turn-searching-row${s.status === "done" ? " done" : " active"}`}
          >
            <span className="turn-searching-glyph" aria-hidden="true">{s.status === "done" ? "✓" : "↗"}</span>
            <span className="turn-searching-query">
              {s.query ?? "…"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
