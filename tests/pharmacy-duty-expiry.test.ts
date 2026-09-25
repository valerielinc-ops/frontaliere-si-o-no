import { describe, expect, it } from 'vitest';
import {
  latestVerifiedDutyTransition,
  markStaticDutyRefresh,
  needsStaticDutyRefresh,
} from '../scripts/refresh-pharmacy-duty-expiry.mjs';

const DUTIES = [
  { startsAt: '2026-09-14T08:00:00.000Z', endsAt: '2026-09-14T12:00:00.000Z', status: 'verified' },
  { startsAt: '2026-09-14T12:00:00.000Z', endsAt: '2026-09-14T20:00:00.000Z', status: 'verified' },
  { startsAt: '2026-09-13T08:00:00.000Z', endsAt: '2026-09-13T12:00:00.000Z', status: 'expired' },
];

describe('pharmacy duty static expiry refresh', () => {
  it('tracks the latest crossed boundary without considering expired records', () => {
    expect(latestVerifiedDutyTransition(DUTIES, new Date('2026-09-14T12:15:00.000Z')))
      .toBe('2026-09-14T12:00:00.000Z');
  });

  it('requests one rebuild per new verified transition', () => {
    const dataset = { duties: DUTIES };
    expect(needsStaticDutyRefresh(dataset, {}, new Date('2026-09-14T12:15:00.000Z'))).toBe(true);
    const status = markStaticDutyRefresh({}, '2026-09-14T12:00:00.000Z', new Date('2026-09-14T12:15:00.000Z'));
    expect(needsStaticDutyRefresh(dataset, status, new Date('2026-09-14T12:30:00.000Z'))).toBe(false);
    expect(needsStaticDutyRefresh(dataset, status, new Date('2026-09-14T20:15:00.000Z'))).toBe(true);
  });

  it('keeps non-verified intervals out of the expiry trigger', () => {
    expect(latestVerifiedDutyTransition([
      { startsAt: '2026-09-14T08:00:00.000Z', endsAt: '2026-09-14T12:00:00.000Z', status: 'pending_review' },
      { startsAt: '2026-09-14T12:00:00.000Z', endsAt: '2026-09-14T20:00:00.000Z', status: 'conflicting' },
    ], new Date('2026-09-14T20:15:00.000Z'))).toBeNull();
  });
});
