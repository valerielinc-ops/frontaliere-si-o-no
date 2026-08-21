/**
 * Pure scoring functions for the GSC content-gap opportunity ranking
 * (scripts/gsc-content-opportunity-score.mjs, issue #6221). Kept
 * dependency-free and side-effect-free so the formula can be unit-tested
 * without mocking the Search Console API.
 *
 * score = normalized_impressions*0.35 + ctr_gap*0.25 + position_opportunity*0.20
 *       + business_value*0.10 + content_gap_confidence*0.10
 * (weights match the pseudo-score proposed in the issue body).
 *
 * business_value and content_gap_confidence can't be derived from GSC
 * numbers alone — they need editorial/business judgment and a read of the
 * current page content. This module only ranks candidates for a human/LLM
 * to review next (docs/gsc-content-refresh-playbook.md); both default to a
 * neutral 0.5, and business_value can be overridden per path-prefix.
 */

const POSITION_OPPORTUNITY_MIN = 4;
const POSITION_OPPORTUNITY_MAX = 20;

/**
 * 0 outside the "near page 1" band [4,20], ramping toward 1 as position
 * approaches 4 — a query at position 5 needs a much smaller push to reach
 * page 1 than one at position 19, so it scores as the bigger opportunity.
 * Mirrors the near-win weighting already used by buildNearWinQueries()
 * (scripts/lib/analytics-opportunity-utils.mjs), applied here at page level.
 */
export function computePositionOpportunity(position) {
  const p = Number(position) || 0;
  if (p < POSITION_OPPORTUNITY_MIN || p > POSITION_OPPORTUNITY_MAX) return 0;
  return (POSITION_OPPORTUNITY_MAX - p) / (POSITION_OPPORTUNITY_MAX - POSITION_OPPORTUNITY_MIN);
}

/**
 * Self-referential CTR gap: how far a page's CTR sits below the median CTR
 * of its peers (other pages in the same dataset within +/-3 positions).
 * Deliberately self-referential — an invented industry CTR-by-position
 * curve would be an unverifiable claim; comparing a page against its own
 * peer set needs no external benchmark and can't go stale.
 */
export function computeCtrGaps(pages) {
  const withNumbers = pages.map((p) => ({ ...p, ctr: Number(p.ctr) || 0, position: Number(p.position) || 0 }));
  return withNumbers.map((page) => {
    const peers = withNumbers.filter((p) => p !== page && Math.abs(p.position - page.position) <= 3);
    const pool = peers.length >= 3 ? peers : withNumbers;
    const sortedCtrs = pool.map((p) => p.ctr).sort((a, b) => a - b);
    const median = sortedCtrs.length ? sortedCtrs[Math.floor(sortedCtrs.length / 2)] : 0;
    const gap = median > 0 ? (median - page.ctr) / median : 0;
    return { ...page, ctrGap: Math.min(1, Math.max(0, gap)), peerMedianCtr: Number(median.toFixed(2)) };
  });
}

export function computeOpportunityScore({
  impressions,
  maxImpressions,
  ctrGap,
  position,
  businessValue = 0.5,
  contentGapConfidence = 0.5,
}) {
  const normalizedImpressions = maxImpressions > 0 ? Math.min(1, Number(impressions) / maxImpressions) : 0;
  const positionOpportunity = computePositionOpportunity(position);
  const score =
    normalizedImpressions * 0.35 +
    Math.min(1, Math.max(0, ctrGap)) * 0.25 +
    positionOpportunity * 0.20 +
    Math.min(1, Math.max(0, businessValue)) * 0.10 +
    Math.min(1, Math.max(0, contentGapConfidence)) * 0.10;
  return { score: Number(score.toFixed(4)), normalizedImpressions, positionOpportunity };
}

/**
 * Rank pages by opportunity score.
 * `weights` maps a path-prefix to a businessValue override in [0,1]
 * (unmatched paths default to neutral 0.5) — an explicit way to say "this
 * section matters more for the business" without guessing it from traffic.
 */
export function rankPageOpportunities(pages, { weights = {} } = {}) {
  const maxImpressions = pages.reduce((max, p) => Math.max(max, Number(p.impressions) || 0), 0);
  const withGaps = computeCtrGaps(pages);
  return withGaps
    .map((page) => {
      const prefix = Object.keys(weights).find((k) => page.page?.startsWith(k));
      const businessValue = prefix ? weights[prefix] : 0.5;
      const { score, normalizedImpressions, positionOpportunity } = computeOpportunityScore({
        impressions: page.impressions,
        maxImpressions,
        ctrGap: page.ctrGap,
        position: page.position,
        businessValue,
      });
      return { ...page, businessValue, normalizedImpressions, positionOpportunity, opportunityScore: score };
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
}
