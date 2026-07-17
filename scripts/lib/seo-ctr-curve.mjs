/**
 * seo-ctr-curve.mjs — shared expected-CTR-by-position model + template
 * family registry for the SERP CTR pipeline (issue #4300).
 *
 * Single source of truth used by BOTH scripts/seo-ctr-baseline.mjs (one-off
 * gap analysis) and scripts/monitor-seo-ctr-by-template.mjs (scheduled
 * threshold monitor) — per AGENTS.md sibling-pattern discipline, the
 * expected-CTR curve and the family prefix list must never drift between
 * the two call sites.
 *
 * The curve is a blended organic CTR-by-position benchmark (rounded from
 * publicly published organic CTR studies, e.g. Advanced Web Ranking /
 * Backlinko aggregate curves). It is intentionally coarse — this is a
 * "is this family systematically underperforming its position" signal,
 * not a precise per-query prediction.
 *
 * The weighted-position/CTR ratio math reuses
 * scripts/lib/analytics-opportunity-utils.mjs's weightedAveragePosition() /
 * computeCtr() — the same divide-by-zero-guarded formula
 * aggregateRowsByTemplate() there uses, extracted so the two independent
 * GSC row-aggregation call sites can't drift apart.
 */

import { weightedAveragePosition, computeCtr } from './analytics-opportunity-utils.mjs';

// Index 0 unused — GSC positions are 1-based. Values are CTR fractions
// (0.316 === 31.6%).
const CTR_BY_POSITION = [
  null,
  0.316, 0.155, 0.106, 0.072, 0.056,
  0.044, 0.037, 0.032, 0.028, 0.025,
  0.022, 0.019, 0.017, 0.015, 0.013,
  0.012, 0.011, 0.010, 0.009, 0.008,
];
const TAIL_CTR = 0.006; // position > 20

/** Expected organic CTR (fraction, e.g. 0.037) for a given average position. */
export function expectedCtrForPosition(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p < 1) return CTR_BY_POSITION[1];
  const idx = Math.round(p);
  if (idx >= 1 && idx < CTR_BY_POSITION.length) return CTR_BY_POSITION[idx];
  return TAIL_CTR;
}

/**
 * Ratio of actual to expected CTR at a given position. <1 = underperforming
 * the position curve, >1 = overperforming. Returns null when position is
 * not a finite number (can't evaluate).
 */
export function ctrGapRatio(actualCtr, position) {
  const expected = expectedCtrForPosition(position);
  if (!expected) return null;
  return Number(actualCtr) / expected;
}

/**
 * Template families targeted by issue #4300, plus two reference families
 * cited in the issue as healthy CTR benchmarks (report-only — no target,
 * never trigger the monitor).
 *
 * `targetCtr` values come directly from the issue's acceptance criteria.
 */
export const SEO_CTR_FAMILIES = [
  {
    id: 'articoli-frontaliere',
    label: 'Articoli (blog)',
    pathContains: '/articoli-frontaliere/',
    targetCtr: 0.03,
    monitored: true,
  },
  {
    id: 'guida-frontaliere',
    label: 'Guida frontaliere',
    pathContains: '/guida-frontaliere/',
    targetCtr: 0.035,
    monitored: true,
  },
  {
    id: 'tasse-e-pensione',
    label: 'Tasse e pensione',
    pathContains: '/tasse-e-pensione/',
    targetCtr: 0.03,
    monitored: true,
  },
  {
    id: 'de',
    label: 'DE locale (riferimento)',
    pathContains: '/de/',
    targetCtr: null,
    monitored: false,
  },
  {
    id: 'cerca-lavoro-ticino',
    label: 'Cerca lavoro Ticino (riferimento)',
    pathContains: '/cerca-lavoro-ticino/',
    targetCtr: null,
    monitored: false,
  },
];

/**
 * Aggregate a list of GSC page rows ({clicks, impressions, ctr, position})
 * into family-level weighted metrics + a below-curve-page breakdown.
 * `underperformRatio` (default 0.6) flags pages whose actual CTR is below
 * that fraction of the position-expected CTR.
 */
export function aggregateFamilyRows(rows, { underperformRatio = 0.6, minImpressions = 20 } = {}) {
  const eligible = rows.filter((r) => Number(r.impressions || 0) >= minImpressions);
  const totalClicks = eligible.reduce((sum, r) => sum + Number(r.clicks || 0), 0);
  const totalImpressions = eligible.reduce((sum, r) => sum + Number(r.impressions || 0), 0);
  const weightedPositionSum = eligible.reduce((sum, r) => sum + Number(r.position || 0) * Number(r.impressions || 0), 0);
  const weightedPosition = totalImpressions > 0
    ? weightedAveragePosition(weightedPositionSum, totalImpressions)
    : null;
  const avgCtr = totalImpressions > 0 ? computeCtr(totalClicks, totalImpressions) : null;

  const belowCurve = eligible
    .map((r) => ({
      ...r,
      expectedCtr: expectedCtrForPosition(r.position),
      gapRatio: ctrGapRatio(r.ctr, r.position),
    }))
    .filter((r) => r.gapRatio !== null && r.gapRatio < underperformRatio)
    .sort((a, b) => Number(b.impressions || 0) - Number(a.impressions || 0));

  return {
    pageCount: eligible.length,
    totalClicks,
    totalImpressions,
    avgCtr,
    avgPosition: weightedPosition,
    belowCurveCount: belowCurve.length,
    belowCurvePages: belowCurve,
  };
}
