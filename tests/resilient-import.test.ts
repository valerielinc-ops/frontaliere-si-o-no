import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resilientImport,
  isChunkLoadError,
  isVersionSkewError,
  isModuleLinkSkewMessage,
  recoverFromStaleChunk,
  bustAssetHttpCache,
  MAX_RELOADS,
  MAX_TOTAL_RELOADS,
} from '@/services/resilientImport';

/**
 * resilientImport recovers from two stale-deploy failure modes:
 *  1. import() rejects with a chunk-load error (purged chunk → 404).
 *  2. import() resolves but the module is missing expected exports (version
 *     skew: stable-named chunks where a cached entry pulls a fresh chunk whose
 *     export shape differs → "n.getApp is not a function" on a minified name).
 * Both clear caches, retry once, then reload — guarded to MAX_RELOADS attempts
 * per distinct signature (the failing chunk/message), MAX_TOTAL_RELOADS overall
 * per session.
 */
function reloadBudgetTotal(): number {
  const budget: Record<string, number> = JSON.parse(sessionStorage.getItem('_swReloadCount') || '{}');
  return Object.values(budget).reduce((a, b) => a + Number(b), 0);
}
describe('resilientImport', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Fresh caches mock per test.
    (globalThis as any).caches = {
      keys: vi.fn().mockResolvedValue(['c1', 'c2']),
      delete: vi.fn().mockResolvedValue(true),
    };
  });

  it('returns the module on first success', async () => {
    const mod = { getApp: () => 'app' };
    const factory = vi.fn().mockResolvedValue(mod);
    const result = await resilientImport(factory);
    expect(result).toBe(mod);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('passes a valid module through when validate() is satisfied', async () => {
    const mod = { getConfigValue: () => 'v' };
    const result = await resilientImport(
      () => Promise.resolve(mod),
      (m) => typeof m.getConfigValue === 'function',
    );
    expect(result).toBe(mod);
  });

  it('retries once after clearing caches when validate() fails, then recovers', async () => {
    const good = { getApp: () => 'app' };
    // First call resolves a stale (export-less) module; retry resolves a good one.
    const factory = vi
      .fn()
      .mockResolvedValueOnce({} as { getApp?: () => string })
      .mockResolvedValueOnce(good);

    const result = await resilientImport(factory, (m) => typeof m.getApp === 'function');

    expect(result).toBe(good);
    expect(factory).toHaveBeenCalledTimes(2);
    expect((globalThis as any).caches.delete).toHaveBeenCalledTimes(2); // c1 + c2
  });

  it('reloads up to MAX_RELOADS times per session when the chunk is truly gone', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reload },
    });

    const chunkErr = Object.assign(new Error('Failed to fetch dynamically imported module'), {
      name: 'ChunkLoadError',
    });
    const factory = vi.fn().mockRejectedValue(chunkErr);

    await expect(resilientImport(factory)).rejects.toThrow();
    expect(factory).toHaveBeenCalledTimes(2); // initial + one retry
    expect(reload).toHaveBeenCalledTimes(1);
    // Uses the shared _swReloadCount budget — same signature (identical message)
    // as recoverFromStaleChunk + index.html would use, so it fills the SAME slot.
    expect(reloadBudgetTotal()).toBe(1);

    // The SAME chunk failing again still has budget left, up to MAX_RELOADS.
    for (let n = 2; n <= MAX_RELOADS; n++) {
      reload.mockClear();
      await expect(resilientImport(factory)).rejects.toThrow();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadBudgetTotal()).toBe(n);
    }

    // Once this signature's ceiling is reached, a further failure with the SAME
    // message must NOT reload again.
    reload.mockClear();
    await expect(resilientImport(factory)).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it('recovers from a DIFFERENT chunk failure after the first chunk already exhausted its own budget', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reload },
    });

    const staleErr = Object.assign(new Error('Failed to fetch dynamically imported module A'), {
      name: 'ChunkLoadError',
    });
    const factoryA = vi.fn().mockRejectedValue(staleErr);
    for (let n = 1; n <= MAX_RELOADS; n++) {
      await expect(resilientImport(factoryA)).rejects.toThrow();
    }
    reload.mockClear();
    await expect(resilientImport(factoryA)).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled(); // chunk A's budget is spent

    // A genuinely different, unrelated chunk going stale must still recover —
    // a flat session-wide counter would incorrectly block this too (#3097
    // recurrence: a live user stranded after two unrelated chunks went stale
    // on different pages before a third, independently-recoverable one hit).
    const otherErr = Object.assign(new Error('Failed to fetch dynamically imported module B'), {
      name: 'ChunkLoadError',
    });
    const factoryB = vi.fn().mockRejectedValue(otherErr);
    reload.mockClear();
    await expect(resilientImport(factoryB)).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not swallow non-chunk errors', async () => {
    const factory = vi.fn().mockRejectedValue(new TypeError('genuine bug'));
    await expect(resilientImport(factory)).rejects.toThrow('genuine bug');
    expect(factory).toHaveBeenCalledTimes(1); // no retry for unrelated errors
  });

  it('isChunkLoadError recognises the stale-deploy signatures', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('something else'))).toBe(false);
  });
});

