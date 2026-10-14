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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockOrigin({ current = 404, target = 200, api = 200, payload = JSON.stringify(registry) } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/slugs.json')) return new Response(payload, { status: api });
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

  it.each([404, 410])('keeps 404 when the registered destination is actually missing: %s', async (target) => {
    mockOrigin({ target });
    expect((await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx)).status).toBe(404);
  });

  it.each([{ target: 503 }, { target: 429 }, { api: 503 }])('reports temporary verification failure, not a missing article: %j', async (options) => {
    mockOrigin(options);
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each(['{', 'null', '[]', '{}', '{"blog":[]}'])('does not claim absence from an unreadable registry: %s', async (payload) => {
    mockOrigin({ payload });
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
  });

  it.each(['registry', 'target'])('keeps a %s network failure temporary', async (phase) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/slugs.json')) {
        if (phase === 'registry') throw new TypeError('Network unavailable');
        return Response.json(registry);
      }
      if (url.pathname === '/de/grenzgaenger-artikel/artikel/') throw new TypeError('Network unavailable');
      return new Response('missing', { status: 404 });
    });
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('treats an actual target-probe abort as temporary without relaxing the timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/slugs.json')) return Response.json(registry);
      if (url.pathname === '/de/grenzgaenger-artikel/artikel/') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return new Response('missing', { status: 404 });
    });
    const pending = worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx);
    await vi.advanceTimersByTimeAsync(2500);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('keeps healthy-catalog misses as 404, and recovers after a temporary failure', async () => {
    const fetchMock = mockOrigin();
    expect((await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/unknown/`), {}, ctx)).status).toBe(404);
    fetchMock.mockRestore();
    const unavailable = mockOrigin({ target: 503 });
    expect((await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx)).status).toBe(503);
    unavailable.mockRestore();
    mockOrigin();
    expect((await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx)).status).toBe(301);
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
