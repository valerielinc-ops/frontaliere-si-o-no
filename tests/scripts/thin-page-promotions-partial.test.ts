import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGscPageImpressions } from '../../scripts/lib/evidence/gscFetcher.mjs';
import { fetchGscImpressions, rollupActive } from '../../scripts/fetch-thin-page-promotions.mjs';

vi.mock('../../scripts/lib/evidence/gscFetcher.mjs', () => ({ fetchGscPageImpressions: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('thin promotions with incomplete coverage', () => {
  it('retains GSC observations and its error instead of dropping the partial page set', async () => {
    vi.mocked(fetchGscPageImpressions).mockResolvedValue({
      pages: { '/observed-page/': 6 }, error: 'page: pagination incomplete',
    });
    const result = await fetchGscImpressions(24);
    expect([...result.urls]).toEqual(['/observed-page']);
    expect(result.error).toBe('page: pagination incomplete');
  });

  it('preserves prior promotions on an incomplete refresh, then expires them after a complete one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const prev = { urls: ['/old', '/legacy'], _seenAt: { '/old': '2026-08-01' } };
    const partial = rollupActive(prev, new Set(['/observed']), 30, false);
    expect(partial.urls).toEqual(['/legacy', '/observed', '/old']);
    expect(partial.seenAt).toEqual({ '/old': '2026-08-01', '/observed': '2026-10-01' });

    const complete = rollupActive({ urls: partial.urls, _seenAt: partial.seenAt }, new Set(), 30, true);
    expect(complete.urls).toEqual(['/observed']);
    expect(complete.seenAt).toEqual({ '/observed': '2026-10-01' });
  });

  it('updates a previously observed URL without falsely refreshing unobserved records', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const result = rollupActive({
      urls: ['/old', '/seen-again'],
      _seenAt: { '/old': '2026-08-01', '/seen-again': '2026-08-02' },
    }, new Set(['/seen-again']), 30, false);
    expect(result.seenAt).toEqual({ '/old': '2026-08-01', '/seen-again': '2026-10-01' });
  });
});
