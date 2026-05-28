/**
 * The floating popover for a single highlight.
 *
 * Lifecycle owned by popover-manager.ts:
 *   - Manager mounts this component inside a shadow-DOM host on document.body.
 *   - Component owns its own React state (comments, draft, collapse state,
 *     toast). The manager only owns identity (highlightId), the host element,
 *     and the callbacks that talk to the network.
 *
 * Per the plan §1 visual:
 *   header → quote → comments section → threads section (stub) → footer
 *   with "Open with Claude" button (stub for M9).
 *
 * Draggable via the header; collapsible to a small chip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Comment, type Highlight, type Thread } from "../../shared/types.js";
import { PopoverHeader } from "./header.js";
import { Transcript } from "./transcript.js";
import { useDrag } from "./drag.js";
import { type ArticleContext } from "./context-budget.js";
import { buildContinuationPrompt, type SummaryHighlightItem } from "../../shared/memory-summary.js";
import { openContinuation, type ChatTarget } from "../../shared/claude-handoff.js";

export interface PopoverProps {
  highlight: Highlight;
  /** Initial comments loaded from backend. */
  initialComments: Comment[];
  /** Initial threads loaded from backend. */
  initialThreads: Thread[];
  /** Article title — shown in the header. */
  articleTitle: string;
  /** Canonical article URL — used in the Claude handoff summary. */
  articleCanonicalUrl: string;
  /** Article context used to assemble per-turn AI context. */
  articleContext: ArticleContext;
  /** Host element on document.body — used by the drag hook to mutate top/left. */
  hostElement: HTMLElement;
  /** Whether to focus the textarea after mount (true when opened from the toolbar). */
  focusOnMount: boolean;
  /** If true, open a fresh AI thread on mount (Ask AI from selection toolbar). */
  startWithFreshThread?: boolean;

  /** Talk-to-network callbacks. Manager wires these into the typed RPC layer. */
  rpc: {
    /** Create a comment with a CALLER-supplied id (so optimistic UI never needs a swap). */
    createComment: (input: { id: string; text: string }) => Promise<Comment>;
    deleteComment: (id: string) => Promise<void>;
    reload: () => Promise<{ comments: Comment[]; threads: Thread[] }>;
  };
  /** Idempotent — flushes the local highlight to the proxy when the user
   *  attaches the first comment / first AI message. Threaded through to
   *  the ThreadView draft branch via ThreadsSection. */
  ensureHighlightPersisted?: () => Promise<void>;
  /** Fired when the user picks "Delete highlight" from the overflow menu.
   *  Owner (content/index.ts via popover-manager) handles the RPC + the
   *  rendered <mark>'s removal + state cleanup. */
  onDeleteRequested?: () => Promise<void>;

  /** Manager hooks. */
  onClose: () => void;
  /** Called whenever the counts the marker reflects might have changed. */
  onCountsChange: (counts: { comments: number; threads: number }) => void;
}

