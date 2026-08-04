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
