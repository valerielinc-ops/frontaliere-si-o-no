/**
 * #9314 — job-alert matching stays under its time budget only if the ranking
 * sort does NOT re-parse `firstSeenAt` inside the comparator.
 *
 * Since #9471 every alert is planned against the recipient's whole catch-up
 * window (production run 36031219916: 2.778 alerts, 57.020.550 candidate
 * rows; run 35959186383: 4.468 alerts, 91.527.504 rows, 10m28s from Capacity
 * check to Total). A CPU profile on the real dataset put ~40% of planning in
 * the comparator's two `new Date(firstSeenAt)` per comparison: O(M log M)
 * parses per alert instead of O(M).
 *
 * Two observers:
 *   1. cost — `firstSeenAt` conversions stay linear in the ranked set
 *      (fails on the pre-fix comparator: thousands of conversions for 240
 *      jobs);
 *   2. order — the ranked order is exactly the one the original comparator
 *      produced, including missing and unparseable timestamps (NaN tiebreak).
 */
import { describe, expect, it } from 'vitest';
import {
  buildAlertProfile,
  createJobFeatureCache,
  freshnessBoost,
  scoreJobForAlert,
} from '../services/jobAlertMatching.mjs';
import { planAlertMatch } from '../scripts/send-job-alerts.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-24T05:00:00Z');

function makeJobs(count: number, firstSeen: (i: number) => unknown) {
  const jobs = [];
  for (let i = 0; i < count; i++) {
    jobs.push({
      id: `job-${i}`,
      slug: `job-${i}`,
      title: `Infermiere reparto ${i}`,
      description: 'Cerchiamo infermiere diplomato.',
      // One company per job: the per-company cap must not reorder anything.
      company: `Azienda ${i}`,
      location: 'Lugano',
      canton: 'TI',
      crawledAt: new Date(NOW - DAY / 2).toISOString(),
      firstSeenAt: firstSeen(i),
    });
  }
  return jobs;
}

function context(recentJobs: unknown[]) {
  return {
    behaviorProfiles: new Map(),
    lastClickedUrlByEmail: new Map(),
    locationIndex: new Map(),
    cityToCanton: new Map([['lugano', 'ti']]),
    subscriberProfiles: new Map(),
    recentJobs,
    now: NOW,
    featureCache: createJobFeatureCache(),
  };
}

// Canton-only alert: every job scores the same, so the whole ranked set goes
// through the firstSeenAt tiebreak — the worst case for the comparator.
const ALERT = { id: 'canton', email: 'c@example.test', locale: 'it', cantonFilter: ['TI'] };

describe('planAlertMatch ranking sort cost (#9314)', () => {
  it('converts firstSeenAt a bounded number of times per job, not per comparison', () => {
    let conversions = 0;
    const M = 240;
    const jobs = makeJobs(M, (i) => {
      // Distinct, deliberately unsorted timestamps outside the freshness boost
      // window, so every pair is decided by the tiebreak.
      const iso = new Date(NOW - (5 + ((i * 37) % M)) * DAY - i * 1000).toISOString();
      return {
        [Symbol.toPrimitive]() {
          conversions++;
          return iso;
        },
      };
    });
    const plan = planAlertMatch(ALERT, context(jobs));
    expect(plan.rankedCount).toBe(M);
    // Linear: freshnessBoost + one tiebreak parse per job (+ slack for any
    // other single read). The pre-fix comparator needs ~2·M·log2(M) ≈ 3.800.
    expect(conversions).toBeLessThanOrEqual(3 * M);
  });

  it('keeps the original comparator order, including missing and unparseable timestamps', () => {
    const jobs = makeJobs(60, (i) => {
      if (i % 11 === 0) return undefined;
      if (i % 13 === 0) return 'not-a-date';
      // Some inside the 24h/48h freshness boost, most outside.
      if (i % 7 === 0) return new Date(NOW - (i % 3) * 20 * 60 * 60 * 1000).toISOString();
      return new Date(NOW - (3 + ((i * 17) % 40)) * DAY).toISOString();
    });
    const plan = planAlertMatch(ALERT, context(jobs));

    // Oracle: the pre-#9314 comparator, verbatim, over the same scored set.
    const profile = buildAlertProfile(ALERT, null, { cityToCanton: new Map([['lugano', 'ti']]) });
    const expected = jobs
      .map((job: any) => {
        const relevance = scoreJobForAlert(job, profile, 'it');
        return { job, score: relevance > 0 ? relevance + freshnessBoost(job, NOW) : 0 };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        const aTime = a.job.firstSeenAt ? new Date(a.job.firstSeenAt).getTime() : 0;
        const bTime = b.job.firstSeenAt ? new Date(b.job.firstSeenAt).getTime() : 0;
        return bTime - aTime;
      })
      .map((m) => m.job.id);

    expect(expected.length).toBe(60);
    expect(plan.matched.map((j: any) => j.id)).toEqual(expected);
  });
});
