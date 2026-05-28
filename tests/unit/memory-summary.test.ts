/**
 * Golden-output tests for the memory-summary builder.
 *
 * If you change the output format, eyeball the new output (paste into Claude,
 * make sure it reads naturally), THEN update the goldens. The truncation test
 * uses a tiny maxChars so we exercise the budget logic without 50K-char
 * fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  buildMemorySummary,
  MEMORY_SUMMARY_MAX_CHARS,
  type SummaryArticleScope,
  type SummaryHighlightScope,
  type SummaryTopicScope,
} from "../../src/shared/memory-summary.js";

describe("buildMemorySummary — highlight scope", () => {
  it("renders title, source, quote, comments, and a single thread", () => {
    const scope: SummaryHighlightScope = {
      kind: "highlight",
      article: { title: "On Tacit Knowledge", canonicalUrl: "https://example.com/tacit" },
      highlight: {
        quote: "Knowing how is not reducible to knowing that.",
        createdAt: 1000,
        comments: [
          { text: "Ryle, 1949.", createdAt: 1500 },
          { text: "Cf. Polanyi", createdAt: 1100 },
        ],
        threads: [
          {
            lastMessageAt: 2000,
            messages: [
              { role: "user", content: "How is this used in modern epistemology?" },
              { role: "assistant", content: "Sosa & Williamson both reject the strict dichotomy." },
            ],
          },
        ],
      },
    };
    expect(buildMemorySummary(scope)).toBe(GOLDEN_HIGHLIGHT);
  });

  it("renders an orphan highlight with the orphan note", () => {
    const scope: SummaryHighlightScope = {
      kind: "highlight",
      article: { title: "An Article", canonicalUrl: "https://example.com/a" },
      highlight: {
        quote: "A quote.",
        createdAt: 1,
        orphaned: true,
        comments: [],
        threads: [],
      },
    };
    expect(buildMemorySummary(scope)).toContain("Couldn't re-locate this highlight");
  });

  it("flattens newlines inside thread messages so each line stays on a single blockquote", () => {
    const scope: SummaryHighlightScope = {
      kind: "highlight",
      article: { title: "X", canonicalUrl: "https://x.test/" },
      highlight: {
        quote: "q",
        createdAt: 0,
        comments: [],
        threads: [{
          lastMessageAt: 1,
          messages: [{ role: "assistant", content: "Para 1.\n\nPara 2." }],
        }],
      },
    };
    const out = buildMemorySummary(scope);
    expect(out).toContain("> **Claude:** Para 1. Para 2.");
  });
});

describe("buildMemorySummary — article scope", () => {
  it("renders an ordered list of highlights with their comments", () => {
    const scope: SummaryArticleScope = {
      kind: "article",
      article: { title: "Two Cheers", canonicalUrl: "https://example.com/two" },
      highlights: [
        {
          quote: "First quote.",
          createdAt: 100,
          comments: [{ text: "Note A", createdAt: 110 }],
          threads: [],
        },
        {
          quote: "Second quote.",
          createdAt: 200,
          comments: [],
          threads: [{
            lastMessageAt: 250,
            messages: [
              { role: "user", content: "Why?" },
              { role: "assistant", content: "Because." },
            ],
          }],
        },
      ],
    };
    expect(buildMemorySummary(scope)).toBe(GOLDEN_ARTICLE);
  });

  it("handles zero highlights", () => {
    const scope: SummaryArticleScope = {
      kind: "article",
      article: { title: "Empty", canonicalUrl: "https://e.test/" },
      highlights: [],
    };
    const out = buildMemorySummary(scope);
    expect(out).toContain("# Article: Empty");
    expect(out).toContain("0 highlights captured");
  });
});

describe("buildMemorySummary — topic scope", () => {
  it("groups by article and counts both", () => {
    const scope: SummaryTopicScope = {
      kind: "topic",
      topic: { label: "Epistemology" },
      articles: [
        {
          article: { title: "A1", canonicalUrl: "https://a.test/1" },
          highlights: [{ quote: "q1", createdAt: 1, comments: [], threads: [] }],
        },
        {
          article: { title: "A2", canonicalUrl: "https://a.test/2" },
          highlights: [
            { quote: "q2a", createdAt: 2, comments: [], threads: [] },
            { quote: "q2b", createdAt: 3, comments: [], threads: [] },
          ],
        },
      ],
    };
    const out = buildMemorySummary(scope);
    expect(out).toContain("# Topic: Epistemology");
    expect(out).toContain("2 articles, 3 highlights");
    expect(out).toContain("## A1");
    expect(out).toContain("## A2");
    expect(out).toContain("> q2b");
  });
});

describe("buildMemorySummary — limits and PII", () => {
  it("never embeds an id, owner slot, or extension URL", () => {
    const scope: SummaryHighlightScope = {
      kind: "highlight",
      article: { title: "X", canonicalUrl: "https://x.test/a" },
      highlight: {
        quote: "q",
        createdAt: 0,
        comments: [],
        threads: [],
      },
    };
    const out = buildMemorySummary(scope);
    // None of these tokens should ever leak in.
    expect(out).not.toMatch(/ownerSlot/i);
    expect(out).not.toMatch(/chrome-extension:\/\//);
    expect(out).not.toMatch(/proxy/i);
    expect(out).not.toMatch(/highlightId/i);
  });

  it("truncates at the cap and appends an explicit note with the dropped count", () => {
    const tinyCap = 600;
    const make = (q: string, i: number) => ({ quote: q, createdAt: i, comments: [], threads: [] });
    const scope: SummaryArticleScope = {
      kind: "article",
      article: { title: "Big", canonicalUrl: "https://big.test/x" },
      highlights: Array.from({ length: 30 }, (_, i) => make(`highlight content ${i}`, i)),
    };
    const out = buildMemorySummary(scope, tinyCap);
    expect(out.length).toBeLessThanOrEqual(tinyCap);
    expect(out).toMatch(/Summary truncated/);
    expect(out).toMatch(/of 30 not shown/);
    expect(out).toMatch(/Pasted from Thilko\./);
  });

  it("never exceeds the public cap on its own", () => {
    const big = "x".repeat(2_000);
    const scope: SummaryTopicScope = {
      kind: "topic",
      topic: { label: "Lots" },
      articles: Array.from({ length: 50 }, (_, i) => ({
        article: { title: `A${i}`, canonicalUrl: `https://t.test/${i}` },
        highlights: [{ quote: big, createdAt: i, comments: [], threads: [] }],
      })),
    };
    const out = buildMemorySummary(scope);
    expect(out.length).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_CHARS);
    expect(out).toMatch(/Pasted from Thilko\./);
  });

  it("topic truncation reports articles, not highlights", () => {
    // 30 articles × 5 highlights apiece; tight cap forces dropping articles.
    const make = (q: string, i: number) => ({ quote: q, createdAt: i, comments: [], threads: [] });
    const scope: SummaryTopicScope = {
      kind: "topic",
      topic: { label: "Stuff" },
      articles: Array.from({ length: 30 }, (_, i) => ({
        article: { title: `A${i}`, canonicalUrl: `https://t.test/${i}` },
        highlights: Array.from({ length: 5 }, (_, j) => make(`highlight ${i}-${j} text`, j)),
      })),
    };
    const out = buildMemorySummary(scope, 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toMatch(/Summary truncated/);
    // Denominator is article count (30), unit is "article" — never
    // "highlight" or the total highlight count (150).
    expect(out).toMatch(/of 30 not shown/);
    expect(out).toMatch(/more articles? of 30/);
    expect(out).not.toMatch(/of 150 not shown/);
    expect(out).not.toMatch(/more highlights? of/);
  });
});

// ── Goldens ─────────────────────────────────────────────────────────────────

const GOLDEN_HIGHLIGHT = `# Highlight from "On Tacit Knowledge"
Source: https://example.com/tacit

> Knowing how is not reducible to knowing that.

**My notes:**
- Cf. Polanyi
- Ryle, 1949.

**AI thread:**
> **Me:** How is this used in modern epistemology?
> **Claude:** Sosa & Williamson both reject the strict dichotomy.


---
Pasted from Thilko.
`;

const GOLDEN_ARTICLE = `# Article: Two Cheers
Source: https://example.com/two
2 highlights captured

## Highlight 1

> First quote.

**My notes:**
- Note A

## Highlight 2

> Second quote.

**AI thread:**
> **Me:** Why?
> **Claude:** Because.


---
Pasted from Thilko.
`;
