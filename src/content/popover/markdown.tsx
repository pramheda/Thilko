/**
 * Markdown rendering for chat messages.
 *
 * Safe-by-default: parses with `marked` (GitHub-flavored markdown), sanitizes
 * the resulting HTML with `dompurify` before inserting it. No untrusted HTML
 * ever reaches the DOM as-is — every assistant token goes through this path.
 *
 * Streaming-friendly: re-renders cheaply on each delta, so the component
 * appears to "type" as deltas arrive.
 */

import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Configure marked for streaming-friendly behavior: gfm + breaks (single
// newlines render as <br>), no async parsing.
marked.setOptions({
  gfm: true,
  breaks: true,
  // marked v12 deprecated mangle/headerIds; defaults are fine.
});

/**
 * Strict DOMPurify config — block scripts, event handlers, style URLs, etc.
 * We allow links but force them to open in a new tab without leaking the
 * referrer.
 */
const SANITIZER_CONFIG = {
  USE_PROFILES: { html: true },
  ALLOWED_TAGS: [
    "a", "b", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "table", "tbody",
    "td", "th", "thead", "tr", "ul",
  ] as string[],
  ALLOWED_ATTR: ["href", "title", "class", "lang"] as string[],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "img"] as string[],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick"] as string[],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#)/i,
};

/** Hook: every link should open in a new tab with safe rel. */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (!(node instanceof Element)) return;
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export interface MarkdownProps {
  source: string;
  /**
   * When true, the component is rendering an in-progress stream — adds a
   * subtle cursor at the end of the rendered content.
   */
  streaming?: boolean;
}

/**
 * Strip any tool-invocation XML markers the model may have emitted as text
 * (instead of as a native tool call). The Codex Responses API exposes
 * tools like `web_search_preview` natively, but if the proxy ever sends a
 * tools spec the API doesn't accept (typo, regression, deprecated name),
 * the model falls back to writing the tool call as XML — e.g.
 * `<web_search query="…" />` or `<tool_use name="…" args="…">…</tool_use>`.
 * Those should never reach the user; they're artifacts.
 *
 * Conservative regex: only strip self-closing or empty-content tags whose
 * names suggest a tool (web_search, tool_use, search, retrieve, fetch,
 * function_call, …). We leave any real prose intact.
 */
const TOOL_MARKER_RE = new RegExp(
  // Self-closing: <web_search query="…" />
  "<(?:web_search|web_search_preview|tool_use|tool_call|function_call|search|retrieve|fetch|browser)[^>]*\\/>" +
    "|" +
    // Empty-content: <tool_use …></tool_use>
    "<(?:web_search|web_search_preview|tool_use|tool_call|function_call|search|retrieve|fetch|browser)[^>]*>\\s*<\\/(?:web_search|web_search_preview|tool_use|tool_call|function_call|search|retrieve|fetch|browser)>",
  "gi",
);

function stripToolMarkers(s: string): string {
  return s.replace(TOOL_MARKER_RE, "");
}

export function Markdown({ source, streaming }: MarkdownProps) {
  const html = useMemo(() => {
    if (!source) return "";
    const cleaned = stripToolMarkers(source);
    if (!cleaned) return "";
    try {
      const raw = marked.parse(cleaned, { async: false }) as string;
      return DOMPurify.sanitize(raw, SANITIZER_CONFIG);
    } catch {
      // Fallback: render as plain text.
      const escaped = cleaned
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<p>${escaped}</p>`;
    }
  }, [source]);

  // The `streaming` prop is now a no-op — the breathing mascot + the
  // arriving text are enough motion. A blinking caret on top reads as
  // belt-and-suspenders chrome. Prop kept on the API for callers.
  void streaming;
  return (
    <div className="markdown">
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