/**
 * Cross-chunk version-skew recovery — the third stale-deploy failure mode
 * (stable filenames + re-lettered minified cross-chunk exports). A successfully
 * loaded but mismatched chunk throws a TypeError at CALL time
 * ("ls(...).then is not a function") deep in render/effects — caught by the
 * ErrorBoundary / global window error handler, NOT by resilientImport's import()
 * wrapper. isVersionSkewError is the signature predicate both call.
 */
describe('isVersionSkewError', () => {
  it('matches the version-skew TypeError signatures', () => {
    // The exact shape reported live on /articoli-frontaliere/<slug>/.
    expect(isVersionSkewError(new TypeError('ls(...).then is not a function'))).toBe(true);
    expect(isVersionSkewError(new TypeError('n.getApp is not a function'))).toBe(true);
    expect(isVersionSkewError(new TypeError('n is not a function'))).toBe(true);
    expect(isVersionSkewError(new TypeError('Ze is not a constructor'))).toBe(true);
    expect(isVersionSkewError(new TypeError('e is not iterable'))).toBe(true);
  });

  it('ignores non-TypeError errors with the same message', () => {
    // Only TypeError carries the skew signature; a hand-thrown Error does not.
    expect(isVersionSkewError(new Error('x is not a function'))).toBe(false);
    expect(isVersionSkewError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(false);
  });

  it('ignores unrelated TypeErrors', () => {
    expect(isVersionSkewError(new TypeError('Cannot read properties of undefined (reading "x")'))).toBe(false);
    expect(isVersionSkewError(new TypeError('Assignment to constant variable.'))).toBe(false);
    expect(isVersionSkewError(null)).toBe(false);
    expect(isVersionSkewError(undefined)).toBe(false);
  });

  // Issue #4304: the site's #1 live runtime exception (per analyticsProxy.ts's
  // doc comment) — cross-chunk skew leaves the `Analytics` lazy-proxy import
  // bound to `undefined` at the call site, so `Analytics.trackCalculation(...)`
  // throws this shape instead of "is not a function".
  it('matches the undefined-lazy-proxy-import TypeError signatures (track*/init*/set*)', () => {
    // V8 / Chrome / Edge / Node — exact shape reported live (issue #4304, 27/18
    // users on hooks/useSimulationState.ts's Analytics.trackCalculation call).
    expect(
      isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'trackCalculation')")),
    ).toBe(true);
    expect(
      isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'trackFunnelStep')")),
    ).toBe(true);
    expect(isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'initGlobalErrorTracking')"))).toBe(
      true,
    );
    expect(isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'setWorkerType')"))).toBe(true);
    // Safari / WebKit wording, cited verbatim in analyticsProxy.ts's doc comment.
    expect(
      isVersionSkewError(new TypeError("undefined is not an object (evaluating 't.Analytics.trackCalculation')")),
    ).toBe(true);
  });

  it('does not widen the undefined-property pattern beyond the closed track*/init*/set* anchor', () => {
    // A generic first-party null-pointer bug on an unrelated property name must
    // NOT be masked as version skew — the anchor is deliberately narrow (see
    // comment on CALL_TIME_SKEW_PATTERNS in services/resilientImport.ts).
    expect(isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
    expect(isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(
      isVersionSkewError(new TypeError("Cannot read properties of undefined (reading 'children')")),
    ).toBe(false);
    expect(isVersionSkewError(new TypeError("undefined is not an object (evaluating 't.foo.bar')"))).toBe(false);
  });

  // Link-time skew (#3097): a cached importer chunk requests an export the
  // already-loaded dependency chunk no longer provides → the ES module linker
  // throws a SyntaxError at instantiation, surfaced through React.lazy →
  // ErrorBoundary (NOT a TypeError, NOT a fetch error).
  it('matches the link-time module-mismatch SyntaxError across browsers', () => {
    // V8 / Chrome / Edge — the exact wording reported live on the blog article.
    expect(
      isVersionSkewError(
        new SyntaxError("The requested module './vendor-icons.js' does not provide an export named 'House'"),
      ),
    ).toBe(true);
    // Firefox.
    expect(isVersionSkewError(new SyntaxError('import not found: House'))).toBe(true);
    expect(isVersionSkewError(new SyntaxError('ambiguous indirect export: House'))).toBe(true);
    // WebKit / Safari.
    expect(isVersionSkewError(new SyntaxError("Importing binding name 'House' is not found."))).toBe(true);
  });

  it('ignores unrelated SyntaxErrors (genuine parse bugs)', () => {
    expect(isVersionSkewError(new SyntaxError('Unexpected token <'))).toBe(false);
    expect(isVersionSkewError(new SyntaxError('Unexpected end of input'))).toBe(false);
    // Only a SyntaxError carries the link-skew signature; a hand-thrown Error does not.
    expect(isVersionSkewError(new Error("does not provide an export named 'House'"))).toBe(false);
  });
});