export function Popover(props: PopoverProps) {
  const {
    highlight,
    initialComments,
    initialThreads,
    articleTitle,
    articleCanonicalUrl,
    articleContext,
    hostElement,
    focusOnMount,
    startWithFreshThread,
    rpc,
    ensureHighlightPersisted,
    onDeleteRequested,
    onClose,
    onCountsChange,
  } = props;

  const [comments, setComments] = useState<Comment[]>(() => [...initialComments]);
  const [threads, setThreads] = useState<Thread[]>(() => [...initialThreads]);
  const [collapsed, setCollapsed] = useState(false);
  /**
   * Minimized = header only, no body, no composer. Different from `collapsed`
   * (collapse-to-chip). The popover stays pinned at the right edge of the
   * viewport in a slim 1-line state — quick to restore, the conversation
   * stays addressable. Click the header (or the minimize button itself) to
   * toggle.
   */
  const [minimized, setMinimized] = useState(false);
  const [toast, setToast] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const headerRef = useRef<HTMLDivElement | null>(null);

  // Drag — only when expanded. Collapsed chip ignores drags by design (clicks
  // through to expand). useDrag itself is a no-op if the ref is null.
  useDrag({
    handleRef: headerRef,
    hostElement,
    onDragEnd: () => {
      // We mutate hostElement.style during drag; nothing else to persist.
    },
  });

  // Auto-dismiss toasts after a beat.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Surface marker counts to the manager whenever they change.
  useEffect(() => {
    onCountsChange({ comments: comments.length, threads: threads.length });
  }, [comments.length, threads.length, onCountsChange]);

  /**
   * Add a comment optimistically. We push a stub Comment with a client-side
   * id, fire the proxy create, and on success replace the stub with the
   * server-issued record (same id, real timestamps + ownerSlot). On failure,
   * remove the stub and surface a toast — the user's text is gone but they
   * see why; PR2 trades the old "pending/failed-in-place" affordance for a
   * cleaner CommentStrip that only shows resolved state.
   */
  const handleAddComment = useCallback(
    async (text: string) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      const stub: Comment = {
        id,
        highlightId: highlight.id,
        articleId: highlight.articleId,
        text,
        createdAt: now,
        updatedAt: now,
        ownerSlot: highlight.ownerSlot,
      };
      setComments((prev) => [...prev, stub]);
      try {
        const real = await rpc.createComment({ id, text });
        setComments((prev) => prev.map((c) => (c.id === id ? real : c)));
      } catch (e) {
        setComments((prev) => prev.filter((c) => c.id !== id));
        setToast({ kind: "error", text: `Couldn't save note: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [highlight.id, highlight.articleId, highlight.ownerSlot, rpc],
  );

  const handleDeleteComment = useCallback(
    async (id: string) => {
      const snapshot = comments;
      setComments((prev) => prev.filter((c) => c.id !== id));
      try {
        await rpc.deleteComment(id);
      } catch (e) {
        setComments(snapshot);
        setToast({ kind: "error", text: `Couldn't delete: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [comments, rpc],
  );

  const flushAndClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // ─ Collapsed chip ─
  if (collapsed) {
    const totalCount = comments.length + threads.length;
    return (
      <div className="popover popover-collapsed">
        <button
          type="button"
          className="popover-collapsed-chip"
          onClick={() => setCollapsed(false)}
          aria-label="Expand popover"
          title={articleTitle || "Thilko highlight"}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            margin: 0,
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <span>📑 {truncate(articleTitle, 24)}</span>
          {totalCount > 0 ? <span className="badge">●{totalCount}</span> : null}
        </button>
      </div>
    );
  }

  // ─ Overflow-menu handlers ───────────────────────────────────────────────
  // Pulled out of the (removed) popover-footer so the ⋯ menu can fire them.

  const handleOpenInChat = useCallback(async (target: ChatTarget) => {
    const item: SummaryHighlightItem = {
      quote: highlight.anchor.quote.exact,
      createdAt: highlight.createdAt,
      orphaned: highlight.orphaned,
      comments: comments.map((c) => ({ text: c.text, createdAt: c.createdAt })),
      threads: threads.map((t) => ({
        lastMessageAt: t.lastMessageAt,
        messages: t.messages.map((m) => ({ role: m.role, content: m.content })),
      })),
    };
    const prompt = buildContinuationPrompt({
      kind: "highlight",
      article: { title: articleTitle, canonicalUrl: articleCanonicalUrl },
      highlight: item,
    });
    const { clipboardOk, tabOk } = await openContinuation(target, prompt);
    const targetLabel = target === "chatgpt" ? "ChatGPT" : "Claude";
    if (tabOk) setToast({ kind: "ok", text: `Opening ${targetLabel} — your conversation will load there.` });
    else if (clipboardOk) setToast({ kind: "error", text: `Couldn't open ${targetLabel} tab. Conversation copied — paste it manually.` });
    else setToast({ kind: "error", text: `Couldn't hand off to ${targetLabel}. Try again.` });
  }, [highlight.anchor.quote.exact, highlight.createdAt, highlight.orphaned, comments, threads, articleTitle, articleCanonicalUrl]);

  const handleOpenWithClaude = useCallback(() => handleOpenInChat("claude"), [handleOpenInChat]);
  const handleOpenWithChatgpt = useCallback(() => handleOpenInChat("chatgpt"), [handleOpenInChat]);

  const handleCopyQuote = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(highlight.anchor.quote.exact);
      setToast({ kind: "ok", text: "Quote copied." });
    } catch {
      setToast({ kind: "error", text: "Clipboard blocked." });
    }
  }, [highlight.anchor.quote.exact]);

  const handleDeleteHighlight = useCallback(async () => {
    if (!onDeleteRequested) return;
    try {
      await onDeleteRequested();
    } catch (e) {
      setToast({ kind: "error", text: `Couldn't delete: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [onDeleteRequested]);

  // ─ Expanded popover ─
  return (
    <div
      className={`popover${minimized ? " popover-minimized" : ""}`}
      role="dialog"
      aria-label="Thilko highlight"
      // Clicking anywhere on the minimized chrome restores it. Inside-header
      // buttons stopPropagation so this doesn't fight ⋯/✕/− clicks.
      onClick={minimized ? () => setMinimized(false) : undefined}
    >
      <PopoverHeader
        quote={highlight.anchor.quote.exact}
        handleRef={headerRef}
        onCollapse={() => setCollapsed(true)}
        onClose={flushAndClose}
        onToggleMinimized={() => setMinimized((m) => !m)}
        minimized={minimized}
        onDeleteHighlight={handleDeleteHighlight}
        onOpenWithClaude={handleOpenWithClaude}
        onOpenWithChatgpt={handleOpenWithChatgpt}
        onCopyQuote={handleCopyQuote}
      />
      {minimized ? null : (
        <Transcript
          highlightId={highlight.id}
          articleId={highlight.articleId}
          article={articleContext}
          highlightContext={{ exact: highlight.anchor.quote.exact }}
          comments={comments}
          threads={threads}
          onAddComment={handleAddComment}
          onDeleteComment={handleDeleteComment}
          onThreadsChanged={setThreads}
          ensureHighlightPersisted={ensureHighlightPersisted}
          initialMode={startWithFreshThread ? "chat" : "note"}
          autoFocus={focusOnMount}
        />
      )}
      {toast ? <div className={`toast ${toast.kind === "ok" ? "ok" : ""}`} role="status">{toast.text}</div> : null}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
