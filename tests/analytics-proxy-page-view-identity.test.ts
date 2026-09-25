import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const trackPageView = vi.fn();

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackPageView: (...args: unknown[]) => trackPageView(...args),
  },
  fireCalcEntryIfNeeded: vi.fn(),
}));

const proxySource = readFileSync(resolve(__dirname, '../services/analyticsProxy.ts'), 'utf8');

async function loadProxy() {
  vi.resetModules();
  return vi.importActual<typeof import('@/services/analyticsProxy')>('@/services/analyticsProxy');
}

async function flushForwardedCalls(expected: number): Promise<void> {
  await vi.waitFor(() => expect(trackPageView).toHaveBeenCalledTimes(expected));
}

function stubWindow(): void {
  vi.stubGlobal('window', {
    location: { origin: 'https://example.test', pathname: '/' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

describe('the lazy analytics proxy forwards page-view acts unchanged', () => {
  beforeEach(() => {
    trackPageView.mockClear();
    stubWindow();
  });

  it('does not import or capture an identity from the old History leaf', () => {
    expect(proxySource).not.toContain('pageViewHistoryEntry');
    expect(proxySource).not.toContain('ensureCurrentPageViewHistoryEntryId');
    expect(proxySource).toContain('fn(...args)');
  });

  it('forwards an explicit retry id as the fourth argument', async () => {
    const { Analytics } = await loadProxy();
    const identity = { employerKey: 'example-employer' };
    Analytics.trackPageView('/retry/', 'Retry', identity, 'original-act-id');
    await flushForwardedCalls(1);

    expect(trackPageView.mock.calls[0]).toEqual([
      '/retry/',
      'Retry',
      identity,
      'original-act-id',
    ]);
  });

  it('does not invent a fourth argument when the caller omitted it', async () => {
    const { Analytics } = await loadProxy();
    Analytics.trackPageView('/new-act/', 'New act');
    await flushForwardedCalls(1);

    expect(trackPageView.mock.calls[0]).toEqual(['/new-act/', 'New act']);
  });

  it('forwards null unchanged as dedup unavailable', async () => {
    const { Analytics } = await loadProxy();
    Analytics.trackPageView('/unknown/', undefined, null, null);
    await flushForwardedCalls(1);

    expect(trackPageView.mock.calls[0]).toEqual(['/unknown/', undefined, null, null]);
  });
});
