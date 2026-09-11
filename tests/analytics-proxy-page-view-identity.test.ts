import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * V6 §1 — the lazy proxy is the single synchronous choke point every
 * `trackPageView` caller goes through, so it is where the page-view identity
 * is bound. It captures the history entry at call time and forwards it as a
 * value; nothing downstream re-derives it from ambient `window.history.state`.
 *
 * Binding it here rather than at each of the ~14 call sites makes the race
 * impossible by construction instead of by discipline: a new caller cannot
 * forget to do it.
 *
 * Distinctness and collapse are proven in tests/page-view-history-entry.test.ts
 * against the capture itself, which is deterministic. Here we prove the proxy
 * forwards what it captured, and that it captures *before* the dynamic import.
 */

const trackPageView = vi.fn();

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackPageView: (...args: unknown[]) => trackPageView(...args),
  },
  fireCalcEntryIfNeeded: vi.fn(),
}));

const proxySource = readFileSync(resolve(__dirname, '../services/analyticsProxy.ts'), 'utf8');

function stubWindow(history: unknown, path: string) {
  vi.stubGlobal('window', {
    location: { origin: 'https://example.test', pathname: path, search: '', hash: '' },
    history,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', { title: path });
}

async function flushForwardedCalls(expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(trackPageView).toHaveBeenCalledTimes(expected);
  });
}

describe('the lazy analytics proxy binds the page-view identity synchronously', () => {
  beforeEach(() => {
    trackPageView.mockClear();
  });

  it('captures the entry before the dynamic import, not inside its .then()', () => {
    // The defect was ordering, so the ordering is the assertion: the capture
    // must be evaluated in the synchronous body of the forwarding function.
    // A capture moved inside `.then()` reads whichever entry is current by
    // then, which is exactly the collapse V6 measured.
    // Measure inside the Proxy body: the module docblock also names
    // `import('@/services/analytics')`, and matching that comment would compare
    // the wrong two positions.
    const trapIndex = proxySource.indexOf('get: (_t, method: string) =>');
    expect(trapIndex).toBeGreaterThan(-1);
    const trapBody = proxySource.slice(trapIndex);
    const bindIndex = trapBody.indexOf('ensureCurrentPageViewHistoryEntryId()');
    const importIndex = trapBody.indexOf("import('@/services/analytics')");
    expect(bindIndex).toBeGreaterThan(-1);
    expect(importIndex).toBeGreaterThan(-1);
    expect(bindIndex).toBeLessThan(importIndex);
    expect(proxySource).toContain("from './pageViewHistoryEntry'");
  });

  it('forwards the captured entry id as the page-view identity', async () => {
    const path = '/offerte-di-lavoro-ticino/proxy-forwards-entry/';
    let state: unknown = { route: { activeTab: 'job-board' } };
    stubWindow(
      {
        length: 1,
        get state() { return state; },
        replaceState: (next: unknown) => { state = next; },
        pushState: vi.fn(),
      },
      path,
    );

    try {
      const { Analytics } = await import('@/services/analyticsProxy');
      Analytics.trackPageView(path);
      await flushForwardedCalls(1);

      const [, , , entryId] = trackPageView.mock.calls[0];
      expect(entryId).toEqual(expect.any(String));
      // The id it forwarded is the one it wrote onto the entry, not a fresh one.
      expect(JSON.stringify(state)).toContain(entryId as string);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards null when the entry id cannot be determined', async () => {
    const path = '/offerte-di-lavoro-ticino/proxy-unidentifiable/';
    // A host that owns history.state as a primitive and exposes no
    // replaceState: not determinable, so "dedup non disponibile" — not a guess.
    stubWindow({ length: 2, state: 'owned-by-another-navigation', pushState: vi.fn() }, path);

    try {
      const { Analytics } = await import('@/services/analyticsProxy');
      Analytics.trackPageView(path);
      await flushForwardedCalls(1);

      expect(trackPageView.mock.calls[0][3]).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards null when there is no window', async () => {
    vi.stubGlobal('window', undefined);
    try {
      const { Analytics } = await import('@/services/analyticsProxy');
      Analytics.trackPageView('/offerte-di-lavoro-ticino/no-window/');
      await flushForwardedCalls(1);

      expect(trackPageView.mock.calls[0][3]).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves the caller arguments untouched', async () => {
    const path = '/offerte-di-lavoro-ticino/proxy-arguments/';
    let state: unknown = { route: { activeTab: 'job-board' } };
    stubWindow(
      {
        length: 1,
        get state() { return state; },
        replaceState: (next: unknown) => { state = next; },
        pushState: vi.fn(),
      },
      path,
    );

    try {
      const { Analytics } = await import('@/services/analyticsProxy');
      Analytics.trackPageView(path, 'Un titolo', { employerKey: 'example-employer' });
      await flushForwardedCalls(1);

      expect(trackPageView.mock.calls[0].slice(0, 3)).toEqual([
        path,
        'Un titolo',
        { employerKey: 'example-employer' },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
