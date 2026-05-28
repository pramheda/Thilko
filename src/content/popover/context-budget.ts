/**
 * Per-turn context assembly + budgeting (plan §6.5, revised after the
 * conversational-drift bug — see commit context).
 *
 * Layout of what we send to the model on every turn:
 *
 *   instructions (system prompt) — persona + the article/highlight as
 *     persistent BACKGROUND context (not part of any user message)
 *
 *   input:
 *     ...conversation history (clean user/assistant turns)
 *     { role: "user", content: <current user message ONLY> }
 *
 * Why this layout: the previous shape stitched the article+highlight onto
 * the END of every current user message, so the model saw the highlight
 * immediately before the user's question every turn. That caused pronoun
 * drift — "that", "it", "this" anchored back to the highlight instead of
 * the most recent conversational topic. Moving the highlight into the
 * system prompt makes it behave like persistent background the model can
 * reference rather than the most-recent thing in its context window.
 *
 * If the total estimated token count exceeds MAX_CONTEXT_TOKENS, the
 * conversation history is trimmed from the OLDEST end first. The system
 * prompt + current user message are NEVER dropped.
 */

import { type ThreadMessage } from "../../shared/types.js";

/** Hard budget per turn including system prompt + history + user msg. */
export const MAX_CONTEXT_TOKENS = 12_000;

/** Rough chars-per-token heuristic. */
const CHARS_PER_TOKEN = 4;

/**
 * The reading-assistant persona. This is the BASE prompt — the per-turn
 * assembler wraps the article + highlight around it as background context
 * with explicit guidance on how to handle conversational follow-ups.
 */
export const SYSTEM_PROMPT_BASE = [
  "You are Dabbis, a reading assistant helping the user think about an article they are reading.",
  "You'll be given the article and the passage the user highlighted as background context.",
  "The user may ask about the passage directly, the article more broadly, or about something you said earlier in this conversation.",
  "",
  "How to converse:",
  "- Treat the highlighted passage as the starting point of the conversation, not as the only subject. The user may move on to your prior answers, to related ideas, or to follow-up questions about something they introduced. Follow the conversation naturally.",
  "- When a user message uses pronouns like \"it\", \"that\", \"this\", or \"the last one\", resolve them to the most recent topic in the conversation, NOT automatically to the highlighted passage. Re-read your own most recent reply before answering — the user is usually asking about something you just said.",
  "- Ground your answers in the article/passage when the user is asking about the passage. When the user is following up on your own prior answer, build on that answer.",
  "- Be precise. Match the user's level — explain plainly when they're exploring, technically when they're probing.",
  "- Cite specific phrases from the passage when relevant to the user's actual question, not as a default.",
  "- Ask clarifying questions when intent is genuinely ambiguous.",
  "- Do not invent facts beyond the article. If something isn't in the article, you can use the web_search tool when it would help — but only when the user is genuinely asking about something outside the article (current/recent info, prices, names not introduced in the passage, claim verification). Don't search for follow-ups on your own prior answer. Don't write tool-call markup like <web_search /> in plain text; either invoke the tool natively or just answer.",
].join("\n");

/** @deprecated kept for backward compat; prefer `SYSTEM_PROMPT_BASE`. */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_BASE;

export interface ArticleContext {
  title: string;
  url: string;
  /**
   * The surrounding article excerpt to ground the model. Caller passes the
   * full article text or a paragraph — budget trimming applies.
   */
  excerpt: string;
}

export interface HighlightContext {
  exact: string;
}

export interface ContextAssembly {
  /** Final system prompt string for the upstream API's `instructions` field. */
  systemPrompt: string;
  /** Context blocks (article header + highlight) sent before the user message. */
  contextBlocks: Array<{ label: string; text: string }>;
  /** History to include, possibly truncated from the head. */
  history: ThreadMessage[];
  /** Final user message. */
  userMessage: string;
  /** Diagnostics: how many turns were dropped, and the resulting estimated token count. */
  droppedHistoryTurns: number;
  estimatedTokens: number;
}

