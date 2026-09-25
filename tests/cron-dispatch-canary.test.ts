import { describe, expect, it } from 'vitest';
import {
  parseSlot,
  computeNominalInstant,
  computeDispatchDelayMinutes,
  minutesIntoUtcDay,
  buildRecord,
  SUSPECT_DELAY_MINUTES,
} from '../scripts/ci/probe-cron-dispatch-delay.mjs';
import {
  deferralShare,
  summarizeBySlot,
  pairedComparison,
  quantile,
  extractFixedHourCrons,
  renderHistoryReport,
} from '../scripts/ci/audit-cron-dispatch-delay.mjs';

// #3798 Fase 1 follow-up. The canary exists because the 2026-08-05 audit could
// not measure the 23:00 UTC slot (no workflow is scheduled there). Its whole
// value is that the number arrives on its own; these tests protect the two
// places where a silent sign error would make that number worse than useless.

describe('parseSlot', () => {
  it('parses HH:MM', () => {
    expect(parseSlot('23:17')).toEqual({ hour: 23, minute: 17 });
    expect(parseSlot('00:33')).toEqual({ hour: 0, minute: 33 });
  });

  it('rejects malformed or out-of-range input rather than recording nonsense', () => {
    expect(() => parseSlot('2317')).toThrow(/HH:MM/);
    expect(() => parseSlot('')).toThrow(/HH:MM/);
    expect(() => parseSlot('24:00')).toThrow(/out of range/);
    expect(() => parseSlot('23:60')).toThrow(/out of range/);
  });
});

describe('computeNominalInstant — the midnight-wrap that this canary lives on', () => {
  it('THE regression: a 23:17 slot dispatched after midnight belongs to the PREVIOUS day', () => {
    // This is the normal case for the candidate slot — the whole hypothesis is
    // that 23:17 fires around 00:15. Building the candidate from the run's own
    // calendar date would yield a nominal instant in the FUTURE, a negative
    // delay clamped to 0, and a canary that reports its candidate as perfectly
    // punctual no matter how late it actually was.
    const created = new Date('2026-08-07T00:15:00.000Z');
    const nominal = computeNominalInstant(created, { hour: 23, minute: 17 });
    expect(nominal.toISOString()).toBe('2026-08-06T23:17:00.000Z');
    expect(computeDispatchDelayMinutes(created, nominal)).toBe(58);
  });

  it('same-day slot resolves to the same day', () => {
    const created = new Date('2026-08-06T04:33:00.000Z');
    const nominal = computeNominalInstant(created, { hour: 0, minute: 33 });
    expect(nominal.toISOString()).toBe('2026-08-06T00:33:00.000Z');
    expect(computeDispatchDelayMinutes(created, nominal)).toBe(240);
  });

  it('a run dispatched exactly on the minute has zero delay, not a day of it', () => {
    const created = new Date('2026-08-06T23:17:00.000Z');
    expect(computeNominalInstant(created, { hour: 23, minute: 17 }).toISOString()).toBe(created.toISOString());
    expect(computeDispatchDelayMinutes(created, created)).toBe(0);
  });

  it('never returns a nominal instant after the run was created', () => {
    for (const iso of ['2026-08-06T00:00:30.000Z', '2026-08-06T12:00:00.000Z', '2026-08-06T23:59:59.000Z']) {
      const created = new Date(iso);
      for (const slot of [{ hour: 23, minute: 17 }, { hour: 0, minute: 33 }]) {
        expect(computeNominalInstant(created, slot).getTime()).toBeLessThanOrEqual(created.getTime());
      }
    }
  });
});

describe('minutesIntoUtcDay — the decision metric', () => {
  it('measures position in the UTC day, so an early start scores low', () => {
    expect(minutesIntoUtcDay(new Date('2026-08-06T00:15:00.000Z'))).toBe(15);
    expect(minutesIntoUtcDay(new Date('2026-08-06T04:33:00.000Z'))).toBe(273);
    expect(minutesIntoUtcDay(new Date('2026-08-06T16:25:00.000Z'))).toBe(985);
  });
});

