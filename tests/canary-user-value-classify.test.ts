import { describe, expect, it } from 'vitest';
import {
  classifyArpu,
  latestClosedIndex,
  DEFAULT_REVENUE_FLOOR,
} from '../scripts/lib/arpuCanaryClassify.mjs';

interface Row {
  date: string;
  arpu: number;
  revenue: number;
  activeUsers: number;
}

const mk = (date: string, arpu: number, revenue: number, activeUsers: number): Row => ({
  date,
  arpu,
  revenue,
  activeUsers,
});

// A calm 7-day-ish baseline: ~€0.0070 ARPU, ~€8/day revenue, ~1150 active users/day.
function baselineDays(): Row[] {
  return [
    mk('2026-06-01', 0.0070, 8.05, 1150),
    mk('2026-06-02', 0.0069, 8.10, 1174),
    mk('2026-06-03', 0.0071, 7.95, 1120),
    mk('2026-06-04', 0.0072, 8.20, 1139),
    mk('2026-06-05', 0.0070, 8.00, 1143),
    mk('2026-06-06', 0.0068, 7.70, 1132),
    mk('2026-06-07', 0.0070, 8.00, 1143),
    mk('2026-06-08', 0.0069, 8.10, 1174),
    mk('2026-06-09', 0.0070, 8.00, 1143),
  ];
}

describe('latestClosedIndex — never measure the still-open current UTC day', () => {
  it('drops the row dated today even when its partial users count beats half of yesterday', () => {
    const spike = [
      mk('2026-06-13', 0.0070, 8.0, 1143),
      mk('2026-06-14', 0.0070, 8.0, 1143),
      mk('2026-06-15', 0.0027, 4.0, 1481), // today, high-traffic morning — partial users > 50% of prior
    ];
    expect(latestClosedIndex(spike, '2026-06-15')).toBe(1); // → 2026-06-14
  });

  it('keeps the last row when it is genuinely yesterday (date < today)', () => {
    const settled = [
      mk('2026-06-13', 0.0070, 8.0, 1143),
      mk('2026-06-14', 0.0070, 8.0, 1143),
      mk('2026-06-15', 0.0070, 8.0, 1143),
    ];
    expect(latestClosedIndex(settled, '2026-06-16')).toBe(2); // → 2026-06-15 is closed
  });
});

describe('classifyArpu — revenue gate distinguishes incidents from active-user spikes', () => {
  it('an active-user spike with healthy revenue is benign (no alert, emits a note)', () => {
    // current day: ARPU cut by a ~2.4x active-user spike, but revenue is normal.
    const rows = [
      ...baselineDays(),
      mk('2026-06-10', 0.0070, 8.0, 1143),
      mk('2026-06-11', 0.0029, 8.0, 2743), // user spike, revenue unchanged
    ];
    const res = classifyArpu(rows, { todayUtc: '2026-06-12' });
    expect(res.verdict).toBe('healthy');
    expect(res.current?.date).toBe('2026-06-11');
    expect(res.ratio).toBeLessThan(0.65); // ARPU signal DID fire
    expect(res.revenueRatio).toBeGreaterThanOrEqual(DEFAULT_REVENUE_FLOOR); // revenue held
    expect(res.note).toMatch(/benign/i);
    expect(res.reasons).toHaveLength(0);
  });

  it('a real revenue incident (revenue craters) still fires', () => {
    const rows = [
      ...baselineDays(),
      mk('2026-06-10', 0.0070, 8.0, 1143),
      mk('2026-06-11', 0.0017, 1.5, 882), // revenue cratered alongside ARPU
    ];
    const res = classifyArpu(rows, { todayUtc: '2026-06-12' });
    expect(res.verdict).toBe('regression');
    expect(res.current?.date).toBe('2026-06-11');
    expect(res.revenueRatio).toBeLessThan(DEFAULT_REVENUE_FLOOR);
    expect(res.reasons.join(' ')).toMatch(/ARPU/);
    expect(res.reasons.join(' ')).toMatch(/Revenue/);
  });
});

describe('classifyArpu — insufficient data', () => {
  it('returns insufficient-data below the minimum window', () => {
    const res = classifyArpu(baselineDays().slice(0, 5), { todayUtc: '2026-06-06' });
    expect(res.verdict).toBe('insufficient-data');
  });
});
