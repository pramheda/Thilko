/**
 * Verifies the extension's URL canonicalization + articleId derivation match
 * the proxy's algorithm. Same fixtures should yield the same articleId on
 * both sides; if these tests drift, /memory/highlight (op=list) will return
 * an empty array for an article the user has already annotated.
 */

import { describe, expect, it } from "vitest";
import { canonicalizeUrl, articleIdFromUrl, deriveArticleId } from "../../src/shared/url.js";

describe("canonicalizeUrl", () => {
  it("strips utm_* params", () => {
    expect(canonicalizeUrl("https://example.com/a?utm_source=x&utm_medium=y&z=keep"))
      .toBe("https://example.com/a?z=keep");
  });

  it("strips fbclid, gclid, msclkid, igshid, ref_*", () => {
    for (const p of ["fbclid", "gclid", "msclkid", "igshid", "ref_src", "ref_url", "share", "shared"]) {
      expect(canonicalizeUrl(`https://example.com/a?${p}=abc`)).toBe("https://example.com/a");
    }
  });

  it("preserves non-tracking params", () => {
    expect(canonicalizeUrl("https://example.com/?q=hello&page=2"))
      .toBe("https://example.com/?q=hello&page=2");
  });

  it("drops the URL hash", () => {
    expect(canonicalizeUrl("https://example.com/page#section-1")).toBe("https://example.com/page");
  });

  it("lowercases host but preserves path case", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/CaseSensitivePath"))
      .toBe("https://example.com/CaseSensitivePath");
  });

  it("strips default ports", () => {
    expect(canonicalizeUrl("http://example.com:80/x")).toBe("http://example.com/x");
    expect(canonicalizeUrl("https://example.com:443/x")).toBe("https://example.com/x");
  });

  it("preserves non-default ports", () => {
    expect(canonicalizeUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
  });

  it("trims trailing slash off non-root paths", () => {
    expect(canonicalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  it("keeps root slash", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("returns input unchanged on parse failure", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("articleIdFromUrl", () => {
  it("returns 64-hex-char string (sha256 hex)", async () => {
    const id = await articleIdFromUrl("https://example.com/");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const a = await articleIdFromUrl("https://example.com/page");
    const b = await articleIdFromUrl("https://example.com/page");
    expect(a).toBe(b);
  });

  it("matches the proxy's algorithm for a known input", async () => {
    // This was produced by /memory/article on the live proxy for the
    // canonical URL https://en.wikipedia.org/wiki/Marginalia.
    const known = "16e95f60c6df89561ed6b01f04da565bfeee14a9bfd5459cbfe9f1cff1434d98";
    expect(await articleIdFromUrl("https://en.wikipedia.org/wiki/Marginalia")).toBe(known);
  });
});

describe("deriveArticleId", () => {
  it("composes canonicalize + hash", async () => {
    const { canonical, articleId } = await deriveArticleId(
      "https://EXAMPLE.com/a/?utm_source=test#frag",
    );
    expect(canonical).toBe("https://example.com/a");
    expect(articleId).toMatch(/^[0-9a-f]{64}$/);
  });
});
