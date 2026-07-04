/**
 * News-ticker slim payload — PLACEHOLDER MODULE.
 *
 * At dev/build time `build-plugins/newsTickerDataPlugin.ts` replaces this
 * module's content with the 5 most recent blog articles (id, date,
 * per-locale title, per-locale URL slug) generated from the article
 * registry + blog-meta locale files + BLOG_SLUGS. See the plugin header
 * for the full rationale (issues #3528 / #3532: the homepage ticker must
 * not pull ~1.9 MB of blog metadata JS to render 5 titles).
 *
 * This committed fallback (empty list) only ever loads where the Vite
 * plugin pipeline is absent (e.g. vitest importing components directly);
 * consumers must render their loading skeleton for an empty list.
 * Correctness of the generated payload is gated by
 * tests/news-ticker-data.test.ts against the plugin generator itself.
 */
export interface TickerArticle {
  id: string;
  date: string;
  title: Record<'it' | 'en' | 'de' | 'fr', string>;
  slug: Record<'it' | 'en' | 'de' | 'fr', string>;
}

export const TICKER_ARTICLES: TickerArticle[] = [];
