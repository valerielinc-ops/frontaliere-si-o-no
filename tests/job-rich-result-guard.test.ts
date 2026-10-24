// @vitest-environment node
/**
 * Anti-regression rules for job rich results. The fixtures replay the real
 * October 2026 outage shape (JobPosting not emitted 4-22/10) so the rule is
 * pinned to the event it exists to catch.
 */
import { describe, expect, it } from 'vitest';
import {
  hasJobPostingRichResult,
  pickEvaluationDay,
  evaluateWeekdayDrop,
  evaluateRichShare,
  seededSample,
  SETTLE_DAYS,
} from '../scripts/lib/job-rich-result-guard.mjs';

const series = (start: string, clicks: number[]) =>
  clicks.map((c, i) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), clicks: c }));

describe('hasJobPostingRichResult', () => {
  it('needs a Job Postings item: Breadcrumbs alone also report verdict PASS', () => {
    expect(hasJobPostingRichResult({ verdict: 'PASS', detectedItems: [{ richResultType: 'Breadcrumbs', items: [{}] }] })).toBe(false);
    expect(hasJobPostingRichResult({ verdict: 'PASS', detectedItems: [
      { richResultType: 'Breadcrumbs', items: [{}] },
      { richResultType: 'Job Postings', items: [{ name: 'Operatore' }] },
    ] })).toBe(true);
    expect(hasJobPostingRichResult(undefined)).toBe(false);
  });
});

describe('evaluateWeekdayDrop', () => {
  // Five weeks of a stable weekly shape, then the outage week at ~half.
  const week = [1800, 1700, 1550, 1500, 1150, 780, 1100];
  const s = series('2026-09-07', [...week, ...week, ...week, ...week, 900, 850, 780, 750, 580, 390, 550]);

  it('alerts when the day is >30% under the same-weekday median of the 4 previous weeks', () => {
    const r = evaluateWeekdayDrop(s, { day: '2026-10-05' });
    expect(r.baseline).toBe(1800);
    expect(r.drop).toBeCloseTo(0.5, 2);
    expect(r.alert).toBe(true);
  });

  it('does not alert on the normal weekend dip (that is why it compares weekdays)', () => {
    const r = evaluateWeekdayDrop(s, { day: '2026-10-03' }); // a Saturday of the stable weeks
    expect(r.alert).toBe(false);
  });

  it('refuses to judge without 4 weeks of history', () => {
    expect(evaluateWeekdayDrop(s, { day: '2026-09-20' })).toMatchObject({ alert: false, reason: 'insufficient-history' });
  });

  it('a missing baseline day counts as zero clicks, a zero baseline cannot alert', () => {
    const sparse = [{ date: '2026-09-01', clicks: 0 }, { date: '2026-09-29', clicks: 0 }];
    expect(evaluateWeekdayDrop(sparse, { day: '2026-09-29' })).toMatchObject({ alert: false, reason: 'zero-baseline' });
  });
});

describe('pickEvaluationDay', () => {
  it(`skips the last ${SETTLE_DAYS} days of fresh data`, () => {
    const s = series('2026-10-15', [1, 1, 1, 1, 1, 1, 1, 1, 1]); // 15..23
    expect(pickEvaluationDay(s, '2026-10-24')).toBe('2026-10-21');
    expect(pickEvaluationDay([], '2026-10-24')).toBeNull();
  });

  it('evaluates the settled calendar day even when Search Console omitted its zero-click row', () => {
    expect(pickEvaluationDay([{ date: '2026-10-20', clicks: 10 }], '2026-10-24')).toBe('2026-10-21');
  });
});

describe('evaluateRichShare', () => {
  const row = (liveJob: boolean, hasJobs: boolean, inspected = true) => ({ liveJob, hasJobs, inspected });
  it('counts only live, inspected job pages and alerts under 80%', () => {
    const rows = [...Array(20).fill(row(true, true)), ...Array(7).fill(row(true, false)), row(false, false), row(true, false, false)];
    expect(evaluateRichShare(rows)).toMatchObject({ eligible: 27, withJobs: 20, alert: true, reason: 'below-threshold' });
  });
  it('stays quiet at or above 80% and on a too-small sample', () => {
    expect(evaluateRichShare([...Array(8).fill(row(true, true)), ...Array(2).fill(row(true, false))]).alert).toBe(false);
    expect(evaluateRichShare(Array(5).fill(row(true, false)))).toMatchObject({ alert: false, reason: 'small-sample' });
  });
});

describe('seededSample', () => {
  it('is deterministic per seed, distinct items, bounded by the list', () => {
    const list = Array.from({ length: 100 }, (_, i) => i);
    const a = seededSample(list, 15, '2026-10-24');
    expect(a).toEqual(seededSample(list, 15, '2026-10-24'));
    expect(new Set(a).size).toBe(15);
    expect(a).not.toEqual(seededSample(list, 15, '2026-10-25'));
    expect(seededSample([1, 2], 15, 'x')).toHaveLength(2);
  });
});
