import { describe, expect, it } from 'vitest';
import {
  classifyRpm,
  classifyCoverage,
  latestClosedIndex,
  DEFAULT_EARNINGS_FLOOR,
  DEFAULT_COVERAGE_FLOOR,
  COVERAGE_SUSTAIN_DAYS,
} from '../scripts/lib/canaryRpmClassify.mjs';

interface Row {
  date: string;
  rpm: number;
  earnings: number;
  pageViews: number;
  coverage?: number;
}

const mk = (date: string, rpm: number, earnings: number, pageViews: number, coverage?: number): Row => ({
  date,
  rpm,
  earnings,
  pageViews,
  ...(coverage === undefined ? {} : { coverage }),
});

// A calm 7-day-ish baseline: ~5 CHF RPM, ~8 CHF/day earnings, ~1600 PV/day.
function baselineDays(): Row[] {
  return [
    mk('2026-06-01', 5.0, 8.0, 1600),
    mk('2026-06-02', 5.1, 8.1, 1588),
    mk('2026-06-03', 4.9, 7.9, 1612),
    mk('2026-06-04', 5.2, 8.2, 1577),
    mk('2026-06-05', 5.0, 8.0, 1600),
    mk('2026-06-06', 4.8, 7.7, 1604),
    mk('2026-06-07', 5.0, 8.0, 1600),
    mk('2026-06-08', 5.1, 8.1, 1588),
    mk('2026-06-09', 5.0, 8.0, 1600),
  ];
}

describe('latestClosedIndex — never measure the still-open current UTC day', () => {
  it('drops the row dated today even when its partial PV beats half of yesterday', () => {
    const spike = [
      mk('2026-06-13', 5.0, 8.0, 1600),
      mk('2026-06-14', 5.0, 8.0, 1600),
      mk('2026-06-15', 1.9, 4.0, 2081), // today, high-traffic morning — partial PV > 50% of prior
    ];
    // Old PV-only heuristic kept this row; the date guard must drop it.
    expect(latestClosedIndex(spike, '2026-06-15')).toBe(1); // → 2026-06-14
  });

  it('keeps the last row when it is genuinely yesterday (date < today)', () => {
    const settled = [
      mk('2026-06-13', 5.0, 8.0, 1600),
      mk('2026-06-14', 5.0, 8.0, 1600),
      mk('2026-06-15', 5.0, 8.0, 1600), // fully-settled yesterday
    ];
    expect(latestClosedIndex(settled, '2026-06-16')).toBe(2); // → 2026-06-15 is closed
  });

  it('still steps back when the closed candidate looks truncated (< 50% of prior PV)', () => {
    const truncated = [
      mk('2026-06-13', 5.0, 8.0, 1600),
      mk('2026-06-14', 5.0, 8.0, 1600),
      mk('2026-06-15', 5.0, 8.0, 600), // < 50% of prior → still settling
    ];
    expect(latestClosedIndex(truncated, '2026-06-16')).toBe(1); // → 2026-06-14
  });
});

describe('classifyRpm — earnings gate distinguishes incidents from PV spikes', () => {
  it('a page-view spike with healthy earnings is benign (no alert, emits a note)', () => {
    // current day: RPM cut by a 2.4× PV spike, but earnings are normal.
    const rows = [
      ...baselineDays(),
      mk('2026-06-10', 5.0, 8.0, 1600),
      mk('2026-06-11', 2.1, 8.0, 3800), // PV spike, earnings unchanged
    ];
    const res = classifyRpm(rows, { todayUtc: '2026-06-12' });
    expect(res.verdict).toBe('healthy');
    expect(res.current?.date).toBe('2026-06-11');
    expect(res.ratio).toBeLessThan(0.65); // RPM signal DID fire
    expect(res.earningsRatio).toBeGreaterThanOrEqual(DEFAULT_EARNINGS_FLOOR); // earnings held
    expect(res.note).toMatch(/benign/i);
    expect(res.reasons).toHaveLength(0);
  });

  it('a real revenue incident (earnings crater) still fires — the 2026-05-28 stub signature', () => {
    // Stubs serve no ads → both RPM and earnings collapse together.
    const rows = [
      ...baselineDays(),
      mk('2026-06-10', 5.0, 8.0, 1600),
      mk('2026-06-11', 1.7, 1.5, 880), // earnings cratered
    ];
    const res = classifyRpm(rows, { todayUtc: '2026-06-12' });
    expect(res.verdict).toBe('regression');
    expect(res.current?.date).toBe('2026-06-11');
    expect(res.earningsRatio).toBeLessThan(DEFAULT_EARNINGS_FLOOR);
    // Reasons must cite BOTH the RPM signal and the earnings confirmation.
    expect(res.reasons.join(' ')).toMatch(/RPM/);
    expect(res.reasons.join(' ')).toMatch(/Earnings/);
  });

  it('the absolute RPM floor alone does not page when earnings are healthy', () => {
    const rows = [
      ...baselineDays(),
      mk('2026-06-10', 5.0, 8.0, 1600),
      mk('2026-06-11', 0.8, 8.0, 10000), // RPM < 1.0 absolute, but earnings normal (huge PV spike)
    ];
    const res = classifyRpm(rows, { todayUtc: '2026-06-12' });
    expect(res.verdict).toBe('healthy');
    expect(res.note).toBeTruthy();
  });
});

