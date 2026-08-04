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
