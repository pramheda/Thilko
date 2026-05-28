/**
 * Memory-summary builder — pure function, no DOM, no fetch, no chrome APIs.
 *
 * The user clicks "Open with Claude" on a popover, sidebar, or library
 * surface; the calling surface assembles a scope object containing only the
 * data this builder needs, and we produce a markdown string that gets
 * copied to the clipboard for paste into a fresh claude.ai chat.
 *
 * Three scopes:
 *   1. highlight — one passage with its comments and AI threads.
 *   2. article — every highlight in a single article.
 *   3. topic — every article (and every highlight) in a topic group.
 *
 * Goals:
 *   - Markdown that reads naturally as a Claude prompt (article title,
 *     quote, user's notes, prior AI conversation).
 *   - No PII / internal-only identifiers: no slot, no highlight ids, no
 *     proxy URL, no Supermemory ids. Only canonical article URLs and
 *     user-authored text.
 *   - Deterministic — tests use golden output.
 *   - Bounded — `MEMORY_SUMMARY_MAX_CHARS` cap. When exceeded we stop adding
 *     blocks and append an explicit "truncated" footer that tells Claude
 *     (and the user) how many highlights were dropped.
 *
 * Wire callers pass plain serialisable data; we intentionally type the
 * inputs with their own narrow interfaces (not the full Highlight/Comment
 * domain types) so the builder can be exercised by tests without setting
 * up ownerSlot, createdAt-ms, etc. Each callsite must shape the data into
 * these inputs.
 */

export interface SummaryComment {
  /** User-authored comment text. */
  text: string;
  /** Epoch ms — only used for sorting; never rendered. */
  createdAt: number;
}

export interface SummaryThreadMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SummaryThread {
  /** Full transcript in chronological order. */
  messages: SummaryThreadMessage[];
  /** Epoch ms — only used for sorting; never rendered. */
  lastMessageAt: number;
}

export interface SummaryHighlightItem {
  quote: string;
  createdAt: number;
  /** Optional — marks an orphan with a one-line note. Sidebar may include orphans. */
  orphaned?: boolean;
  comments: SummaryComment[];
  threads: SummaryThread[];
}

export interface SummaryArticleRef {
  title: string;
  canonicalUrl: string;
}

export interface SummaryHighlightScope {
  kind: "highlight";
  article: SummaryArticleRef;
  highlight: SummaryHighlightItem;
}

export interface SummaryArticleScope {
  kind: "article";
  article: SummaryArticleRef;
  highlights: SummaryHighlightItem[];
}

export interface SummaryTopicScope {
  kind: "topic";
  topic: { label: string };
  articles: Array<{
    article: SummaryArticleRef;
    highlights: SummaryHighlightItem[];
  }>;
}

export type SummaryScope = SummaryHighlightScope | SummaryArticleScope | SummaryTopicScope;

/** Hard ceiling on the output string. */
export const MEMORY_SUMMARY_MAX_CHARS = 50_000;

/**
 * Build a markdown summary string for the given scope. Pure function.
 *
 * The output never includes:
 *   - Highlight / comment / thread IDs
 *   - Owner slot
 *   - Proxy URL or any extension-internal data
 *   - Per-message timestamps (sort order only)
 */
export function buildMemorySummary(scope: SummaryScope, maxChars: number = MEMORY_SUMMARY_MAX_CHARS): string {
  let blocks: string[];
  let header: string;

  if (scope.kind === "highlight") {
    header = headerForHighlight(scope.article);
    blocks = [renderHighlight(scope.highlight, { numbered: false })];
  } else if (scope.kind === "article") {
    header = headerForArticle(scope.article, scope.highlights.length);
    blocks = scope.highlights.map((h, i) => renderHighlight(h, { numbered: true, index: i + 1 }));
  } else {
    const totalH = scope.articles.reduce((acc, a) => acc + a.highlights.length, 0);
    header = headerForTopic(scope.topic.label, scope.articles.length, totalH);
    blocks = scope.articles.map((a) => renderArticleSubsection(a.article, a.highlights));
  }

  // Each block is one "unit" of the scope (a highlight for article/highlight
  // scope, an article for topic scope) — so blocks.length is always the
  // correct total count for renderTruncationNote.
  const totalUnits = blocks.length;
  const footer = "\n---\nPasted from Thilko.\n";
  const footerLen = footer.length;

  // Fast path: if the full body already fits, no truncation note needed.
  const fullBodyLen = header.length + blocks.reduce((a, b) => a + b.length, 0);
  if (fullBodyLen + footerLen <= maxChars) {
    return header + blocks.join("") + footer;
  }

  // Slow path: reserve room for the truncation note from the start, using the
  // worst-case dropped count (= blocks.length) so the reservation is an upper
  // bound on the actual note length we eventually emit.
  const reserveNoteLen = renderTruncationNote(scope.kind, blocks.length, totalUnits).length;
  const budget = maxChars - footerLen - reserveNoteLen;

  let out = header;
  let used = 0;
  for (const block of blocks) {
    if (out.length + block.length <= budget) {
      out += block;
      used++;
      continue;
    }
    break;
  }
  const dropped = blocks.length - used;
  const note = dropped > 0 ? renderTruncationNote(scope.kind, dropped, totalUnits) : "";

  // Note <= reserveNoteLen (worst-case dropped >= actual dropped), so
  //   out + note + footer <= budget + reserveNoteLen + footerLen = maxChars.
  // Guaranteed strict cap. The slice fallback below catches the pathological
  // case where the header alone exceeds budget; we never tear off a footer.
  let result = out + note + footer;
  if (result.length > maxChars) {
    const headRoom = Math.max(0, maxChars - footerLen);
    result = result.slice(0, headRoom) + footer;
  }
  return result;
}