// Regression lock for issue #2176 (2026-06-15..17): finalized AdSense rows.
describe('classifyRpm — issue #2176 finalized data', () => {
  const FINALIZED: Row[] = [
    mk('2026-06-04', 6.22, 9.18, 1475),
    mk('2026-06-05', 5.75, 10.24, 1780),
    mk('2026-06-06', 6.21, 6.85, 1102),
    mk('2026-06-07', 7.67, 8.64, 1126),
    mk('2026-06-08', 6.87, 12.39, 1803),
    mk('2026-06-09', 4.73, 9.91, 2094),
    mk('2026-06-10', 4.1, 9.4, 2292),
    mk('2026-06-11', 3.25, 6.66, 2047),
    mk('2026-06-12', 3.82, 6.59, 1725),
    mk('2026-06-13', 5.18, 4.41, 851),
    mk('2026-06-14', 3.23, 4.42, 1367),
    mk('2026-06-15', 1.51, 5.46, 3625), // PV spike, earnings normal
    mk('2026-06-16', 2.24, 5.43, 2424), // PV spike, earnings normal
    mk('2026-06-17', 3.55, 5.68, 1599),
    mk('2026-06-18', 4.09, 1.07, 262), // today, still open
  ];

  it("the jun-17 run's low RPM on jun-16 is a benign PV spike (was a false urgent alert)", () => {
    const res = classifyRpm(FINALIZED.slice(0, 13), { todayUtc: '2026-06-17' });
    expect(res.current?.date).toBe('2026-06-16');
    expect(res.ratio).toBeLessThan(0.65); // the old logic alerted here
    expect(res.verdict).toBe('healthy'); // the earnings gate now suppresses it
    expect(res.note).toMatch(/page-view spike/i);
  });

  it('the current finalized run is healthy (issue resolves)', () => {
    const res = classifyRpm(FINALIZED, { todayUtc: '2026-06-18' });
    expect(res.current?.date).toBe('2026-06-17'); // jun-18 (open) is never measured
    expect(res.verdict).toBe('healthy');
  });

  it('never measures the still-open current day even mid-spike (jun-15 16:00 run)', () => {
    // On 2026-06-15 the canary used to measure jun-15 (a partial, high-PV day).
    const res = classifyRpm(FINALIZED.slice(0, 12), { todayUtc: '2026-06-15' });
    expect(res.current?.date).toBe('2026-06-14'); // closed day, not today
  });
});

describe('classifyRpm — insufficient data', () => {
  it('returns insufficient-data below the minimum window', () => {
    const res = classifyRpm(baselineDays().slice(0, 5), { todayUtc: '2026-06-06' });
    expect(res.verdict).toBe('insufficient-data');
  });
});

