// scripts/lib/discovery/sources/orphanQuerySource.mjs
//
// Discovery source: GSC orphan queries. Reads the pre-aggregated
// `evidence.gsc.orphanQueries` array (built by the daily evidence ETL —
// Phase 1) and converts each entry to a discovery candidate. No external
// API call.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.3.1

const SOURCE_TAG = 'orphan';

/**
 * Tokens that mean "job search" on their own, unambiguously.
 */
const JOB_SEARCH_INTENT_STRONG_RE =
  /\b(cerco|cercare|annunci?|lavoro|jobs?|assunzioni|curriculum|cv)\b/i;

/**
 * Tokens that mean "job search" only next to a job word, and something else
 * entirely on their own — same ambiguity the vacancy-path classifier in
 * `scripts/lib/prospector/extract.mjs` was split out for (PR #6375):
 * `offerte` is retail/promo as often as vacancies ("offerte black friday"),
 * `posti` is parking spaces and rental beds as often as "posti di lavoro".
 * Bare in an alternation they would wrongly flag a non-job query as job
 * intent and drop it from article discovery (`isArticleableOrphanQuery`
 * below), losing a legitimate orphan-query article candidate.
 */
const JOB_SEARCH_INTENT_WEAK_RE = /\b(offert[ae]|posti?)\b/i;

/** Words that disambiguate a weak token appearing in the same query. */
const JOB_SEARCH_INTENT_QUALIFIER_RE =
  /\b(lavoro|lavori|jobs?|assunzion\w*|impieg\w*|occupazion\w*|carrier\w*|candidat\w*|recruit\w*)\b/i;

/**
 * Job phrases observed in GSC where the weak token is disambiguated by a
 * vocational term. Keep the terms adjacent instead of adding them to the
 * general qualifier: a query such as "posti auto vicino allo stage" is still
 * about parking, not vacancies.
 */
const JOB_SEARCH_INTENT_WEAK_JOB_PHRASE_RE =
  /\b(?:offert[ae]\s+(?:di\s+)?(?:stage|tirocin\w*|apprendistat\w*)|post[oi]\s+(?:di\s+)?(?:stage|tirocin\w*|apprendistat\w*|vacant\w*)|apprendistat\w*(?:\s+\w+){0,3}\s+post[oi])\b/i;

/**
 * Whether a query reads as job-search intent.
 *
 * @param {string} query
 * @returns {boolean}
 */
function hasJobSearchIntent(query) {
  if (JOB_SEARCH_INTENT_STRONG_RE.test(query)) return true;
  if (JOB_SEARCH_INTENT_WEAK_JOB_PHRASE_RE.test(query)) return true;
  return JOB_SEARCH_INTENT_WEAK_RE.test(query) && JOB_SEARCH_INTENT_QUALIFIER_RE.test(query);
}

const FRONTALIERE_ARTICLE_INTENT_RE =
  /\b(frontalier[aeio]|permesso\s*g|tass|impost|fisc|stipendio|salario|busta\s*paga|avs|lpp|lamal|cmi|ristorni|telelavoro|smart\s*working|disoccupazione|naspi|dichiarazione|credito\s+d.?imposta)\b/i;

/**
 * @typedef {{
 *   headline: string,
 *   url: string|null,
 *   source: 'orphan',
 *   meta: { imp: number, pos: number, ctr: number, clicks: number },
 * }} OrphanCandidate
 */

function isValidEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.query !== 'string' || entry.query.trim().length === 0) return false;
  return true;
}

export function isArticleableOrphanQuery(query) {
  const q = String(query || '').trim();
  if (!q) return false;
  if (hasJobSearchIntent(q) && !FRONTALIERE_ARTICLE_INTENT_RE.test(q)) return false;
  return true;
}

/**
 * Fetch orphan-query candidates from the evidence index. Pure — no I/O.
 *
 * @param {object} evidence — parsed data/evidence-index.json
 * @returns {OrphanCandidate[]}
 */
export function fetchOrphanCandidates(evidence) {
  const orphans = evidence?.gsc?.orphanQueries;
  if (!Array.isArray(orphans) || orphans.length === 0) return [];

  const seen = new Set();
  const out = [];
  for (const entry of orphans) {
    if (!isValidEntry(entry)) continue;
    const headline = entry.query.trim();
    if (!isArticleableOrphanQuery(headline)) continue;
    const key = headline.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      headline,
      url: typeof entry.topLandingPage === 'string' ? entry.topLandingPage : null,
      source: SOURCE_TAG,
      meta: {
        imp: Number(entry.imp) || 0,
        pos: Number(entry.pos) || 0,
        ctr: Number(entry.ctr) || 0,
        clicks: Number(entry.clicks) || 0,
      },
    });
  }
  return out;
}

export default fetchOrphanCandidates;
