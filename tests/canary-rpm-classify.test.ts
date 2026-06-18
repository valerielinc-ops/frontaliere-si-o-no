import { describe, expect, it } from 'vitest';
import {
  classifyRpm,
  latestClosedIndex,
  DEFAULT_EARNINGS_FLOOR,
} from '../scripts/lib/canaryRpmClassify.mjs';

interface Row {
  date: string;
  rpm: number;
  earnings: number;
  pageViews: number;
}

const mk = (date: string, rpm: number, earnings: number, pageViews: number): Row => ({
  date,
  rpm,
  earnings,
  pageViews,
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
