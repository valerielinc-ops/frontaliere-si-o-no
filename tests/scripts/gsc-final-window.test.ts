import { describe, expect, it } from 'vitest';
import {
  assessGscFinalWindow,
  normalizeGscFirstIncompleteDate,
  selectLatestGscFinalWindow,
} from '../../scripts/lib/gsc-final-window.mjs';

const dates = () => {
  const start = Date.parse('2026-09-30T00:00:00Z');
  return Array.from({ length: 21 }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
};

describe('GSC final seven-day window selection', () => {
  it('normalizes protobuf camelCase and legacy snake_case metadata, failing closed on conflicts', () => {
    expect(normalizeGscFirstIncompleteDate({ firstIncompleteDate: '2026-10-18' }))
      .toEqual({ firstIncompleteDate: '2026-10-18', error: null });
    expect(normalizeGscFirstIncompleteDate({ first_incomplete_date: '2026-10-18' }))
      .toEqual({ firstIncompleteDate: '2026-10-18', error: null });
    expect(normalizeGscFirstIncompleteDate({ firstIncompleteDate: '2026-10-18', first_incomplete_date: '2026-10-18' }))
      .toEqual({ firstIncompleteDate: '2026-10-18', error: null });
    expect(normalizeGscFirstIncompleteDate({ firstIncompleteDate: '2026-10-18', first_incomplete_date: '2026-10-19' }).error)
      .toContain('conflicting');
    expect(normalizeGscFirstIncompleteDate({ firstIncompleteDate: 20261018 }).error)
      .toContain('malformed');
  });

  it('requires every date in the current and previous windows when first_incomplete_date is present', () => {
    const availableDates = dates();
    const selected = selectLatestGscFinalWindow({
      today: '2026-10-20',
      availableDates,
      firstIncompleteDate: '2026-10-19',
    });
    expect(selected).toMatchObject({
      status: 'measurable',
      window: { start: '2026-10-12', end: '2026-10-18' },
      previousWindow: { start: '2026-10-05', end: '2026-10-11' },
      previous: { status: 'measurable' },
    });
  });

  it('ends on the latest returned final date when the nominal trailing date is missing', () => {
    const availableDates = dates().filter((date) => date !== '2026-10-18');
    const selected = selectLatestGscFinalWindow({
      today: '2026-10-20',
      availableDates,
      firstIncompleteDate: '2026-10-19',
    });
    expect(selected).toMatchObject({ status: 'measurable', window: { start: '2026-10-11', end: '2026-10-17' } });
  });

  it('marks an internal gap in the seven-day window unmeasurable', () => {
    const availableDates = dates().filter((date) => date !== '2026-10-15');
    const selected = selectLatestGscFinalWindow({
      today: '2026-10-20',
      availableDates,
      firstIncompleteDate: '2026-10-19',
    });
    expect(selected.status).toBe('unmeasurable');
    expect(selected.missingDates).toEqual(['2026-10-15']);
  });

  it('keeps the current window measurable when only the previous window has a date gap', () => {
    const availableDates = dates().filter((date) => date !== '2026-10-08');
    const selected = selectLatestGscFinalWindow({
      today: '2026-10-20',
      availableDates,
      firstIncompleteDate: '2026-10-19',
    });
    expect(selected.status).toBe('measurable');
    expect(selected.previous).toMatchObject({ status: 'unmeasurable', missingDates: ['2026-10-08'] });
  });

  it('accepts a complete all/date probe without first_incomplete_date per the GSC response contract', () => {
    const selected = selectLatestGscFinalWindow({ today: '2026-10-20', availableDates: dates() });
    expect(selected).toMatchObject({
      status: 'measurable',
      firstIncompleteDate: null,
      window: { start: '2026-10-14', end: '2026-10-20' },
      previous: { status: 'measurable' },
    });
  });

  it('selects the latest complete seven-day window when trailing dates are absent and metadata is omitted', () => {
    const availableDates = dates().filter((date) => date <= '2026-10-17');
    const selected = selectLatestGscFinalWindow({ today: '2026-10-20', availableDates });
    expect(selected).toMatchObject({ status: 'measurable', window: { start: '2026-10-11', end: '2026-10-17' } });
  });

  it('keeps historical all/date settlement readable when metadata is absent but all requested dates exist', () => {
    expect(assessGscFinalWindow(
      { start: '2026-09-01', end: '2026-09-07' },
      { availableDates: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'] },
    ).complete).toBe(true);
  });
});
