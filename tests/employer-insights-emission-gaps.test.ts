import { describe, expect, it } from 'vitest';
import {
  emissionGapDays,
  emissionGapWindow,
  summarizeEmissionGapDay,
} from '../scripts/employer-insights-emission-gaps.mjs';

describe('employer-insights-emission-gaps (read-only D18 measure)', () => {
  it('lists every day of an inclusive range and rejects malformed bounds', () => {
    expect(emissionGapDays('2026-09-30', '2026-10-02')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(emissionGapDays('2026-10-02', '2026-10-02')).toEqual(['2026-10-02']);
    expect(() => emissionGapDays('2026-10-03', '2026-10-02')).toThrow();
    expect(() => emissionGapDays('yesterday', '2026-10-02')).toThrow();
  });

  it('reads a past day from the settled report and today live up to now', () => {
    const now = new Date('2026-10-04T06:30:00.000Z');
    expect(emissionGapWindow('2026-10-03', now)).toEqual({
      live: false,
      window: { from: '2026-10-03T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', timezone: 'UTC', inclusive: '[from,to)' },
    });
    expect(emissionGapWindow('2026-10-04', now)).toEqual({
      live: true,
      window: { from: '2026-10-04T00:00:00.000Z', to: '2026-10-04T06:30:00.000Z', timezone: 'UTC', inclusive: '[from,to)' },
    });
  });

  it('counts only the requested day and lists the rows without emission_id', () => {
    const rows = [
      { timestamp: '2026-10-03T00:00:00.000Z', event: 'page_view', path: '/job-a/', observed: 4, emissionId: 'id-a' },
      { timestamp: '2026-10-03T00:00:00.000Z', event: 'page_view', path: '/job-b/', observed: 1, emissionId: '' },
      { timestamp: '2026-10-03T00:00:00.000Z', event: 'job_apply', path: '/job-c/', observed: 2, emissionId: '  ' },
      // A neighbouring GA4 day returned by the same query must not leak in.
      { timestamp: '2026-10-04T00:00:00.000Z', event: 'page_view', path: '/job-d/', observed: 9, emissionId: '' },
    ];
    const summary = summarizeEmissionGapDay('2026-10-03', { rows, coverage: { truncated: false } });

    expect(summary.evidenceObserved).toBe(rows[0].observed + rows[1].observed + rows[2].observed);
    expect(summary.missingObserved).toBe(rows[1].observed + rows[2].observed);
    expect(summary.truncated).toBe(false);
    expect(summary.missing).toEqual([
      { event: 'job_apply', path: '/job-c/', observed: rows[2].observed },
      { event: 'page_view', path: '/job-b/', observed: rows[1].observed },
    ]);
  });

  it('a complete day reports zero missing and keeps the truncation flag', () => {
    const summary = summarizeEmissionGapDay('2026-10-02', {
      rows: [{ timestamp: '2026-10-02T00:00:00.000Z', event: 'page_view', path: '/job-a/', observed: 3, emissionId: 'id-a' }],
      coverage: { truncated: true },
    });
    expect(summary.missingObserved).toBe(0);
    expect(summary.missing).toEqual([]);
    expect(summary.truncated).toBe(true);
  });
});