describe('buildRecord', () => {
  const base = {
    slotRaw: '23:17',
    createdAt: new Date('2026-08-07T00:15:00.000Z'),
    runStartedAt: new Date('2026-08-07T00:15:02.000Z'),
    runId: 42,
    workflow: 'Cron Dispatch Canary',
    repo: 'o/r',
    now: new Date('2026-08-07T00:16:00.000Z'),
  };

  it('records delay, effective start and post-dispatch queue separately', () => {
    const r = buildRecord(base);
    expect(r.slot).toBe('23:17');
    expect(r.nominal_at).toBe('2026-08-06T23:17:00.000Z');
    expect(r.dispatch_delay_minutes).toBe(58);
    expect(r.effective_start_utc).toBe('00:15');
    expect(r.effective_start_minute_of_utc_day).toBeCloseTo(15.03, 1);
    // Kept apart from the dispatch figure so the day post-dispatch queueing
    // stops being ~0 is visible in the data instead of being folded in.
    expect(r.post_dispatch_queue_seconds).toBe(2);
    expect(r.suspect).toBe(false);
  });

  it('flags an implausible delay as suspect instead of dropping it', () => {
    // A skipped occurrence attributes the run to a much older slot. Keeping it
    // visible matters: a slot that starts SKIPPING is itself a reason not to
    // move a production send onto it.
    const r = buildRecord({ ...base, createdAt: new Date('2026-08-07T13:00:00.000Z'), runStartedAt: null });
    expect(r.dispatch_delay_minutes).toBeGreaterThan(SUSPECT_DELAY_MINUTES);
    expect(r.suspect).toBe(true);
  });

  it('falls back to created_at when run_started_at is absent', () => {
    const r = buildRecord({ ...base, runStartedAt: null });
    expect(r.run_started_at).toBe(base.createdAt.toISOString());
    expect(r.post_dispatch_queue_seconds).toBe(0);
  });

  it('pads a single-digit hour so slots sort and group as strings', () => {
    expect(buildRecord({ ...base, slotRaw: '0:33' }).slot).toBe('00:33');
  });
});

describe('deferralShare — why early beats punctual', () => {
  it('rises with the effective start under a uniform distribution', () => {
    expect(deferralShare(15)).toBeCloseTo(0.0104, 3);   // 00:15 → ~1% deferred
    expect(deferralShare(273)).toBeCloseTo(0.1896, 3);  // 04:33 → ~19% deferred
    expect(deferralShare(985)).toBeCloseTo(0.684, 3);   // 16:25 → ~68% deferred
  });

  it('scores against a real preferred-hour histogram when one is supplied', () => {
    // Base concentrated at 06:00 and 18:00 UTC.
    const hist = { 6: 100, 18: 100 };
    expect(deferralShare(15, hist)).toBe(0);      // before both → nobody deferred
    expect(deferralShare(400, hist)).toBe(0.5);   // past 06:00 only → half
    expect(deferralShare(1200, hist)).toBe(1);    // past both → everybody
  });

  it('falls back to uniform on an empty or unusable histogram rather than dividing by zero', () => {
    expect(deferralShare(720, {})).toBeCloseTo(0.5, 3);
    expect(deferralShare(720, { 3: 0 })).toBeCloseTo(0.5, 3);
  });

  it('clamps out-of-range input', () => {
    expect(deferralShare(-50)).toBe(0);
    expect(deferralShare(99999)).toBe(1);
  });
});

describe('summarizeBySlot', () => {
  const rec = (slot: string, startMinute: number, delay: number, suspect = false) => ({
    slot,
    nominal_at: '2026-08-06T23:17:00.000Z',
    dispatch_delay_minutes: delay,
    effective_start_minute_of_utc_day: startMinute,
    suspect,
  });

  it('ranks by earliest median effective start, NOT by smallest delay', () => {
    // The point of the whole exercise: 23:17 drifts more (75m vs 20m) but
    // starts at 00:32 instead of 04:33, so it must rank first.
    const out = summarizeBySlot([
      rec('00:33', 273, 20),
      rec('23:17', 32, 75),
    ]);
    expect(out.map((s) => s.slot)).toEqual(['23:17', '00:33']);
    expect(out[0].deferralShareMedian).toBeLessThan(out[1].deferralShareMedian!);
  });

  it('excludes suspect samples from the stats but still counts them', () => {
    const out = summarizeBySlot([rec('23:17', 32, 75), rec('23:17', 800, 900, true)]);
    expect(out[0].samples).toBe(1);
    expect(out[0].suspect).toBe(1);
    expect(out[0].delayMax).toBe(75);
  });

  it('returns an empty list for no input instead of throwing', () => {
    expect(summarizeBySlot([])).toEqual([]);
  });
});

