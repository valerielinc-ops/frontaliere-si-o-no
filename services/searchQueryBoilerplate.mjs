/**
 * Search-query boilerplate stripping — leading job-search prefixes + trailing
 * template/nation-noise suffixes, across all 4 site locales (IT/EN/DE/FR).
 *
 * Single source of truth (rule #6: no copy-paste of a constant across files).
 * Plain .mjs so BOTH the .ts graph (services/relatedSearchClusters.ts, which
 * re-exports these for its existing callers) and raw-`node` build scripts
 * (scripts/build-search-cluster-301-map.mjs) import the EXACT same lists.
 * Mirrors the services/relatedSearchJunkTerms.mjs pattern.
 *
 * Extracted from services/relatedSearchClusters.ts (2026-07) so the
 * multi-locale nationalization logic in build-search-cluster-301-map.mjs no
 * longer has to hand-mirror an IT-only subset of this list (the previous
 * `LEADING_BOILERPLATE` local copy) — that mirror was IT-only because this
 * module used to live in a `.ts` file scripts run with plain `node` can't
 * import, which is why the legacy per-canton cluster-orphan candidate map
 * only ever covered the IT locale (candidate-generation gap, issue #2923).
 */

// Leading job-search prefixes stripped from the FRONT of a query/slug.
// Multi-word phrases come first so the alternation strips the longest leading
// match. Slugs hyphenate apostrophes, so the canonical FR "offres d'emploi"
// arrives as "offres d emploi" — listed verbatim with a bare "d" token.
export const SEARCH_QUERY_BOILERPLATE_PHRASES = [
  'offerte di lavoro',
  'posti di lavoro',
  'offerte lavoro',
  // FR: full parity with the prior /offres?\s+(?:d\s+)?emplois?/ — singular
  // "offre", optional bare "d" (apostrophe hyphenated by slugs), plural
  // "emplois". Longest forms first so the alternation strips the most.
  'offres d emplois',
  'offre d emplois',
  'offres d emploi',
  'offre d emploi',
  'offres emplois',
  'offre emplois',
  'offres emploi',
  'offre emploi',
  'recherche emploi',
  'recherche d emploi',
  'recherche d emplois',
  'stellenangebote',
  'stellenangebot',
  'stellen',
  'lavori',
  'lavoro',
  'impieghi',
  'impiego',
  'offerte',
  'jobs',
  'job',
  'emplois',
  'emploi',
  // IT salary/duties template heads (also stripped as trailing nation/template
  // suffixes below). Listed here so an existing slug like
  // `ricerca-stipendio-infermiere-svizzera` strips its LEADING "stipendio" too.
  'stipendio',
  'mansioni',
];

// Trailing template / nation-noise terms appended by the related-search
// candidate templates ("<title> salary switzerland", "<title> requirements",
// "stipendio <title> svizzera"). Stripped from the trailing position only, so
// a content word that merely happens to equal one of them mid-query is
// untouched. Multilingual: EN/FR/DE/IT.
export const SEARCH_QUERY_TEMPLATE_SUFFIX_TERMS = [
  // salary
  'salary', 'wage', 'salaire', 'gehalt', 'lohn', 'stipendio',
  // nation
  'switzerland', 'suisse', 'schweiz', 'svizzera',
  // requirements / duties
  'requirements', 'requirement', 'requisiti', 'exigences', 'anforderungen',
  'mansioni', 'aufgaben', 'taches',
];

// Every individual word that may legitimately be stripped as boilerplate —
// from EITHER the leading prefix list OR the trailing template-suffix list.
export const SEARCH_QUERY_BOILERPLATE_TOKENS = new Set([
  ...SEARCH_QUERY_BOILERPLATE_PHRASES.flatMap((p) => p.split(' ')),
  ...SEARCH_QUERY_TEMPLATE_SUFFIX_TERMS,
]);

const SEARCH_QUERY_BOILERPLATE_PREFIX = new RegExp(
  `^(?:${SEARCH_QUERY_BOILERPLATE_PHRASES.map((p) => p.replace(/\s+/g, '\\s+')).join('|')})\\s+`,
  'i',
);

// Trailing-suffix counterpart: requires whitespace BEFORE the term (mirrors the
// leading `\s+` guard) so a bare query equal to the term is never emptied here.
const SEARCH_QUERY_TEMPLATE_SUFFIX = new RegExp(
  `\\s+(?:${SEARCH_QUERY_TEMPLATE_SUFFIX_TERMS.join('|')})$`,
  'i',
);

export function stripSearchQueryBoilerplate(query) {
  // Iteratively peel a leading job-search prefix AND/OR a trailing template /
  // nation suffix until the query is stable. One pass strips at most one prefix
  // and one suffix, so multi-word tails like "… salary switzerland" need two
  // passes. Never empty the query: a slug that is *only* boilerplate (e.g.
  // /ricerca-lavoro/ or /recherche-…-switzerland/) keeps its original term so
  // the box is not left blank.
  let stripped = query.trim();
  let prev = '';
  while (stripped && stripped !== prev) {
    prev = stripped;
    stripped = stripped
      .replace(SEARCH_QUERY_BOILERPLATE_PREFIX, '')
      .replace(SEARCH_QUERY_TEMPLATE_SUFFIX, '')
      .trim();
  }
  return stripped || query;
}
