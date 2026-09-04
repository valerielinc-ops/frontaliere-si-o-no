/**
 * The ONE derivation of an article's `article:author` URL.
 *
 * Issue #7241 item 1 (follow-up of #7227). The tag used to have two independent
 * sources for the same fact: the static build derived it from `authorSlug` +
 * `data/authors.ts`, while `services/seoService.ts` read `structuredData.author`
 * out of the generated `content/seo/seo-blog*.ts` blobs. #7227 fixed the value the
 * SSG emitted; it left the two sources able to disagree, and measured they already
 * did — 1712 of the 3692 articles carry a real `authorSlug` while their SEO blob still
 * holds the legacy `{"@id": …#organization}` node, so the SPA overwrote a correct
 * static `article:author` with `/chi-siamo/` on every one of them: #7227's own bug,
 * transposed onto the client-rendered surface.
 *
 * The registry (`authorSlug` → `data/authors.ts`) is the source of truth, exactly as
 * on the static side. The blob's Person node is only a FALLBACK, for entries whose
 * article carries no resolvable `authorSlug`; a blob that names nobody falls through
 * to the team page, which is the same URL the Organization JSON-LD branch emits.
 * Drift between the two can no longer produce a wrong tag: the loser is the fallback.
 *
 * Deliberately static-registry, NOT `getEffectiveArticleByline`: an admin
 * reassignment lives in Firestore and the static build cannot see it, so honouring
 * it here would re-open the very divergence this module closes. Reassignment
 * regenerates the article's data; the tag follows it from there.
 */
import { getAuthorBySlug } from '@/data/authors';

const BASE_URL = 'https://frontaliereticino.ch';

/** Team page — the Organization fallback shared by both surfaces. */
export const ORG_AUTHOR_URL = `${BASE_URL}/chi-siamo/`;

/** Author page URL for a registry slug. Mirrors `authorObj.url` in ogPagesPlugin.ts. */
export const authorPageUrl = (slug: string): string => `${BASE_URL}/autori/${slug}/`;

/**
 * Resolve `article:author` for a blog article id, given the blob's author node.
 *
 * Pure: the caller supplies both inputs, so the same function can be exercised
 * against the registry in `tests/article-author-source-parity.test.ts` without a DOM.
 */
export function resolveArticleAuthorUrl(
  article: { authorSlug?: string } | undefined,
  blobAuthor?: { '@type'?: string; url?: string } | undefined,
): string {
  const resolved = article?.authorSlug ? getAuthorBySlug(article.authorSlug) : undefined;
  if (resolved) return authorPageUrl(resolved.slug);
  if (blobAuthor?.['@type'] === 'Person' && typeof blobAuthor.url === 'string' && blobAuthor.url) {
    return blobAuthor.url;
  }
  return ORG_AUTHOR_URL;
}

let articlesByIdPromise: Promise<ArticleAuthorRegistry> | null = null;

/** Article id → the fields this derivation needs. */
export type ArticleAuthorRegistry = ReadonlyMap<string, { authorSlug?: string }>;

/**
 * Article registry keyed by id, lazily loaded once.
 *
 * `data/blog-articles-data.ts` is a dynamically imported chunk (FRO-328) that the
 * article page already pulls in for its own rendering, so this adds no request on
 * the page where it is used. A failed import degrades to the blob fallback rather
 * than dropping the tag.
 *
 * Awaited ONCE, up front, by `updateSEO()` — the derivation itself stays synchronous
 * so no `await` lands between the meta-tag writes, where a soft navigation could
 * interleave and leave the head half-updated.
 */
export async function loadArticleAuthorRegistry(): Promise<ArticleAuthorRegistry> {
  if (!articlesByIdPromise) {
    articlesByIdPromise = import('@/data/blog-articles-data')
      .then((m) => new Map(m.ARTICLES.map((a) => [a.id, { authorSlug: a.authorSlug }])))
      .catch(() => new Map<string, { authorSlug?: string }>());
  }
  return articlesByIdPromise;
}