// ── Headers ────────────────────────────────────────────────────────────────

function headerForHighlight(article: SummaryArticleRef): string {
  return [
    `# Highlight from "${article.title || "(untitled)"}"`,
    `Source: ${article.canonicalUrl}`,
    "",
    "",
  ].join("\n");
}

function headerForArticle(article: SummaryArticleRef, highlightCount: number): string {
  return [
    `# Article: ${article.title || "(untitled)"}`,
    `Source: ${article.canonicalUrl}`,
    `${highlightCount} highlight${highlightCount === 1 ? "" : "s"} captured`,
    "",
    "",
  ].join("\n");
}

function headerForTopic(label: string, articleCount: number, highlightCount: number): string {
  return [
    `# Topic: ${label}`,
    `${articleCount} article${articleCount === 1 ? "" : "s"}, ${highlightCount} highlight${highlightCount === 1 ? "" : "s"}`,
    "",
    "",
  ].join("\n");
}

// ── Blocks ─────────────────────────────────────────────────────────────────

function renderHighlight(h: SummaryHighlightItem, opts: { numbered: boolean; index?: number }): string {
  const heading = opts.numbered ? `## Highlight ${opts.index ?? 1}` : null;
  const lines: string[] = [];
  // Preamble: heading and/or orphan note before the quote. Only emit a
  // separator blank line if either is present — keeps non-numbered single-
  // highlight output from inheriting a stray leading blank line.
  if (heading) lines.push(heading);
  if (h.orphaned) lines.push("_(Couldn't re-locate this highlight on the current page; the quote below is from when it was first captured.)_");
  if (lines.length > 0) lines.push("");
  lines.push(blockquote(h.quote));
  lines.push("");

  if (h.comments.length > 0) {
    lines.push("**My notes:**");
    const sorted = [...h.comments].sort((a, b) => a.createdAt - b.createdAt);
    for (const c of sorted) {
      lines.push(`- ${c.text}`);
    }
    lines.push("");
  }

  if (h.threads.length > 0) {
    const sorted = [...h.threads].sort((a, b) => a.lastMessageAt - b.lastMessageAt);
    sorted.forEach((t, i) => {
      const label = sorted.length > 1 ? `**AI thread ${i + 1}:**` : "**AI thread:**";
      lines.push(label);
      for (const m of t.messages) {
        const speaker = m.role === "user" ? "Me" : "Claude";
        lines.push(`> **${speaker}:** ${oneLine(m.content)}`);
      }
      lines.push("");
    });
  }

  // Trailing blank line so consecutive blocks (article scope) are separated
  // by an empty line in the rendered markdown. Always push — if the last
  // entry was already "", this gives us "" + "" → "\n\n" on join, which is
  // exactly the trailing blank line we want.
  lines.push("");
  return lines.join("\n");
}

