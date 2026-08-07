// The overlay is what makes an article generated after this build appear in
// the site's lists without a redeploy (issue #4974 item 3). Its contract is
// entirely about failure: it must ADD what the bundle lacks and must never
// change or lose what the bundle has, whatever the network returns.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeOverlay, fetchArticleOverlay } from '../services/articlesOverlay';
import { t } from '../services/i18n';

const bundled = [{ id: 'vecchio-1' }, { id: 'vecchio-2' }];

describe('mergeOverlay', () => {
  it('adds an article the bundle does not have, newest first', () => {
    const r = mergeOverlay(bundled, [{ id: 'nuovo', title: 'Titolo nuovo' }], 'it');
    expect(r.added).toBe(1);
    expect(r.articles.map((a) => a.id)).toEqual(['nuovo', 'vecchio-1', 'vecchio-2']);
  });

  it('makes the new title resolvable through t()', () => {
    mergeOverlay(bundled, [{ id: 'con-titolo', title: 'Il titolo pubblicato' }], 'it');
    expect(t('blog.article.con-titolo.title')).toBe('Il titolo pubblicato');
  });

  it('drops an overlay entry the bundle already has — this build wins', () => {
    const r = mergeOverlay(bundled, [{ id: 'vecchio-1', title: 'RISCRITTO' }], 'it');
    expect(r.added).toBe(0);
    expect(r.articles).toBe(bundled);
    expect(t('blog.article.vecchio-1.title')).not.toBe('RISCRITTO');
  });

  it('is a no-op on an empty overlay', () => {
    const r = mergeOverlay(bundled, [], 'it');
    expect(r.added).toBe(0);
    expect(r.articles).toBe(bundled);
  });
});

describe('fetchArticleOverlay — every failure resolves to []', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['HTTP 404', () => Promise.resolve({ ok: false, status: 404 } as Response)],
    ['JSON malformato', () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad')) } as unknown as Response)],
    ['forma inattesa', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 1 }) } as unknown as Response)],
    ['rete giù', () => Promise.reject(new Error('offline'))],
  ])('%s', async (_label, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    await expect(fetchArticleOverlay('frontaliere', 'it')).resolves.toEqual([]);
  });

  it('drops entries without a usable id or title', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ articles: [
        { id: 'buono', title: 'Buono' },
        { id: '', title: 'senza id' },
        { id: 'senza-titolo' },
        null,
      ] }),
    } as unknown as Response)));
    const r = await fetchArticleOverlay('frontaliere', 'it');
    expect(r.map((a) => a.id)).toEqual(['buono']);
  });
});

