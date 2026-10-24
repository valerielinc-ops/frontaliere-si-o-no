/**
 * Runtime JSON-LD for blog articles: which nodes of the legacy SEO shard the
 * SPA may still inject.
 *
 * The article node itself (`Article`/`NewsArticle`/`BlogPosting`) is owned by
 * the registry-derived author path — `packages/articles/engine/ogPagesPlugin.ts`
 * in the static HTML and `components/community/BlogArticles.tsx` after
 * hydration — both of which resolve the byline from `authorSlug` +
 * `data/authors.ts`. The shard copy under `packages/articles/content/seo/**`
 * still carries thousands of legacy `author` nodes typed `Person`
 * ("Redazione Frontaliere Ticino" as a person, editorial profiles as people,
 * a self-assigned "Esperta fiscale" title). Injecting it at runtime put those
 * claims back into the rendered DOM that crawlers execute, contradicting the
 * served HTML. The other shard nodes (FAQPage, Event, …) carry no author and
 * stay.
 */
const ARTICLE_NODE_TYPES: ReadonlySet<string> = new Set(['Article', 'NewsArticle', 'BlogPosting']);

function isArticleNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const raw = (node as Record<string, unknown>)['@type'];
  const types = Array.isArray(raw) ? raw : [raw];
  return types.some((type) => typeof type === 'string' && ARTICLE_NODE_TYPES.has(type));
}

export function withoutShardArticleNodes<T>(nodes: readonly T[]): T[] {
  return nodes.filter((node) => !isArticleNode(node));
}
