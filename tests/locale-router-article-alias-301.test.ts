import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — standalone JavaScript Worker.
import worker, { articleAliasTarget } from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const registry = {
  blog: { 'article-id': { it: 'articolo', en: 'article', de: 'artikel', fr: 'article-fr' } },
  blogReverse: { it: { articolo: 'article-id' }, en: { article: 'article-id' } },
  swiss: { 'swiss-id': { it: 'svizzero', en: 'swiss', de: 'schweizer', fr: 'suisse' } },
  swissReverse: { it: { svizzero: 'swiss-id' } },
};

beforeEach(() => {
  vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockOrigin({ current = 404, target = 200, api = 200 } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/slugs.json')) return new Response(JSON.stringify(registry), { status: api });
    return new Response('page', { status: url.pathname === '/de/grenzgaenger-artikel/artikel/' ? target : current });
  });
}

describe('article aliases from the public corpus registry', () => {
  it.each([
    ['/de/grenzgaenger-artikel/articolo/', '/de/grenzgaenger-artikel/artikel/'],
    ['/en/cross-border-articles/article-id/', '/en/cross-border-articles/article/'],
    ['/fr/articles-frontalier/article/', '/fr/articles-frontalier/article-fr/'],
    ['/en/swiss-articles/svizzero/', '/en/swiss-articles/swiss/'],
    ['/articoli-svizzera/swiss-id/', '/articoli-svizzera/svizzero/'],
  ])('resolves the same resource and language: %s', (from, target) => {
    expect(articleAliasTarget(from, registry)).toBe(target);
  });

  it.each([
    '/de/grenzgaenger-artikel/artikel/', '/de/grenzgaenger-artikel/unknown/',
    '/de/grenzgaenger-artikel/articolo/alertswiss.ch', '/en/swiss-articles/article-id/',
    '/cerca-lavoro-ticino/article-id/', '/de/grenzgaenger-artikel/toString/',
  ])('does not invent a replacement for %s', (pathname) => {
    expect(articleAliasTarget(pathname, registry)).toBeNull();
  });

  it('rejects ambiguous ids, absent translations and unsafe targets', () => {
    expect(articleAliasTarget('/de/grenzgaenger-artikel/articolo/', {
      ...registry, blogReverse: { ...registry.blogReverse, fr: { articolo: 'other-id' } },
    })).toBeNull();
    for (const de of [undefined, '', '../outside', 'https://example.com', 'wrong?query', '%2foutside']) {
      expect(articleAliasTarget('/de/grenzgaenger-artikel/article-id/', {
        ...registry, blog: { 'article-id': { de } },
      })).toBeNull();
    }
  });

  it('returns a real 301 only after the origin 404 and a verified destination', async () => {
    mockOrigin();
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/?utm_source=gsc`), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/de/grenzgaenger-artikel/artikel/?utm_source=gsc');
  });

  it.each([{ target: 404 }, { target: 503 }, { api: 503 }])('keeps 404 when recovery is unverified: %j', async (options) => {
    mockOrigin(options);
    expect((await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx)).status).toBe(404);
  });

  it('leaves a live page untouched without fetching the registry', async () => {
    const fetchMock = mockOrigin({ current: 200 });
    expect((await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx)).status).toBe(200);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/slugs.json'))).toBe(false);
  });

  it('keeps an explicit withdrawal ahead of alias recovery', async () => {
    const fetchMock = mockOrigin();
    const response = await worker.fetch(new Request(`${APEX}/articoli-frontaliere/prezzi-proprieta-svizzera-aumentano/`), {}, ctx);
    expect(response.status).toBe(410);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
