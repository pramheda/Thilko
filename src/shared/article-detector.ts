/**
 * Lightweight article metadata extraction from the current document.
 *
 * Returns the page's title (preferring rich-metadata sources) and a flag
 * indicating whether the page is likely article-shaped. The content script
 * does NOT gate activation on this flag in M3 — all matching pages are
 * candidates — but the title is needed for /memory/article.
 */

export interface ArticleMetadata {
  title: string;
  /** Heuristic — true if the page looks like a long-form article. */
  looksLikeArticle: boolean;
}

export function extractArticleMetadata(doc: Document = document): ArticleMetadata {
  return {
    title: extractTitle(doc),
    looksLikeArticle: looksLikeArticle(doc),
  };
}

function extractTitle(doc: Document): string {
  const og = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content;
  if (og && og.trim().length > 0) return og.trim();
  const twitter = doc.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content;
  if (twitter && twitter.trim().length > 0) return twitter.trim();
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  if (h1 && h1.length > 0 && h1.length <= 200) return h1;
  return (doc.title ?? "").trim();
}

function looksLikeArticle(doc: Document): boolean {
  // Cheap heuristics — present so the content script can choose to defer
  // ingestion for pages that clearly aren't articles. M3 doesn't yet gate
  // on this; it's informational.
  if (doc.querySelector('article')) return true;
  if (doc.querySelector('main')) return true;
  const og = doc.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.content;
  if (og && /article|blog|story|post/i.test(og)) return true;
  // Substack-style class hints.
  if (doc.querySelector('.post-content, .entry-content, .article-body, [itemprop="articleBody"]')) return true;
  return false;
}
