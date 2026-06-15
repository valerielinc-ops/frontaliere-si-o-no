/**
 * Shared search stemmer + OR-fallback relevance helpers.
 *
 * SINGLE SOURCE OF TRUTH for query/job token stemming. Lives as a pure `.mjs`
 * (no TS types, no DOM) so it can be imported by ALL three matchers that must
 * stay byte-identical or the static cluster page diverges from the hydrated SPA:
 *   - services/textUtils.ts          (SPA: re-exports stemSearchToken)
 *   - build-plugins/relatedSearchClustersPlugin.ts  (static SSG matcher)
 *   - build-plugins/relatedSearchPostingsWorker.mjs (off-thread postings index)
 *
 * Before this module the worker carried a "verbatim copy" of the stemmer and
 * the build plugin did NOT stem at all — so a query like
 * `ricerca-…-cure-infermieristiche-…` never matched "infermiere" jobs on the
 * static (indexed, first-paint) page, and any future edit risked drifting the
 * three copies. Consolidating here makes the drift impossible by construction
 * (AGENTS.md Non-Negotiable #6).
 *
 * @module searchStem
 */

/**
 * Minimum residual length a derivational suffix strip may leave. Guards against
 * over-stemming short words to a meaningless root (e.g. "vita" → "v").
 */
const MIN_DERIV_STEM = 4;

/**
 * Italian derivational suffixes, longest-first. Stripping these collapses the
 * adjectival / nominalized / agentive variants of a domain word onto a shared
 * root so the search matches the ROOT, not the exact surface form:
 *   infermieristiche / infermieristico → infermier  (↔ infermiere/infermieri)
 *   specialista / specialisti          → special    (↔ specializzato via vowel strip is separate)
 *   educazione / educazioni            → educ
 *   magazzinaggio                      → magazzin
 *   allenamento                        → allen
 * Each strip only fires when ≥ MIN_DERIV_STEM chars remain, so the residual
 * stays a real prefix of the inflected form (prefix/substring matching does the
 * rest). Ordered longest-first so the most specific suffix wins.
 */
const DERIVATIONAL_SUFFIXES = [
  // -ist- professional / adjectival family
  'istiche', 'istici', 'istico', 'istica', 'isti', 'iste', 'ista', 'isto',
  // -zione / -sione nominalizations
  'azioni', 'azione', 'izioni', 'izione', 'zioni', 'zione', 'sioni', 'sione',
  // -mento process nouns
  'amento', 'imento', 'amenti', 'imenti',
  // -aggio
  'aggio', 'aggi',
  // -mente adverbs
  'mente',
];

/**
 * Light Italian/multilingual stemmer. Two layers:
 *   1. Strip ONE derivational suffix (longest match, residual ≥ MIN_DERIV_STEM).
 *   2. Collapse up to two trailing vowels so plural/feminine inflections meet
 *      (pulizie/pulizia → puliz, infermiere/infermieri → infermier).
 * Tokens ≤ 3 chars are returned untouched (avoid over-stemming "ai"/"the").
 * Distinct words with distinct consonant stems stay distinct (casa→cas,
 * cassa→cass) because the vowel strip never crosses a consonant.
 *
 * @param {string} token normalized lowercase ascii token
 * @returns {string} stem
 */
export function stemSearchToken(token) {
  if (typeof token !== 'string' || token.length <= 3) return token;

  let work = token;
  for (const suffix of DERIVATIONAL_SUFFIXES) {
    if (work.length - suffix.length >= MIN_DERIV_STEM && work.endsWith(suffix)) {
      work = work.slice(0, work.length - suffix.length);
      break;
    }
  }

  const stem = work.replace(/[aeiou]{1,2}$/, '');
  return stem.length >= 3 ? stem : work;
}

/**
 * Stem every alphanumeric word of an already-normalized haystack and re-join
 * with single spaces. Shared verbatim by the static cluster matcher
 * (TokenIndex.getHaystacks) and the off-thread postings worker so their
 * haystacks — and therefore the gram/postings index built from them — are
 * byte-identical. Callers pass their OWN normalized text (the plugin/worker
 * keep their NFKD `normalizeText`); this only owns the stemming step.
 *
 * @param {string} normalizedText lowercased, diacritics-stripped text
 * @returns {string} space-joined stemmed tokens
 */
export function stemHaystack(normalizedText) {
  return String(normalizedText || '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stemSearchToken)
    .join(' ');
}

