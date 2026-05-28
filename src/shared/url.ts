/**
 * URL canonicalization + articleId derivation.
 *
 * MUST match the algorithm in the proxy's memory.ts (canonicalizeUrl and
 * articleIdFromUrl) so the same URL produces the same articleId on both
 * sides. Any change here requires the corresponding change in the proxy.
 *
 * Used to look up an article's existing highlights on page load without
 * triggering ingestion — only the first user-driven highlight on a page
 * causes /memory/article to fire.
 */

const TRACKING_PARAM_PREFIXES = ["utm_", "mc_"] as const;
const TRACKING_PARAM_EXACT = new Set<string>([
  "fbclid",
  "gclid",
  "msclkid",
  "yclid",
  "dclid",
  "twclid",
  "igshid",
  "ref",
  "ref_src",
  "ref_url",
  "share",
  "shared",
  "spm",
]);

/** Canonicalize a URL the same way the proxy does. */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (TRACKING_PARAM_EXACT.has(lk)) continue;
    if (TRACKING_PARAM_PREFIXES.some((p) => lk.startsWith(p))) continue;
    keep.append(k, v);
  }
  u.search = keep.toString();
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

/**
 * Compute the article ID from a canonical URL.
 *
 * Article.id = sha256_hex(canonicalUrl) — matches plan §3.2 and the proxy's
 * articleIdFromUrl. Uses Web Crypto in the browser context.
 */
export async function articleIdFromUrl(canonicalUrl: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalUrl));
  const bytes = new Uint8Array(buffer);
  const hex: string[] = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    hex[i] = v.toString(16).padStart(2, "0");
  }
  return hex.join("");
}

/** Shortcut: canonicalize then hash. */
export async function deriveArticleId(rawUrl: string): Promise<{ canonical: string; articleId: string }> {
  const canonical = canonicalizeUrl(rawUrl);
  const articleId = await articleIdFromUrl(canonical);
  return { canonical, articleId };
}
