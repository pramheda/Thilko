/**
 * Domain types shared across the extension surfaces (background SW, content
 * script, options page, library page).
 *
 * Wire shapes match the proxy contract documented in
 * docs/proxy-contract.md (the spec the proxy implements).
 */

// ── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  /** Base URL of the user's Codex+Memory proxy, e.g. `http://127.0.0.1:3200`. */
  proxyUrl: string;
  /** Shared secret sent as Bearer in Authorization. v1 personal use. */
  proxySecret: string;
  /** Per-user namespace tag — used by the proxy for ownerSlot scoping. */
  slot: string;
  /** Domains where the extension's content script should NOT activate. */
  exclusionDomains: string[];
  /** Whether content script runs on localhost pages (off by default). */
  localhostEnabled: boolean;
  /**
   * Expose `window.__thilko_dev` on every page for devtools-driven testing.
   * Disabled by default — when on, any page script can call privileged proxy
   * operations (create/update/delete highlights, comments, threads). Only
   * enable when you trust every page you visit.
   */
  devMode: boolean;
  /**
   * If true, highlights are persisted immediately to Supermemory when the
   * toolbar Comment or Ask Dabbis-AI button is clicked. If false (default),
   * the highlight stays a local UI marker and only gets saved to the proxy
   * when the user actually attaches content (adds a comment or sends a
   * message to Dabbis-AI). Off-by-default keeps the user's memory clean of
   * empty marker records.
   */
  autoPersistHighlights: boolean;
  /**
   * When true, PDFs are auto-redirected from Chrome's native viewer into
   * Thilko's pdf.js viewer (the v0.1.4 behaviour). Default false: PDFs open
   * in Chrome's native viewer for best rendering quality, and the user
   * switches into Thilko's viewer by clicking the extension toolbar icon.
   */
  pdfAutoRedirect: boolean;
}

/** Subset of Settings safe to expose to the content script (no secrets). */
export interface ActivationSettings {
  exclusionDomains: string[];
  localhostEnabled: boolean;
  devMode: boolean;
  /** Mirror of Settings.autoPersistHighlights — content script needs it to
   *  decide whether to fire createHighlight eagerly on toolbar actions. */
  autoPersistHighlights: boolean;
}

export const DEFAULT_EXCLUSION_DOMAINS: ReadonlyArray<string> = [
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "chat.openai.com",
  "mail.google.com",
  "accounts.google.com",
];

// ── Connection state ────────────────────────────────────────────────────────

/**
 * Distinguishes specific failure modes so the UI can show actionable hints
 * instead of a generic "down". The icon code maps any non-"ok" state to the
 * red-dot icon; the options page surfaces the textual reason.
 */
export type ConnectionStatus =
  | { kind: "unconfigured" }
  | {
      kind: "ok";
      lastCheckedAt: number;
      /** Seconds until the Codex OAuth token expires (informational). */
      tokenExpiresInSeconds: number | null;
      /** False when proxy's SUPERMEMORY_API_KEY is unset (memory routes will 503). */
      memoryReady: boolean;
    }
  | {
      kind: "down";
      lastCheckedAt: number;
      reason: string;
      /** Sub-classification for UX hints. */
      cause:
        | "network"        // proxy unreachable / network error
        | "auth"           // wrong PROXY_SECRET (proxy responded 401)
        | "slot"           // slot rejected (proxy 400 invalid_slot)
        | "token"          // proxy reachable but Codex token expired/invalid
        | "timeout"        // proxy did not respond in time
        | "unknown";
    };

// ── Anchor model (plan §3.1) ────────────────────────────────────────────────

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface HtmlRange {
  startContainerXPath: string;
  startOffset: number;
  endContainerXPath: string;
  endOffset: number;
}

export interface AnchorHtml {
  type: "html";
  quote: TextQuote;
  /**
   * W3C TextPositionSelector — character offsets within the scope's
   * concatenated text content. Used as a fuzzy-match fallback when the
   * primary TextQuote fails because the highlighted phrase shifted or
   * was edited.
   */
  textPosition?: { start: number; end: number };
  /**
   * Legacy DOM range fallback per plan §3.1. Not currently used (textPosition
   * supersedes it). Kept in the shape for forward-compat with the plan doc.
   */
  range?: HtmlRange;
}

export interface AnchorPdf {
  type: "pdf";
  quote: TextQuote;
  page: number;
  pageOffset: { start: number; end: number };
}

export type Anchor = AnchorHtml | AnchorPdf;

// ── Domain entities (plan §3.2) ─────────────────────────────────────────────

export interface Article {
  articleId: string;
  canonicalUrl: string;
  title: string;
  contentType: "html" | "pdf";
}

export interface Highlight {
  id: string;
  articleId: string;
  anchor: Anchor;
  topicIds: string[];
  createdAt: number;
  updatedAt: number;
  orphaned: boolean;
  ownerSlot: string;
}

export interface Comment {
  id: string;
  highlightId: string;
  articleId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  ownerSlot: string;
}

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface Thread {
  id: string;
  highlightId: string;
  articleId: string;
  messages: ThreadMessage[];
  createdAt: number;
  lastMessageAt: number;
  ownerSlot: string;
}

export interface Topic {
  id: string;
  label: string;
  /** v1: article URL (when the topic is an article-with-annotations). */
  canonicalUrl?: string;
  memoryCount: number;
}

// ── Proxy wire shapes ───────────────────────────────────────────────────────

export interface HealthResponse {
  ok: boolean;
  slot: string;
  tokenValid: boolean;
  tokenExpiresAt: string | null;
  expiresInSeconds: number | null;
}

export interface ProxyError {
  error: { code: string; message: string };
}
