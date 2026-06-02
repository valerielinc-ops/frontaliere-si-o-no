/**
 * Switzerland-wide article META translations (en) — titles, excerpts, imageAlt.
 * Mirror of blog-meta-en.ts for section="svizzera". Keys use the shared
 * `blog.article.{id}.*` namespace (ids never collide across sections).
 * Appended by scripts/create-article.mjs --section=svizzera.
 */
const blogMetaChEn: Record<string, string> = {
  'blog.article.costo-vita-svizzera-2026.title': 'Cost of Living in Switzerland 2026: Cantons',
  'blog.article.costo-vita-svizzera-2026.excerpt': 'How much does it cost to live in Switzerland in 2026? A canton-by-canton comparison of rent, health premiums, taxes and daily spending.',
  'blog.article.costo-vita-svizzera-2026.imageAlt': 'Scale models of Swiss buildings at Swissminiatur in Melide, symbolising the comparison between cantons.',
  'blog.article.premi-cassa-malati-svizzera-2026.title': 'Health Premiums 2026: What Changes Switzerland',
  'blog.article.premi-cassa-malati-svizzera-2026.excerpt': 'Mandatory LAMal health-insurance premiums rise by about 6% on average in 2026. Cantonal differences, deductibles and how to save.',
  'blog.article.premi-cassa-malati-svizzera-2026.imageAlt': 'View of Bellinzona with its medieval castles, capital of one of the costlier cantons for health insurance.',
};

export default blogMetaChEn;