// classifyCoverage — the issue #4610 fix: a fixed-floor check that does NOT
// use a moving baseline, so it keeps firing on a sustained degradation even
// after the RPM/earnings ratio gate's own trailing 7-day baseline has
// adapted to the bad level and stopped seeing any contrast.
describe('classifyCoverage', () => {
  const healthyRows = (): Row[] =>
    Array.from({ length: 10 }, (_, i) => mk(`2026-08-${String(i + 1).padStart(2, '0')}`, 3.5, 10, 3000, 0.6));

  it('is healthy when the trailing window average is above the floor', () => {
    const res = classifyCoverage(healthyRows(), { todayUtc: '2026-08-11' });
    expect(res.verdict).toBe('healthy');
    expect(res.avgCoverage).toBeCloseTo(0.6, 3);
  });

  it('fires coverage-regression when the trailing window average is below the floor', () => {
    const rows = healthyRows();
    // Last 3 closed days (08-08..08-10) degrade; 08-11 is still-open "today".
    rows[7] = mk('2026-08-08', 3.5, 10, 3000, 0.2);
    rows[8] = mk('2026-08-09', 3.5, 10, 3000, 0.19);
    rows[9] = mk('2026-08-10', 3.5, 10, 3000, 0.21);
    const res = classifyCoverage(rows, { todayUtc: '2026-08-11' });
    expect(res.verdict).toBe('coverage-regression');
    expect(res.avgCoverage).toBeCloseTo(0.2, 2);
    expect(res.window).toEqual({ from: '2026-08-08', to: '2026-08-10', days: COVERAGE_SUSTAIN_DAYS });
    expect(res.reasons?.[0]).toMatch(/AD_REQUESTS_COVERAGE averaged 20%/);
    expect(res.reasons?.[0]).toMatch(/#4610/);
  });

  it('does NOT fire on a single bad day mixed with healthy days (not "sustained")', () => {
    const rows = healthyRows();
    rows[9] = mk('2026-08-10', 3.5, 10, 3000, 0.05); // one very bad day
    const res = classifyCoverage(rows, { todayUtc: '2026-08-11' });
    // Window is the last 3 closed days: 08-08 (0.6), 08-09 (0.6), 08-10 (0.05)
    // — average ≈ 0.417, still below the 0.45 default floor here, so use an
    // explicit lower floor to isolate the "one bad day, otherwise healthy"
    // case from the default-floor threshold.
    const lenient = classifyCoverage(rows, { todayUtc: '2026-08-11', coverageFloor: 0.3 });
    expect(lenient.verdict).toBe('healthy');
    expect(res.avgCoverage).toBeGreaterThan(0.3);
  });

  it('never measures the still-open current UTC day', () => {
    const rows = healthyRows();
    rows[9] = mk('2026-08-10', 3.5, 10, 3000, 0.01); // today, still open, terrible partial coverage
    const res = classifyCoverage(rows, { todayUtc: '2026-08-10' });
    expect(res.window?.to).toBe('2026-08-09');
    expect(res.verdict).toBe('healthy'); // today's 0.01 must not be counted
  });

  it('returns insufficient-data with fewer than sustainDays fully-closed rows', () => {
    const res = classifyCoverage([mk('2026-08-01', 3.5, 10, 3000, 0.6), mk('2026-08-02', 3.5, 10, 3000, 0.6)], {
      todayUtc: '2026-08-03',
    });
    expect(res.verdict).toBe('insufficient-data');
  });

  it('returns insufficient-data when coverage is missing for a day inside the window', () => {
    const rows = healthyRows();
    rows[8] = mk('2026-08-09', 3.5, 10, 3000); // no coverage field → NaN
    const res = classifyCoverage(rows, { todayUtc: '2026-08-11' });
    expect(res.verdict).toBe('insufficient-data');
  });

  it('respects a custom coverageFloor / sustainDays', () => {
    const rows = healthyRows().map((r) => ({ ...r, coverage: 0.5 }));
    const res = classifyCoverage(rows, { todayUtc: '2026-08-11', coverageFloor: 0.55, sustainDays: 2 });
    expect(res.verdict).toBe('coverage-regression');
    expect(res.window?.days).toBe(2);
  });

  it('exports the documented defaults', () => {
    expect(DEFAULT_COVERAGE_FLOOR).toBe(0.45);
    expect(COVERAGE_SUSTAIN_DAYS).toBe(3);
  });
});

// Regression lock for issue #4610: a degradation that lasts long enough to
// drag the RPM/earnings ratio gate's OWN 7-day baseline down with it makes
// that gate blind (ratio ≈ 1, nothing looks acute) — exactly what happened
// after 2026-07-20. classifyCoverage must still catch it because its floor
// is fixed, not derived from the same degraded window.
describe('regression lock — issue #4610 (baseline has adapted to the degradation)', () => {
  it('classifyRpm goes healthy on a flat-but-degraded 12-day run while classifyCoverage still fires', () => {
    // Every day — baseline AND current — sits at the SAME degraded level:
    // RPM/earnings never move relative to each other (ratio ≈ 1), but
    // AD_REQUESTS_COVERAGE stays pinned at 20%, far under the 45% floor.
    const rows: Row[] = Array.from({ length: 12 }, (_, i) =>
      mk(`2026-08-${String(i + 1).padStart(2, '0')}`, 1.0, 2.0, 2000, 0.2),
    );
    const rpmResult = classifyRpm(rows, { todayUtc: '2026-08-13' });
    const coverageResult = classifyCoverage(rows, { todayUtc: '2026-08-13' });

    expect(rpmResult.verdict).toBe('healthy'); // the blind spot: baseline == current
    expect(coverageResult.verdict).toBe('coverage-regression'); // the fix: fixed floor still fires
  });
});
