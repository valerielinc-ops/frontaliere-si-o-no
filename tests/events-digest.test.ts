/**
 * Guard for the time-window event digests (weekend / this week) — chained
 * feature on #2963. Pins the date-window filters so a calendar boundary or a
 * multi-day event can't silently drop the digest contents.
 */
import { describe, it, expect } from 'vitest';
import { DIGESTS } from '../build-plugins/eventsSeoPagesPlugin';

const weekend = DIGESTS.find((d) => d.key === 'weekend')!;
const week = DIGESTS.find((d) => d.key === 'week')!;

type Ev = { id: string; startDate: string; endDate?: string };
const ev = (id: string, startDate: string, endDate?: string): Ev => ({ id, startDate, endDate });


describe('weekend digest filter', () => {
  // 2026-07-01 is a Wednesday → upcoming weekend is Sat 2026-07-04 + Sun 2026-07-05.
  const ctx = { todayIso: '2026-07-01' };

  it('includes events on Saturday or Sunday only', () => {
    const events = [
      ev('fri', '2026-07-03'),
      ev('sat', '2026-07-04'),
      ev('sun', '2026-07-05'),
      ev('mon', '2026-07-06'),
    ];
    const ids = (weekend.filter as any)(events, ctx).map((e: Ev) => e.id);
    expect(ids).toContain('sat');
    expect(ids).toContain('sun');
    expect(ids).not.toContain('fri');
    expect(ids).not.toContain('mon');
  });

  it('includes a multi-day event that spans the weekend', () => {
    const events = [ev('expo', '2026-07-01', '2026-07-10')];
    expect((weekend.filter as any)(events, ctx)).toHaveLength(1);
  });

  // Regression: when the build runs ON a Saturday/Sunday, the window must stay a
  // single contiguous weekend (not min..max of an 8-day scan that also grabs the
  // NEXT Saturday → spanning the whole week under a "sab e dom" title).
  it('on a Saturday build, excludes next-week weekday events', () => {
    const sat = { todayIso: '2026-07-04' }; // Saturday
    const events = [
      ev('sat', '2026-07-04'),
      ev('sun', '2026-07-05'),
      ev('nextWed', '2026-07-08'),
      ev('nextSat', '2026-07-11'),
    ];
    const ids = (weekend.filter as any)(events, sat).map((e: Ev) => e.id);
    expect(ids).toEqual(['sat', 'sun']);
    expect(ids).not.toContain('nextWed');
    expect(ids).not.toContain('nextSat');
  });

  it('on a Sunday build, includes only that Sunday (Saturday already past)', () => {
    const sun = { todayIso: '2026-07-05' }; // Sunday
    const events = [
      ev('satPast', '2026-07-04'),
      ev('sun', '2026-07-05'),
      ev('nextWed', '2026-07-08'),
    ];
    const ids = (weekend.filter as any)(events, sun).map((e: Ev) => e.id);
    expect(ids).toEqual(['sun']);
    expect(ids).not.toContain('satPast');
    expect(ids).not.toContain('nextWed');
  });
});

describe('this-week digest filter', () => {
  const ctx = { todayIso: '2026-07-01' };
  it('includes events within the next 7 days and excludes later ones', () => {
    const events = [
      ev('today', '2026-07-01'),
      ev('d7', '2026-07-08'),
      ev('d9', '2026-07-10'),
    ];
    const ids = (week.filter as any)(events, ctx).map((e: Ev) => e.id);
    expect(ids).toContain('today');
    expect(ids).toContain('d7');
    expect(ids).not.toContain('d9');
  });
});

describe('digest slugs are localized and distinct from comune slugs', () => {
  it('has 4 locale slugs per digest', () => {
    for (const d of DIGESTS) {
      for (const loc of ['it', 'en', 'de', 'fr'] as const) {
        expect(d.slug[loc]).toMatch(/^[a-z0-9-]+$/);
      }
    }
    expect(weekend.slug.it).toBe('questo-weekend');
    expect(week.slug.en).toBe('this-week');
  });
});
