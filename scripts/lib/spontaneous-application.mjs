/**
 * Standing "spontaneous application" entries that ATS feeds list next to real
 * vacancies (`Spontanbewerbung`, `Initiativbewerbung`, `Candidatura spontanea`,
 * `Candidature spontanée`, `Postulation spontanée`, `Spontaneous application`).
 * They are an application container, not an opening: no role, no workload, no
 * contract, and usually a one-paragraph body. Publishing them creates a false
 * vacancy; treating their short body as a parser failure fails a crawler whose
 * source simply has no open position.
 *
 * Shared by the crawlers that drop these entries before building jobs
 * (jobpublish-ch-common, imad, faulhaber), so the vocabulary is one list.
 */
export const SPONTANEOUS_APPLICATION_RE =
  /\b(?:spontan|initiativ|blind)\s*bewerbung|candidatur[ae]\s+spontan|postulation\s+spontan|spontaneous\s+application/i;

/** True when a posting title names a spontaneous-application container. */
export function isSpontaneousApplicationTitle(title = '') {
  return SPONTANEOUS_APPLICATION_RE.test(String(title || ''));
}
