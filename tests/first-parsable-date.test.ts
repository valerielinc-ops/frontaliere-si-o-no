import { describe, expect, it } from 'vitest';
import { firstParsableMs } from '../build-plugins/shared/firstParsableDate';

describe('firstParsableMs', () => {
  it('returns the timestamp of the first parseable value', () => {
    const iso = '2026-06-10T00:00:00Z';
    expect(firstParsableMs(iso)).toBe(new Date(iso).getTime());
  });

  it('falls through a malformed first value to the next parseable one', () => {
    // "30/05/26" (DD/MM/YY) is Invalid Date in V8 → must not win over crawledAt.
    const good = '2026-06-10T00:00:00Z';
    expect(firstParsableMs('30/05/26', good)).toBe(new Date(good).getTime());
  });

  it('skips null/undefined/empty candidates', () => {
    const good = '2026-06-10T00:00:00Z';
    expect(firstParsableMs(null, undefined, '', good)).toBe(new Date(good).getTime());
  });

  it('returns 0 when nothing parses', () => {
    expect(firstParsableMs('30/05/26', 'not-a-date', '', null, undefined)).toBe(0);
    expect(firstParsableMs()).toBe(0);
  });

  it('respects priority order (first parseable wins, even if a later one is newer)', () => {
    const older = '2026-01-01T00:00:00Z';
    const newer = '2026-12-31T00:00:00Z';
    expect(firstParsableMs(older, newer)).toBe(new Date(older).getTime());
  });
});