// The published window (RECENT_LIMIT=150) was sized against how often the site
// deploys. When deploys stall, the bundle stops advancing while articles keep
// publishing, and anything older than the window and newer than the bundle is
// in NEITHER — live at its own URL, invisible in every list, with nothing
// reporting it. The escalation below is what removes that cliff.
describe('fetchArticleOverlay — escalates past the published window', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const recent = { total: 3000, articles: [{ id: 'r1', title: 'Recente' }] };
  const full = {
    total: 3000,
    articles: [{ id: 'r1', title: 'Recente' }, { id: 'v1', title: 'Vecchio ma non nel bundle' }],
  };

  const stub = (impl: (url: string) => unknown) =>
    vi.stubGlobal('fetch', vi.fn((u: string) => Promise.resolve({
      ok: true, json: () => Promise.resolve(impl(u)),
    } as unknown as Response)));

  it('fetches the full index when the window cannot close the gap', async () => {
    stub((u) => (String(u).includes('-full') ? full : recent));
    // 100 bundled + 1 in the window = 101, against a corpus of 3000.
    const out = await fetchArticleOverlay('frontaliere', 'it', 100);
    expect(out.map((a) => a.id)).toEqual(['r1', 'v1']);
  });

  it('does not fetch the full index when the bundle is current', async () => {
    const fn = vi.fn((_u: string) => Promise.resolve({
      ok: true, json: () => Promise.resolve(recent),
    } as unknown as Response));
    vi.stubGlobal('fetch', fn);
    const out = await fetchArticleOverlay('frontaliere', 'it', 2999);
    expect(out.map((a) => a.id)).toEqual(['r1']);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).not.toContain('-full');
  });

  it('keeps the window when the full index is missing — never drops the overlay', async () => {
    stub((u) => (String(u).includes('-full') ? { nope: 1 } : recent));
    const out = await fetchArticleOverlay('frontaliere', 'it', 100);
    expect(out.map((a) => a.id)).toEqual(['r1']);
  });

  it('behaves exactly as before when the caller passes no bundle size', async () => {
    const fn = vi.fn((_u: string) => Promise.resolve({
      ok: true, json: () => Promise.resolve(recent),
    } as unknown as Response));
    vi.stubGlobal('fetch', fn);
    const out = await fetchArticleOverlay('frontaliere', 'it');
    expect(out.map((a) => a.id)).toEqual(['r1']);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// The count alone has a blind spot: ids this build ships that the corpus has
// since dropped inflate `bundledCount` and hide a real shortfall. The date test
// closes it — `oldest` is published for exactly this.
describe('fetchArticleOverlay — the date trigger catches what the count misses', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const recent = {
    total: 3074,
    oldest: '2026-07-21',
    articles: [{ id: 'r1', title: 'Recente' }],
  };
  const full = {
    total: 3074,
    oldest: '2026-01-01',
    articles: [{ id: 'r1', title: 'Recente' }, { id: 'gap', title: 'Nel buco' }],
  };

  const stub = () => vi.stubGlobal('fetch', vi.fn((u: string) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(String(u).includes('-full') ? full : recent),
  } as unknown as Response)));

  it('escalates when the bundle ends before the window starts, even though the counts agree', async () => {
    stub();
    // 3073 bundled + 1 in the window >= 3074, so the count trigger stays quiet —
    // but this build's newest article predates the window's oldest entry.
    const out = await fetchArticleOverlay('frontaliere', 'it', 3073, '2026-07-01');
    expect(out.map((a) => a.id)).toEqual(['r1', 'gap']);
  });

  it('does not escalate when the window reaches back past the bundle', async () => {
    const fn = vi.fn((_u: string) => Promise.resolve({
      ok: true, json: () => Promise.resolve(recent),
    } as unknown as Response));
    vi.stubGlobal('fetch', fn);
    const out = await fetchArticleOverlay('frontaliere', 'it', 3073, '2026-08-01');
    expect(out.map((a) => a.id)).toEqual(['r1']);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// The index is fetched under a ROTATING url, and that is not a detail.
//
// Measured 2026-08-06: the publisher purged these urls and the purge returned
// success, yet the copy the app received did not move for 28 hours. The
// responses carry `Vary: Origin`, so the edge holds a separate variant for
// requests that send one — and a cross-origin fetch from the app is the only
// caller that does. Purge-by-url clears the variant the purge itself matches,
// which sends no `Origin`, so the app's variant is never cleared.
//
// That is why `curl`, a direct navigation and every no-Origin CI probe read
// fresh while the browser read stale, and why the only lever that reaches a
// different cache entry is a different url. `cache: 'no-store'` was verified
// NOT to help: it governs the browser's cache, not the edge's.
describe('fetchArticleOverlay — the url carries a bounded freshness key', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const urlsFrom = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => String(c[0]));

  const stubOk = (body: unknown = { total: 1, articles: [{ id: 'a', title: 'A' }] }) => {
    const fn = vi.fn((_u: string) => Promise.resolve({
      ok: true, json: () => Promise.resolve(body),
    } as unknown as Response));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('appends a version token, so it cannot be served the unpurgeable variant', async () => {
    const fn = stubOk();
    await fetchArticleOverlay('frontaliere', 'it');
    expect(urlsFrom(fn)[0]).toMatch(/blog-index-frontaliere-it\.json\?v=\d+$/);
  });

  it('reuses one url inside a bucket, so the CDN still absorbs the traffic', async () => {
    const fn = stubOk();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000_000_000);
    await fetchArticleOverlay('frontaliere', 'it');
    now.mockReturnValue(1_000_000_000_000 + 60_000); // +1 min, same bucket
    await fetchArticleOverlay('frontaliere', 'it');
    const [a, b] = urlsFrom(fn);
    // Assert the token is there before asserting it is stable, else this test
    // passes for the wrong reason on a build that dropped versioning entirely.
    expect(a).toMatch(/\?v=\d+$/);
    expect(a).toBe(b);
  });

  it('moves to a new url once the bucket rolls, bounding how stale a list can be', async () => {
    const fn = stubOk();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000_000_000);
    await fetchArticleOverlay('frontaliere', 'it');
    now.mockReturnValue(1_000_000_000_000 + 5 * 60_000); // +5 min, next bucket
    await fetchArticleOverlay('frontaliere', 'it');
    const [a, b] = urlsFrom(fn);
    expect(a).not.toBe(b);
  });

  it('versions the full index too — the escalation path must not be stale either', async () => {
    const fn = stubOk();
    // Force the escalation: 0 bundled + 1 in the window, against a corpus of 3000.
    vi.stubGlobal('fetch', vi.fn((u: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(u).includes('-full')
        ? { total: 3000, articles: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }
        : { total: 3000, articles: [{ id: 'a', title: 'A' }] }),
    } as unknown as Response)));
    await fetchArticleOverlay('frontaliere', 'it', 0);
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(calls.some((u) => /-full\.json\?v=\d+$/.test(u))).toBe(true);
    void fn;
  });
});
