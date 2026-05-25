// scripts/lib/discovery/sources/orphanQuerySource.mjs
//
// Discovery source: GSC orphan queries. Reads the pre-aggregated
// `evidence.gsc.orphanQueries` array (built by the daily evidence ETL —
// Phase 1) and converts each entry to a discovery candidate. No external
// API call.
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.3.1

const SOURCE_TAG = 'orphan';

const JOB_SEARCH_INTENT_RE =
  /\b(cerco|cercare|offert[ae]|annunci?|posti?|lavoro|jobs?|assunzioni|curriculum|cv)\b/i;

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
  if (JOB_SEARCH_INTENT_RE.test(q) && !FRONTALIERE_ARTICLE_INTENT_RE.test(q)) return false;
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
