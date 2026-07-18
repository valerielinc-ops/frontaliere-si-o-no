/**
 * Classifies WHY a job-alert matched zero jobs this run, using only the
 * alert's own HARD filters — buildAlertProfile (services/jobAlertMatching.mjs)
 * documents hardKeywords, alertLocations/cantons, and specificJobIds/
 * specificCompanyKey as the only HARD eliminators; sectors/contractTypes are
 * soft ranking signals there and never zero out a match on their own. No
 * re-scoring against the job pool — a field-only heuristic, cheap enough to
 * run for every zero-match alert in a run.
 */
export const ZERO_MATCH_CAUSES = {
  PINNED_JOB_GONE: 'pinned-job-or-company-gone',
  KEYWORD_NARROW: 'keyword-narrow',
  GEO_NARROW: 'geo-narrow',
  KEYWORD_AND_GEO_NARROW: 'keyword-and-geo-narrow',
  NO_HARD_FILTERS: 'no-hard-filters',
};

export function classifyZeroMatchCause(profile) {
  const p = profile || {};
  if ((p.specificJobIds?.length ?? 0) > 0 || p.specificCompanyKey) {
    return ZERO_MATCH_CAUSES.PINNED_JOB_GONE;
  }
  const hasKeywords = (p.hardKeywords?.size ?? 0) > 0;
  const hasGeo = (p.alertLocations?.length ?? 0) > 0 || (p.cantons?.length ?? 0) > 0;
  if (hasKeywords && hasGeo) return ZERO_MATCH_CAUSES.KEYWORD_AND_GEO_NARROW;
  if (hasKeywords) return ZERO_MATCH_CAUSES.KEYWORD_NARROW;
  if (hasGeo) return ZERO_MATCH_CAUSES.GEO_NARROW;
  return ZERO_MATCH_CAUSES.NO_HARD_FILTERS;
}
