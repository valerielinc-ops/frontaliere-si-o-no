/**
 * Classifies WHY a job-alert matched zero jobs this run, using only the
 * alert's own HARD filters — buildAlertProfile (services/jobAlertMatching.mjs)
 * documents hardKeywords/hardCategoryKeys/hardTaxonomyValues, alertLocations/cantons, and
 * specificJobIds/specificCompanyKey as the only HARD eliminators;
 * sectors/contractTypes are soft ranking signals there and never zero out a
 * match on their own. No re-scoring against the job pool — a field-only
 * heuristic, cheap enough to run for every zero-match alert in a run.
 */
export const ZERO_MATCH_CAUSES = {
  NO_ELIGIBLE_CANDIDATES: 'no-eligible-candidates',
  PINNED_JOB_GONE: 'pinned-job-or-company-gone',
  KEYWORD_NARROW: 'keyword-narrow',
  GEO_NARROW: 'geo-narrow',
  KEYWORD_AND_GEO_NARROW: 'keyword-and-geo-narrow',
  SOFT_PROFILE_NARROW: 'soft-profile-narrow',
  EMPTY_PROFILE: 'empty-profile',
};

export function classifyZeroMatchCause(profile, { eligibleCandidateCount } = {}) {
  if (eligibleCandidateCount === 0) {
    return ZERO_MATCH_CAUSES.NO_ELIGIBLE_CANDIDATES;
  }
  const p = profile || {};
  if ((p.specificJobIds?.length ?? 0) > 0 || p.specificCompanyKey) {
    return ZERO_MATCH_CAUSES.PINNED_JOB_GONE;
  }
  const hasKeywords = (p.hardKeywords?.size ?? 0) > 0;
  const hasGeo = (p.alertLocations?.length ?? 0) > 0 || (p.cantons?.length ?? 0) > 0;
  if (hasKeywords && hasGeo) return ZERO_MATCH_CAUSES.KEYWORD_AND_GEO_NARROW;
  if (hasKeywords) return ZERO_MATCH_CAUSES.KEYWORD_NARROW;
  if (hasGeo) return ZERO_MATCH_CAUSES.GEO_NARROW;
  const hasSoftProfile = (p.softTokens?.size ?? 0) > 0
    || Boolean(p.company)
    || (p.locations?.length ?? 0) > 0
    || (p.sectors?.length ?? 0) > 0
    || (p.contractTypes?.length ?? 0) > 0;
  return hasSoftProfile
    ? ZERO_MATCH_CAUSES.SOFT_PROFILE_NARROW
    : ZERO_MATCH_CAUSES.EMPTY_PROFILE;
}

/**
 * Aggregate the zero-match YIELD of the real alerts without treating an empty
 * recipient-aware candidate window as a filtering failure. Those alerts remain
 * visible as a separate count, but only alerts that reached scoring belong in
 * the rate denominator. Informative only since the owner decision of
 * 2026-10-04 (issue 9060): the monitor issue is driven by the matcher-health
 * probes of job-alert-matcher-health.mjs, which run on the active inventory.
 */
export function createZeroMatchSummaryAccumulator() {
  return {
    alertCount: 0,
    evaluatedAlertCount: 0,
    noEligibleCandidateCount: 0,
    emptyProfileCount: 0,
    zeroMatchCount: 0,
    zeroMatchByCause: {},
  };
}

export function addZeroMatchPlanToSummary(summary, plan) {
  summary.alertCount += 1;
  if ((plan?.candidateCount ?? 0) === 0) {
    summary.noEligibleCandidateCount += 1;
    return summary;
  }
  if ((plan?.rankedCount ?? 0) > 0) {
    summary.evaluatedAlertCount += 1;
    return summary;
  }
  const cause = plan?.zeroCause || ZERO_MATCH_CAUSES.EMPTY_PROFILE;
  if (cause === ZERO_MATCH_CAUSES.EMPTY_PROFILE) {
    summary.emptyProfileCount += 1;
    return summary;
  }
  summary.evaluatedAlertCount += 1;
  summary.zeroMatchCount += 1;
  summary.zeroMatchByCause[cause] = (summary.zeroMatchByCause[cause] || 0) + 1;
  return summary;
}

export function finalizeZeroMatchSummary(summary) {
  return {
    ...summary,
    zeroMatchRate: summary.evaluatedAlertCount > 0
      ? summary.zeroMatchCount / summary.evaluatedAlertCount
      : null,
  };
}

export function summarizeZeroMatchPlans(plans = []) {
  const summary = createZeroMatchSummaryAccumulator();
  for (const plan of plans) addZeroMatchPlanToSummary(summary, plan);
  return finalizeZeroMatchSummary(summary);
}