function renderArticleSubsection(article: SummaryArticleRef, highlights: SummaryHighlightItem[]): string {
  const lines: string[] = [];
  lines.push(`## ${article.title || "(untitled)"}`);
  lines.push(`Source: ${article.canonicalUrl}`);
  lines.push("");
  highlights.forEach((h, i) => {
    lines.push(`### Highlight ${i + 1}`);
    if (h.orphaned) lines.push("_(Captured quote — couldn't re-locate on the current page.)_");
    lines.push(blockquote(h.quote));
    if (h.comments.length > 0) {
      lines.push("");
      lines.push("**My notes:**");
      const sorted = [...h.comments].sort((a, b) => a.createdAt - b.createdAt);
      for (const c of sorted) lines.push(`- ${c.text}`);
    }
    if (h.threads.length > 0) {
      lines.push("");
      const sorted = [...h.threads].sort((a, b) => a.lastMessageAt - b.lastMessageAt);
      sorted.forEach((t, ti) => {
        const label = sorted.length > 1 ? `**AI thread ${ti + 1}:**` : "**AI thread:**";
        lines.push(label);
        for (const m of t.messages) {
          const speaker = m.role === "user" ? "Me" : "Claude";
          lines.push(`> **${speaker}:** ${oneLine(m.content)}`);
        }
      });
    }
    lines.push("");
  });
  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function blockquote(s: string): string {
  // Multi-line quotes — prefix every line with "> ", and collapse runs of
  // blank lines so the markdown stays tight.
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  return lines.map((l) => `> ${l}`.trimEnd()).join("\n");
}

function oneLine(s: string): string {
  // Thread messages get rendered inside a blockquote; flatten newlines so
  // each message stays on a single ">" line. Markdown renderers will wrap.
  return s.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").trim();
}

function renderTruncationNote(kind: SummaryScope["kind"], dropped: number, total: number): string {
  const unit = kind === "topic" ? "article" : "highlight";
  return `\n_Summary truncated — ${dropped} more ${unit}${dropped === 1 ? "" : "s"} of ${total} not shown (50,000-character cap)._\n`;
}

// ── Continuation prompt ────────────────────────────────────────────────────
//
// Different shape from the summary above: this is the message body we drop
// into a fresh claude.ai / chatgpt.com chat as the user's FIRST message so
// they can continue the Dabbis thread in another LLM. Differences vs
// buildMemorySummary:
//
//   - Per-turn content is preserved verbatim (no oneLine() flattening) so
//     multi-paragraph replies, lists, and code blocks survive.
//   - A short framing intro tells the target model how to respond ("read,
//     acknowledge, wait for next question") so by the time the user looks
//     at the chat surface, the model has already responded with a brief
//     "OK, ready" — no wall-of-text review required.
//   - Role labels use "Me" / "Assistant" for portability across targets.
//   - Bounded by `MEMORY_SUMMARY_MAX_CHARS` like the summary.

/** Build the first-message prompt for the Open-with-Claude / ChatGPT flow. */
export function buildContinuationPrompt(scope: SummaryHighlightScope, maxChars: number = MEMORY_SUMMARY_MAX_CHARS): string {
  const { article, highlight } = scope;

  const intro = [
    "Below is the transcript of a conversation I was just having with a reading assistant about an article. Please read it, understand the context, and just reply with \"OK, ready to continue\" — I'll ask my next question after that.",
    "",
  ].join("\n");

  const header = [
    `**Article**: ${article.title || "(untitled)"}${article.canonicalUrl ? ` — ${article.canonicalUrl}` : ""}`,
    "",
    "**Highlighted passage**:",
    blockquote(highlight.quote),
    "",
  ].join("\n");

  const transcriptParts: string[] = [];
  if (highlight.comments.length > 0) {
    transcriptParts.push("**My notes on this passage:**");
    const sorted = [...highlight.comments].sort((a, b) => a.createdAt - b.createdAt);
    for (const c of sorted) transcriptParts.push(`- ${c.text}`);
    transcriptParts.push("");
  }

  if (highlight.threads.length > 0) {
    transcriptParts.push("**Conversation so far:**");
    transcriptParts.push("");
    const sortedThreads = [...highlight.threads].sort((a, b) => a.lastMessageAt - b.lastMessageAt);
    sortedThreads.forEach((t, idx) => {
      if (sortedThreads.length > 1) {
        transcriptParts.push(`_Thread ${idx + 1}_`);
        transcriptParts.push("");
      }
      for (const m of t.messages) {
        const speaker = m.role === "user" ? "Me" : "Assistant";
        // Preserve full message content verbatim — multi-paragraph, lists,
        // code blocks all survive. Bold the speaker label, then a blank line,
        // then the content on its own block.
        transcriptParts.push(`**${speaker}:**`);
        transcriptParts.push("");
        transcriptParts.push(m.content);
        transcriptParts.push("");
      }
    });
  }

  const transcript = transcriptParts.join("\n");
  const footer = "\n---\n\n(End of transcript. Please reply \"OK, ready to continue\" and wait for my next question.)\n";

  const full = intro + header + transcript + footer;
  if (full.length <= maxChars) return full;

  // Soft-truncate the transcript portion from the END (keep the most recent
  // messages — those are the most relevant for "continue from here"). Hard
  // ceiling sliced just in case.
  const budget = maxChars - intro.length - header.length - footer.length - 80;
  if (budget <= 0) return full.slice(0, maxChars);
  let truncTranscript = transcript;
  if (transcript.length > budget) {
    truncTranscript = "_…earlier messages truncated…_\n\n" + transcript.slice(-budget);
  }
  return intro + header + truncTranscript + footer;
}
