// searchSlugStopwords.ts
//
// P1 noindex plan (2026-10-24): lead tokens that disqualify a search landing
// slug (related-search clusters, GSC keyword landings) from the index.
//
// Lead tokens that never name a job, a sector or a place. A cluster slug is
// harvested from query/title n-grams, so the first token is sometimes a
// pronoun, an auxiliary or a marketing word lifted from an ad
// (`/de/jobs-in-schweiz/suche-auch-sion/`, `/en/find-jobs-switzerland/
// search-member-chur/`, `/fr/trouver-emploi-suisse/recherche-etes-basel/`).
// Measured on the 80 926 URLs of sitemap-search-clusters-* (2026-10-23):
// 1 197 URLs open with one of these tokens; 10 had an impression in 90 days,
// 4 a click (4 clicks in total).
//
// Listed per language for review, matched against the UNION: the slug carries
// the source ad's language, not the URL locale (`fr:projektleiter` × 45).
// Tokens are slug-normalised (lowercase, diacritics stripped: `für` → `fur`).
// Ambiguous words that do open real queries stay OUT of the list (`part` →
// "part-time", `stage`, `offerte`, `lavoro`, `travail`, `arbeit`).
export const CLUSTER_SLUG_LEAD_STOPWORDS_BY_LANG: Readonly<Record<'it' | 'en' | 'de' | 'fr', readonly string[]>> = {
  it: ['il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'di', 'da', 'del', 'della', 'per', 'con', 'e', 'o', 'oppure', 'nel', 'alla', 'che', 'chi', 'sono', 'siamo', 'essere', 'anche', 'ogni', 'nuovo', 'nuova', 'tutti', 'settimane', 'giorno'],
  en: ['the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'by', 'our', 'we', 'you', 'your', 'are', 'is', 'be', 'will', 'can', 'have', 'has', 'all', 'more', 'other', 'this', 'that', 'join', 'looking', 'seeking', 'member', 'future', 'station', 'offer', 'good', 'new'],
  de: ['auch', 'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einer', 'mit', 'fur', 'von', 'bei', 'zu', 'im', 'am', 'an', 'auf', 'aus', 'ab', 'als', 'bist', 'bin', 'ist', 'sind', 'hast', 'hat', 'kann', 'dich', 'dir', 'du', 'sie', 'wir', 'ihr', 'ihre', 'unser', 'unsere', 'unserer', 'unseren', 'dein', 'deine', 'uber', 'sowie', 'bzw', 'inkl', 'ca', 'wo', 'was', 'wie', 'wenn', 'mehr', 'suchen', 'sucht', 'gesucht'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'pour', 'avec', 'vous', 'nous', 'notre', 'votre', 'vos', 'nos', 'avez', 'etes', 'sont', 'est', 'qui', 'que', 'tout', 'tous', 'on', 'jour'],
};
const CLUSTER_SLUG_LEAD_STOPWORDS: ReadonlySet<string> = new Set(
  Object.values(CLUSTER_SLUG_LEAD_STOPWORDS_BY_LANG).flat(),
);
const CLUSTER_SEARCH_SLUG_PREFIX_RX = /^(?:ricerca|search|suche|recherche)-/;

/** First token of a cluster slug, search-route prefix removed. */
export function clusterSlugLeadToken(slug: string): string {
  return String(slug || '').toLowerCase().replace(CLUSTER_SEARCH_SLUG_PREFIX_RX, '').split('-')[0] || '';
}

/** True when the cluster slug opens with a token that never names a job. */
export function hasClusterStopwordLead(slug: string): boolean {
  return CLUSTER_SLUG_LEAD_STOPWORDS.has(clusterSlugLeadToken(slug));
}