describe('isModuleLinkSkewMessage', () => {
  it('recognises the cross-browser link-mismatch wordings', () => {
    expect(isModuleLinkSkewMessage("does not provide an export named 'House'")).toBe(true);
    expect(isModuleLinkSkewMessage('import not found: House')).toBe(true);
    expect(isModuleLinkSkewMessage('ambiguous indirect export: House')).toBe(true);
    expect(isModuleLinkSkewMessage("Importing binding name 'House' is not found.")).toBe(true);
  });

  it('does not match unrelated messages', () => {
    expect(isModuleLinkSkewMessage('Unexpected token <')).toBe(false);
    expect(isModuleLinkSkewMessage('Failed to fetch dynamically imported module')).toBe(false);
    expect(isModuleLinkSkewMessage('')).toBe(false);
  });
});

describe('recoverFromStaleChunk', () => {
  const setHostname = (hostname: string) => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname, reload: vi.fn() },
    });
    return window.location.reload as unknown as ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    sessionStorage.clear();
    (globalThis as any).caches = {
      keys: vi.fn().mockResolvedValue(['c1', 'c2']),
      delete: vi.fn().mockResolvedValue(true),
    };
  });

  it('clears caches and reloads once on a production host', async () => {
    const reload = setHostname('frontaliereticino.ch');
    const scheduled = await recoverFromStaleChunk('version_skew:test');
    expect(scheduled).toBe(true);
    expect((globalThis as any).caches.delete).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    // Shares the `_swReloadCount` budget with the index.html bootstrap recovery.
    expect(reloadBudgetTotal()).toBe(1);
  });

  it('honours the per-signature ceiling already reached by the index.html bootstrap recovery', async () => {
    const reload = setHostname('frontaliereticino.ch');
    // index.html's resource/import/skew handlers write into the SAME budget map,
    // keyed by the identical reason string this call will use.
    sessionStorage.setItem(
      '_swReloadCount',
      JSON.stringify({ 'after-bootstrap-reload': MAX_RELOADS }),
    );
    const scheduled = await recoverFromStaleChunk('after-bootstrap-reload');
    expect(scheduled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('recovers a DIFFERENT signature even when another one already reached its ceiling', async () => {
    const reload = setHostname('frontaliereticino.ch');
    // Simulates the exact live-bug shape: an earlier, unrelated stale chunk
    // already spent its own budget elsewhere in the session (e.g. the
    // index.html bootstrap handler on a previous page) — that must NOT block
    // recovery for a NEW, distinct stale chunk (#3097 recurrence, jul02).
    sessionStorage.setItem(
      '_swReloadCount',
      JSON.stringify({ 'some-other-page-skew': MAX_RELOADS }),
    );
    const scheduled = await recoverFromStaleChunk('a-fresh-distinct-skew');
    expect(scheduled).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is guarded to at most MAX_RELOADS reloads per distinct signature', async () => {
    const reload = setHostname('frontaliereticino.ch');

    for (let n = 1; n <= MAX_RELOADS; n++) {
      reload.mockClear();
      const scheduled = await recoverFromStaleChunk('repeating-signature');
      expect(scheduled).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
    }

    // This signature's ceiling is reached — the SAME reason must NOT reload again.
    reload.mockClear();
    const scheduled = await recoverFromStaleChunk('repeating-signature');
    expect(scheduled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('is guarded to at most MAX_TOTAL_RELOADS reloads per session across distinct signatures', async () => {
    const reload = setHostname('frontaliereticino.ch');

    for (let n = 1; n <= MAX_TOTAL_RELOADS; n++) {
      reload.mockClear();
      const scheduled = await recoverFromStaleChunk(`attempt-${n}`);
      expect(scheduled).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
    }

    // The absolute session ceiling is reached — even a brand-new, never-seen
    // signature must NOT reload again.
    reload.mockClear();
    const scheduled = await recoverFromStaleChunk('over-the-limit');
    expect(scheduled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads in local dev (Vite HMR produces transient skew)', async () => {
    const reload = setHostname('localhost');
    const scheduled = await recoverFromStaleChunk('dev');
    expect(scheduled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * bustAssetHttpCache (#3097): the #3071/#3131 self-heal only cleared CacheStorage
 * (empty here — no asset-caching service worker) and then reloaded, so the HTTP
 * disk cache re-served the SAME version-skewed cross-origin chunk within the
 * max-age=600 window → the one allowed reload was wasted and the error page
 * persisted (works in incognito only — no persistent HTTP cache). bustAssetHttpCache
 * refetches the loaded /assets/ chunks with `cache: 'reload'`, OVERWRITING the
 * stale entries so the subsequent reload loads a consistent, current set.
 */
describe('bustAssetHttpCache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let perfSpy: ReturnType<typeof vi.spyOn>;
  const originalFetch = (globalThis as any).fetch;

  const mockResources = (names: string[]) => {
    perfSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(names.map((name) => ({ name })) as unknown as PerformanceEntryList);
  };

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    perfSpy?.mockRestore();
    (globalThis as any).fetch = originalFetch;
    delete (performance as any).setResourceTimingBufferSize;
    vi.useRealTimers();
  });

  it('refetches every loaded /assets/ JS+CSS with cache:reload, skipping non-assets', async () => {
    mockResources([
      'https://cdn.frontaliereticino.ch/assets/vendor-icons.js',
      'https://cdn.frontaliereticino.ch/assets/App.js',
      'https://cdn.frontaliereticino.ch/assets/index.css',
      'https://cdn.frontaliereticino.ch/data/jobs.json', // data, not a code chunk
      'https://www.googletagmanager.com/gtag/js', // third-party
    ]);

    await bustAssetHttpCache();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://cdn.frontaliereticino.ch/assets/vendor-icons.js',
      'https://cdn.frontaliereticino.ch/assets/App.js',
      'https://cdn.frontaliereticino.ch/assets/index.css',
    ]);
    for (const call of fetchMock.mock.calls) {
      // cache:'reload' is what overwrites the stale HTTP cache entry. mode:'cors'
      // matches module fetches (always CORS-enabled). credentials:'same-origin'
      // matches the spec-default credentials mode of a <script type="module">
      // with no crossorigin attribute — NOT 'omit' (issue #3149: 'omit' would
      // diverge from what the browser actually sent on a same-origin deploy).
      expect(call[1]).toMatchObject({ cache: 'reload', mode: 'cors', credentials: 'same-origin' });
    }
  });

  it('deduplicates repeated URLs', async () => {
    mockResources([
      'https://cdn.frontaliereticino.ch/assets/App.js',
      'https://cdn.frontaliereticino.ch/assets/App.js',
    ]);
    await bustAssetHttpCache();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves even when a refetch rejects (best-effort)', async () => {
    mockResources(['https://cdn.frontaliereticino.ch/assets/App.js']);
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(bustAssetHttpCache()).resolves.toBeUndefined();
  });

  it('no-ops when fetch is unavailable', async () => {
    mockResources(['https://cdn.frontaliereticino.ch/assets/App.js']);
    delete (globalThis as any).fetch;
    await expect(bustAssetHttpCache()).resolves.toBeUndefined();
  });

  it('does not fetch when no /assets/ chunks are loaded', async () => {
    mockResources(['https://example.com/x.js']);
    await bustAssetHttpCache();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Issue #3149: Resource Timing's default buffer (spec floor: 250 entries) can
  // realistically fill over a long-lived SPA session (no full navigation between
  // in-app pages, plus AdSense/GTM/Firebase/Clarity resource loads), silently
  // evicting the oldest entries — including a version-skewed chunk's own timing
  // entry. Raising the cap cannot restore already-evicted entries, but prevents
  // future eviction; this must run before every read of getEntriesByType.
  it('raises the Resource Timing buffer cap before reading resource entries', async () => {
    mockResources(['https://cdn.frontaliereticino.ch/assets/App.js']);
    const setBufferSize = vi.fn();
    (performance as any).setResourceTimingBufferSize = setBufferSize;

    await bustAssetHttpCache();

    expect(setBufferSize).toHaveBeenCalledTimes(1);
    // Must exceed the spec-floor default (250) to actually help.
    expect(setBufferSize.mock.calls[0][0]).toBeGreaterThan(250);
  });

  it('does not throw when setResourceTimingBufferSize is unsupported (e.g. older browsers)', async () => {
    mockResources(['https://cdn.frontaliereticino.ch/assets/App.js']);
    // Force the unsupported shape regardless of what the test environment's
    // `performance` implements natively (Node/undici's does; real legacy
    // browsers may not) — the guard is the `typeof === 'function'` check.
    (performance as any).setResourceTimingBufferSize = undefined;
    await expect(bustAssetHttpCache()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.frontaliereticino.ch/assets/App.js',
      expect.anything(),
    );
  });

  // The DOM-scan enumeration path is a SECOND, independent source — unioned
  // with Resource Timing rather than only consulted when it comes back empty,
  // so a PARTIAL eviction (one entry dropped, others still buffered) still
  // recovers the missing one from the DOM.
  it('unions DOM-scanned /assets/ elements with Resource Timing entries even when Resource Timing is non-empty', async () => {
    mockResources(['https://cdn.frontaliereticino.ch/assets/App.js']);
    const link = document.createElement('link');
    link.href = 'https://cdn.frontaliereticino.ch/assets/vendor-icons.js';
    document.head.appendChild(link);
    try {
      await bustAssetHttpCache();
      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls).toContain('https://cdn.frontaliereticino.ch/assets/App.js');
      expect(urls).toContain('https://cdn.frontaliereticino.ch/assets/vendor-icons.js');
    } finally {
      link.remove();
    }
  });

  // Full-eviction fallback: Resource Timing returns nothing (simulating every
  // /assets/ entry evicted from an overflowed buffer) but the chunk is still a
  // <script> element in the DOM (e.g. the main entry script, or a statically
  // injected <link rel="modulepreload">) — the DOM scan alone must recover it.
  // NOTE: this does NOT cover chunks loaded via dynamic import(), which never
  // leave a DOM node — that gap is what the buffer-size raise above mitigates.
  it('falls back to a DOM scan when Resource Timing returns no entries at all', async () => {
    mockResources([]);
    const script = document.createElement('script');
    script.src = 'https://cdn.frontaliereticino.ch/assets/App.js';
    document.body.appendChild(script);
    try {
      await bustAssetHttpCache();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cdn.frontaliereticino.ch/assets/App.js',
        expect.objectContaining({ cache: 'reload' }),
      );
    } finally {
      script.remove();
    }
  });

  it('reloads anyway when a refetch hangs past the timeout', async () => {
    vi.useFakeTimers();
    mockResources(['https://cdn.frontaliereticino.ch/assets/App.js']);
    fetchMock.mockReturnValue(new Promise(() => {/* never settles */}));
    const pending = bustAssetHttpCache();
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toBeUndefined();
  });

  it('recoverFromStaleChunk busts the HTTP cache before reloading', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: 'frontaliereticino.ch', reload: vi.fn() },
    });
    (globalThis as any).caches = {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    };
    mockResources(['https://cdn.frontaliereticino.ch/assets/vendor-icons.js']);

    const scheduled = await recoverFromStaleChunk('version_skew:link');

    expect(scheduled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.frontaliereticino.ch/assets/vendor-icons.js',
      expect.objectContaining({ cache: 'reload' }),
    );
    expect((window.location.reload as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
