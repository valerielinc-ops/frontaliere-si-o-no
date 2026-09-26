/**
 * Classifies WHY a job-alert matched zero jobs this run, using only the
 * alert's own HARD filters — buildAlertProfile (services/jobAlertMatching.mjs)
 * documents hardKeywords/hardCategoryKeys, alertLocations/cantons, and
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

/**
 * Decide the lifecycle action for the canonical zero-match monitor issue.
 * Dry-run and targeted operator sends are deliberately non-authoritative, and
 * an empty denominator cannot prove recovery.
 */
export function getZeroMatchMonitorAction({
  zeroMatchCount = 0,
  alertCount = 0,
  threshold = 0.2,
  dryRun = false,
  targeted = false,
} = {}) {
  if (
    dryRun
    || targeted
    || !Number.isFinite(zeroMatchCount)
    || !Number.isFinite(alertCount)
    || !Number.isFinite(threshold)
    || alertCount <= 0
    || zeroMatchCount < 0
  ) {
    return 'skip';
  }
  return zeroMatchCount / alertCount > threshold ? 'report' : 'resolve';
}

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
 * Aggregate matcher health without treating an empty recipient-aware candidate
 * window as a filtering failure. Those alerts remain visible as a separate
 * count, but only alerts that reached scoring belong in the rate denominator.
 */
export function summarizeZeroMatchPlans(plans = []) {
  const zeroMatchByCause = {};
  let evaluatedAlertCount = 0;
  let noEligibleCandidateCount = 0;
  let emptyProfileCount = 0;
  let zeroMatchCount = 0;

  for (const plan of plans) {
    if ((plan?.candidateCount ?? 0) === 0) {
      noEligibleCandidateCount += 1;
      continue;
    }
    if ((plan?.rankedCount ?? 0) > 0) {
      evaluatedAlertCount += 1;
      continue;
    }
    const cause = plan?.zeroCause || ZERO_MATCH_CAUSES.EMPTY_PROFILE;
    if (cause === ZERO_MATCH_CAUSES.EMPTY_PROFILE) {
      emptyProfileCount += 1;
      continue;
    }
    evaluatedAlertCount += 1;
    zeroMatchCount += 1;
    zeroMatchByCause[cause] = (zeroMatchByCause[cause] || 0) + 1;
  }

  return {
    alertCount: plans.length,
    evaluatedAlertCount,
    noEligibleCandidateCount,
    emptyProfileCount,
    zeroMatchCount,
    zeroMatchRate: evaluatedAlertCount > 0 ? zeroMatchCount / evaluatedAlertCount : null,
    zeroMatchByCause,
  };
}