describe('pairedComparison — cancels day-to-day swings in GitHub backlog', () => {
  const mk = (slot: string, nominalIso: string, startMinute: number, suspect = false) => ({
    slot, nominal_at: nominalIso, effective_start_minute_of_utc_day: startMinute, suspect,
    dispatch_delay_minutes: 1,
  });

  it('pairs a 23:17 run with the 00:33 run that serves the SAME night', () => {
    // Calendar-date pairing would never match these two: they fall on different
    // dates by construction. Both feed the morning of the 7th.
    const records = [
      mk('23:17', '2026-08-06T23:17:00.000Z', 32),
      mk('00:33', '2026-08-07T00:33:00.000Z', 273),
    ];
    const cmp = pairedComparison(records, '23:17', '00:33');
    expect(cmp.pairs).toHaveLength(1);
    expect(cmp.pairs[0].day).toBe('2026-08-07');
    expect(cmp.medianDeltaMinutes).toBe(32 - 273);
    expect(cmp.aWinsShare).toBe(1);
  });

  it('reports no verdict when a night is missing one of the two slots', () => {
    const cmp = pairedComparison([mk('23:17', '2026-08-06T23:17:00.000Z', 32)], '23:17', '00:33');
    expect(cmp.pairs).toHaveLength(0);
    expect(cmp.medianDeltaMinutes).toBeNull();
    expect(cmp.aWinsShare).toBeNull();
  });

  it('ignores suspect samples so a skipped occurrence cannot decide the comparison', () => {
    const records = [
      mk('23:17', '2026-08-06T23:17:00.000Z', 800, true),
      mk('00:33', '2026-08-07T00:33:00.000Z', 273),
    ];
    expect(pairedComparison(records, '23:17', '00:33').pairs).toHaveLength(0);
  });

  it('counts how often the candidate wins, not just the median', () => {
    const records = [
      mk('23:17', '2026-08-06T23:17:00.000Z', 32), mk('00:33', '2026-08-07T00:33:00.000Z', 273),
      mk('23:17', '2026-08-07T23:17:00.000Z', 40), mk('00:33', '2026-08-08T00:33:00.000Z', 30),
    ];
    const cmp = pairedComparison(records, '23:17', '00:33');
    expect(cmp.pairs).toHaveLength(2);
    expect(cmp.aWinsShare).toBe(0.5);
  });
});

describe('quantile / extractFixedHourCrons', () => {
  it('quantile returns null on empty input rather than NaN', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(3);
  });

  it('extracts fixed-hour daily crons and skips wildcard-hour ones', () => {
    const yml = [
      "    - cron: '17 23 * * *'",
      '    - cron: "33 0 * * *"',
      "    - cron: '10 * * * *'",   // hourly — no fixed slot to be late against
      "    - cron: '20 2 * * 1'",   // weekly is still a fixed hour
    ].join('\n');
    expect(extractFixedHourCrons(yml)).toEqual([
      { minute: 17, hour: 23 },
      { minute: 33, hour: 0 },
      { minute: 20, hour: 2 },
    ]);
  });
});

describe('renderHistoryReport', () => {
  it('says plainly that there is no verdict yet when no night has both slots', () => {
    const summaries = summarizeBySlot([
      { slot: '23:17', nominal_at: '2026-08-06T23:17:00.000Z', dispatch_delay_minutes: 58, effective_start_minute_of_utc_day: 15, suspect: false },
    ]);
    const out = renderHistoryReport(summaries, { pairs: [], medianDeltaMinutes: null, aWinsShare: null }, {
      slotA: '23:17', slotB: '00:33', totalRecords: 1, hourHistogram: null,
    });
    expect(out).toContain('no paired days yet');
    expect(out).not.toContain('NaN');
    // The report must keep stating the decision rule, not just the numbers.
    expect(out).toContain('EFFECTIVE START');
    expect(out).toContain('14 paired nights');
  });
});
