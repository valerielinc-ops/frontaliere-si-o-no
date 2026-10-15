/**
 * pickWinner() tie-break determinism (#5954, follow-up of #5950).
 *
 * scripts/reconcile-duplicate-stable-id-jobs.mjs picks a survivor among
 * records sharing the same `.id` by latest `crawledAt`. On an exact
 * `crawledAt` tie the outcome must not depend on the input array's order —
 * that would make which duplicate's slug/history survives non-deterministic
 * across re-runs of the same data.
 */
import { describe, it, expect } from 'vitest';
import { pickWinner } from '../scripts/reconcile-duplicate-stable-id-jobs.mjs';

describe('pickWinner tie-break', () => {
  it('is order-independent when crawledAt ties and previousSlugs counts differ', () => {
    const richer = {
      id: 'job-1',
      url: 'https://example.ch/b',
      crawledAt: '2026-08-10T00:00:00.000Z',
      previousSlugsByLocale: { it: ['old-slug-1', 'old-slug-2'] },
    };
    const leaner = {
      id: 'job-1',
      url: 'https://example.ch/a',
      crawledAt: '2026-08-10T00:00:00.000Z',
      previousSlugsByLocale: { it: ['old-slug-1'] },
    };

    expect(pickWinner([richer, leaner])).toBe(richer);
    expect(pickWinner([leaner, richer])).toBe(richer);
  });

  it('falls back to a url compare when crawledAt AND previousSlugs counts both tie', () => {
    const a = { id: 'job-2', url: 'https://example.ch/a', crawledAt: '2026-08-10T00:00:00.000Z' };
    const b = { id: 'job-2', url: 'https://example.ch/z', crawledAt: '2026-08-10T00:00:00.000Z' };

    expect(pickWinner([a, b])).toBe(a);
    expect(pickWinner([b, a])).toBe(a);
  });

  it('still prefers the strictly later crawledAt regardless of previousSlugs richness', () => {
    const older = {
      id: 'job-3',
      url: 'https://example.ch/a',
      crawledAt: '2026-08-01T00:00:00.000Z',
      previousSlugsByLocale: { it: ['s1', 's2', 's3'] },
    };
    const newer = {
      id: 'job-3',
      url: 'https://example.ch/b',
      crawledAt: '2026-08-10T00:00:00.000Z',
    };

    expect(pickWinner([older, newer])).toBe(newer);
    expect(pickWinner([newer, older])).toBe(newer);
  });
});