export interface AssembleInput {
  article: ArticleContext;
  highlight: HighlightContext;
  history: ThreadMessage[];
  userMessage: string;
  /** Override the default system prompt if the caller wants a custom persona. */
  systemPrompt?: string;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Build the per-turn context for /memory/chat. */
export function assembleContext(input: AssembleInput): ContextAssembly {
  const baseSystemPrompt = input.systemPrompt ?? SYSTEM_PROMPT_BASE;

  // Pre-trim the excerpt so we don't carry MB of text into the budget math.
  const MAX_EXCERPT_CHARS = 24_000;
  let excerpt = input.article.excerpt.length > MAX_EXCERPT_CHARS
    ? input.article.excerpt.slice(0, MAX_EXCERPT_CHARS)
    : input.article.excerpt;
  let truncated = input.article.excerpt.length > MAX_EXCERPT_CHARS;
  const TRUNCATION_MARKER = "\n…[truncated]";

  // Compose the enriched system prompt: persona + the article/highlight as
  // persistent BACKGROUND context, with a small footer reminding the model
  // that pronoun resolution should prefer the conversation. This is the key
  // bugfix: the highlight is no longer concatenated into the user message
  // every turn, so it stops dominating the model's "most recent context"
  // attention slot.
  const buildSystemPrompt = (e: string, isTruncated: boolean): string => {
    const articleLine =
      input.article.url.length > 0
        ? `${input.article.title} — ${input.article.url}`
        : input.article.title;
    return [
      baseSystemPrompt,
      "",
      "── Background for this conversation ──",
      `ARTICLE: ${articleLine}`,
      "",
      `${e}${isTruncated ? TRUNCATION_MARKER : ""}`,
      "",
      `HIGHLIGHTED PASSAGE: "${input.highlight.exact}"`,
      "",
      "Remember: this background is what *started* the conversation. The user may now be asking about your most recent reply rather than the passage. Default to the conversational referent.",
    ].join("\n");
  };

  const fixedTokensFor = (e: string, isTruncated: boolean): number => {
    return (
      estimateTokens(buildSystemPrompt(e, isTruncated)) +
      estimateTokens(input.userMessage) +
      32 // overhead
    );
  };

  // Iteratively shrink the excerpt until the fully-assembled fixed cost
  // (system + user msg + overhead) is within budget.
  while (excerpt.length > 0 && fixedTokensFor(excerpt, truncated) > MAX_CONTEXT_TOKENS) {
    const target = Math.floor(excerpt.length * 0.85);
    if (target <= 0) {
      excerpt = "";
      break;
    }
    excerpt = excerpt.slice(0, target);
    truncated = true;
  }
  // Hard guard: with an empty excerpt the truncation marker would just be
  // noise — drop it.
  if (excerpt.length === 0) truncated = false;

  const systemPrompt = buildSystemPrompt(excerpt, truncated);
  const fixedTokens = fixedTokensFor(excerpt, truncated);

  // Allow history to fill whatever budget remains.
  let history = [...input.history];
  let droppedHistoryTurns = 0;
  let runningTokens = fixedTokens + history.reduce((n, t) => n + estimateTokens(t.content) + 4, 0);

  while (runningTokens > MAX_CONTEXT_TOKENS && history.length > 0) {
    const removed = history.shift();
    if (!removed) break;
    droppedHistoryTurns++;
    runningTokens -= estimateTokens(removed.content) + 4;
  }

  return {
    systemPrompt,
    // contextBlocks is intentionally empty now — the article + highlight are
    // baked into systemPrompt. We keep the field on the shape for proxy
    // backward-compat (older proxies that still know how to prepend blocks
    // will see nothing to prepend, which is the correct new behavior).
    contextBlocks: [],
    history,
    userMessage: input.userMessage,
    droppedHistoryTurns,
    estimatedTokens: runningTokens,
  };
}
