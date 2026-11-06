/**
 * Which related-search candidates may enter data/related-search-candidates.json.
 *
 * The file is append-only: an entry is a live page, so it never leaves. Without a
 * gate every (job, term) pair of the week entered too, the file reached 722k slugs
 * and 157 MB, the 90 MB push ceiling dropped it silently, and from 2026-06-29 no
 * new search page was published while the job pages kept linking them.
 *
 * A NEW slug is admitted only with evidence: at least MIN_NEW_CANDIDATE_JOBS
 * postings, or Search Console demand, or real requests that hit a 404. Everything
 * else stays reachable through the edge fallback in locale-router.js (200 noindex).
 */
export const MIN_NEW_CANDIDATE_JOBS = 3;

export function shouldAdmitCandidate({ known, jobCount, gscMatch, requestedOn404 }) {
  return known || jobCount >= MIN_NEW_CANDIDATE_JOBS || gscMatch === true || requestedOn404 === true;
}

/** `sampleJobIds` has no reader and costs a quarter of the file. */
export function toStoredCandidate({ sampleJobIds, ...candidate }) {
  return candidate;
}

/** The entry for a slug requested on a 404 that the current postings do not produce. */
export function demandCandidate({ slug, locale }) {
  return {
    slug,
    locale,
    jobCount: 1,
    sampleJobIds: [],
    sampleTerms: new Set([slug.replace(/^(ricerca|search|suche|recherche)-/, '').replace(/-/g, ' ')]),
    requestedOn404: true,
  };
}
