import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — standalone JavaScript Worker.
import worker, { articleAliasTarget, __resetCorpusRegistryForTests, corpusSectionCdnKey, CDN_BASE } from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const registry = {
  blog: { 'article-id': { it: 'articolo', en: 'article', de: 'artikel', fr: 'article-fr' } },
  blogReverse: { it: { articolo: 'article-id' }, en: { article: 'article-id' } },
  swiss: { 'swiss-id': { it: 'svizzero', en: 'swiss', de: 'schweizer', fr: 'suisse' } },
  swissReverse: { it: { svizzero: 'swiss-id' } },
};
const reportedNestedArticleRegistry = {
  blog: {
    'nuovo-potabilizzatore-mobile-ticino-emergenza': { en: 'ticino-mobile-water-treatment-emergency' },
    'chiasso-scoperta-enti-primo-intervento': { en: 'chiasso-scoperta-enti-primo-intervento' },
    'dazi-usa-rimborsi-ritardi': { de: 'zoll-erstattungs-verzogerungen-usa' },
    'lago-maggiore-accesso-tutto-l-anno': { de: 'see-maggiore-zugang-ganzjaehrig' },
  },
  blogReverse: {
    en: {
      'ticino-mobile-water-treatment-emergency': 'nuovo-potabilizzatore-mobile-ticino-emergenza',
      'chiasso-scoperta-enti-primo-intervento': 'chiasso-scoperta-enti-primo-intervento',
    },
    de: {
      'zoll-erstattungs-verzogerungen-usa': 'dazi-usa-rimborsi-ritardi',
      'see-maggiore-zugang-ganzjaehrig': 'lago-maggiore-accesso-tutto-l-anno',
    },
  },
};
const reportedNestedArticleTargets = [
  '/en/cross-border-articles/ticino-mobile-water-treatment-emergency/',
  '/en/cross-border-articles/chiasso-scoperta-enti-primo-intervento/',
  '/de/grenzgaenger-artikel/zoll-erstattungs-verzogerungen-usa/',
  '/de/grenzgaenger-artikel/see-maggiore-zugang-ganzjaehrig/',
];
const reportedNestedArticleCases = [
  ['/en/cross-border-articles/ticino-mobile-water-treatment-emergency/alertswiss.ch', reportedNestedArticleTargets[0]],
  ['/en/cross-border-articles/chiasso-scoperta-enti-primo-intervento/www.chiasso.ch/missione-emergenza-chiasso-2026', reportedNestedArticleTargets[1]],
  ['/de/grenzgaenger-artikel/zoll-erstattungs-verzogerungen-usa/calculator', reportedNestedArticleTargets[2]],
  ['/de/grenzgaenger-artikel/see-maggiore-zugang-ganzjaehrig/calculator', reportedNestedArticleTargets[3]],
];

beforeEach(() => {
  __resetCorpusRegistryForTests();
  vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
});
afterEach(() => { __resetCorpusRegistryForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockOrigin({ current = 404, target = 200, api = 200, payload = JSON.stringify(registry),
  targetPaths = ['/de/grenzgaenger-artikel/artikel/'] } = {}) {
  const verifiedTargets = new Set(targetPaths);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/slugs.json')) return new Response(payload, { status: api });
    return new Response('page', { status: verifiedTargets.has(url.pathname) ? target : current });
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

  it.each(reportedNestedArticleCases)(
    'recovers a reported nested URL only when its first segment is the current same-locale slug: %s',
    (from, target) => {
      expect(articleAliasTarget(from, reportedNestedArticleRegistry)).toBe(target);
    },
  );

  it.each([
    '/de/grenzgaenger-artikel/artikel/', '/de/grenzgaenger-artikel/unknown/',
    '/de/grenzgaenger-artikel/articolo/alertswiss.ch', '/en/swiss-articles/article-id/',
    '/de/grenzgaenger-artikel/unknown/calculator', '/de/grenzgaenger-artikel/article-id/calculator',
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

  it.each([[404, 'GET'], [404, 'HEAD'], [410, 'GET'], [410, 'HEAD']] as const)
  ('returns a real 301 only after origin %s and a verified destination: %s', async (current, method) => {
    mockOrigin({ current });
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/?utm_source=gsc`, { method }), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/de/grenzgaenger-artikel/artikel/?utm_source=gsc');
  });

  it.each(reportedNestedArticleCases.flatMap(([from, target]) => ['GET', 'HEAD'].map((method) => [from, target, method])))
  ('redirects an exact reported nested URL only after a live registry target check: %s (%s)', async (from, target, method) => {
    mockOrigin({ payload: JSON.stringify(reportedNestedArticleRegistry), targetPaths: reportedNestedArticleTargets });
    const response = await worker.fetch(new Request(`${APEX}${from}?utm_source=gsc`, { method }), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${target}?utm_source=gsc`);
  });

  it('keeps a nested article path at 404 when its canonical target is missing', async () => {
    mockOrigin({ target: 404, payload: JSON.stringify(reportedNestedArticleRegistry), targetPaths: reportedNestedArticleTargets });
    const [from] = reportedNestedArticleCases[0];
    expect((await worker.fetch(new Request(`${APEX}${from}`), {}, ctx)).status).toBe(404);
  });

  it.each(['GET', 'HEAD'])('preserves an unknown national 410: %s', async (method) => {
    mockOrigin({ current: 410 });
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/unknown/`, { method }), {}, ctx);
    expect(response.status).toBe(410);
    expect(response.headers.get('Location')).toBeNull();
  });

  it.each([404, 410])('preserves the original 410 when an alias destination is missing: %s', async (target) => {
    mockOrigin({ current: 410, target });
    const response = await worker.fetch(new Request(`${APEX}/de/grenzgaenger-artikel/articolo/`), {}, ctx);
    expect(response.status).toBe(410);
    expect(response.headers.get('Location')).toBeNull();
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

const cantonRegistry = {
  cantons: {
    'canton-basilea': {
      'basilea-larvicida-quattro-settimane': {
        it: 'basilea-larvicida-quattro-settimane', en: 'basel-tiger-mosquito-four-weeks',
        de: 'basel-tigermuecke-vier-wochen', fr: 'bale-moustique-tigre-quatre-semaines',
      },
    },
    'canton-ju': {
      'casse-pensioni-migliorano-terzo-trimestre': {
        it: 'casse-pensioni-migliorano-terzo-trimestre', en: 'swiss-pension-funds-improve-q3-2026',
        de: 'schweizer-pensionskassen-verbessern-q3-2026', fr: 'les-caisses-de-pension-suisses-ameliorent-q3-2026',
      },
    },
    'canton-zh': {
      'disoccupazione-zurigo-rav-2026': { de: 'arbeitslosigkeit-zurich-rav-2026' },
      'mappa-affitti-zurigo-trasloco': { de: 'zuerich-mieten-umzug-karte' },
      'winterthur-governo-apprendisti': { de: 'winterthur-regierungsrat-lehrabschluesse' },
    },
    'canton-ge': {
      'economia-ginevrina-ripresa-globale': { de: 'genfer-wirtschaft-globale-erholung' },
      'accordo-cure-oncologiche-ginevra': { de: 'grenzueberschreitende-kinderkrebsversorgung-genf' },
      'ginevra-stop-autostrada-a412': { de: 'genf-stopp-autobahn-a412' },
    },
    'canton-vd': { 'cdhr-frontalieri-vaud-2026': { it: 'cdhr-frontalieri-vaud-2026' } },
  },
};
const cantonFrom = '/de/basel-artikel/basilea-larvicida-quattro-settimane/';
const cantonTarget = '/de/basel-artikel/basel-tigermuecke-vier-wochen/';

function mockCanton({ current = 404, target = 200 as number | 'network' | 'timeout',
  api = 200, payload = JSON.stringify({ ...registry, ...cantonRegistry }), status = 'live',
  redirects = {} as Record<string, string>, gone = [] as string[] } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === `${CDN_BASE}/edge/sections/registry.json`) return Response.json({
      schema: 1, commit: 'a'.repeat(40), sections: {
        'canton-basilea': { status, redirects, gone }, 'canton-ju': { status: 'live' },
      },
    });
    if (url.pathname.endsWith('/slugs.json')) return new Response(payload, { status: api });
    if (url.origin === CDN_BASE && url.pathname === corpusSectionCdnKey(cantonTarget)) {
      if (target === 'network') throw new TypeError('Network unavailable');
      if (target === 'timeout') return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return new Response('translated article', { status: target });
    }
    return new Response('original', { status: current });
  });
}

describe('canton article aliases after a definitive R2 miss', () => {
  it.each([
    [cantonFrom, cantonTarget],
    ['/en/jura-articles/casse-pensioni-migliorano-terzo-trimestre/', '/en/jura-articles/swiss-pension-funds-improve-q3-2026/'],
    ['/articoli-basilea/basel-tigermuecke-vier-wochen/', '/articoli-basilea/basilea-larvicida-quattro-settimane/'],
    ['/en/basel-articles/bale-moustique-tigre-quatre-semaines/', '/en/basel-articles/basel-tiger-mosquito-four-weeks/'],
    ['/fr/articles-bale/basel-tiger-mosquito-four-weeks/', '/fr/articles-bale/bale-moustique-tigre-quatre-semaines/'],
  ])('resolves the exact same canton article in the requested language: %s', (from, target) => {
    expect(articleAliasTarget(from, cantonRegistry)).toBe(target);
  });

  it.each([cantonTarget, '/de/basel-artikel/unknown/', '/de/basel-artikel/',
    '/de/basel-artikel/basilea-larvicida-quattro-settimane/extra/',
    '/de/jura-artikel/basilea-larvicida-quattro-settimane/', '/de/unknown-artikel/basilea-larvicida-quattro-settimane/'])
  ('does not invent an identity or cross canton boundaries: %s', (from) => {
    expect(articleAliasTarget(from, cantonRegistry)).toBeNull();
  });

  it('rejects collisions with another id or translation and missing or unsafe targets', () => {
    const rows = cantonRegistry.cantons['canton-basilea'];
    for (const duplicate of [{ it: 'basilea-larvicida-quattro-settimane', de: 'other' },
      { en: 'basilea-larvicida-quattro-settimane', de: 'other' }]) {
      expect(articleAliasTarget(cantonFrom, { cantons: { 'canton-basilea': { ...rows, other: duplicate } } })).toBeNull();
    }
    for (const de of [undefined, '', '../outside', 'wrong?query', '%2foutside', 'wrong.html', 'wrong slug']) {
      expect(articleAliasTarget(cantonFrom, { cantons: { 'canton-basilea': {
        'basilea-larvicida-quattro-settimane': { de },
      } } })).toBeNull();
    }
  });

  it.each([404, 410])('returns 301 only after original R2 %s and positive destination R2 GET', async (current) => {
    const fetchMock = mockCanton({ current });
    const response = await worker.fetch(new Request(`${APEX}${cantonFrom}?utm_source=gsc`), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${cantonTarget}?utm_source=gsc`);
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.indexOf(`${CDN_BASE}${corpusSectionCdnKey(cantonFrom)}`))
      .toBeLessThan(urls.findIndex((url) => url.endsWith('/slugs.json')));
    expect(urls).toContain(`${CDN_BASE}${corpusSectionCdnKey(cantonTarget)}`);
    expect(urls).not.toContain(`${APEX}${cantonTarget}`);
  });

  it.each([404, 410])('keeps missing targets as 404: %s', async (target) => {
    mockCanton({ target });
    expect((await worker.fetch(new Request(`${APEX}${cantonFrom}`), {}, ctx)).status).toBe(404);
  });

  it.each([{ target: 503 }, { target: 429 }, { target: 302 }, { target: 'network' as const },
    { api: 503 }, { payload: '{' }, { payload: '{}' }, { payload: '{"cantons":{"canton-basilea":[]}}' }])
  ('keeps unavailable verification temporary: %j', async (options) => {
    mockCanton(options);
    const response = await worker.fetch(new Request(`${APEX}${cantonFrom}`), {}, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps a target-probe timeout temporary', async () => {
    vi.useFakeTimers();
    mockCanton({ target: 'timeout' });
    const pending = worker.fetch(new Request(`${APEX}${cantonFrom}`), {}, ctx);
    await vi.advanceTimersByTimeAsync(2500);
    expect((await pending).status).toBe(503);
  });

  it.each([
    { current: 200, expected: 200 }, { status: 'draft', expected: 404 },
    { status: 'retired', expected: 410 }, { gone: [cantonFrom], expected: 410 },
    { redirects: { [cantonFrom]: '/de/basel-artikel/' }, expected: 301 },
    { current: 503, expected: 503 },
  ])('preserves existing section ownership and responses: %j', async ({ expected, ...options }) => {
    const fetchMock = mockCanton(options);
    expect((await worker.fetch(new Request(`${APEX}${cantonFrom}`), {}, ctx)).status).toBe(expected);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/slugs.json'))).toBe(false);
  });

  it.each([{ gone: [cantonTarget] }, { redirects: { [cantonTarget]: '/de/basel-artikel/' } }])
  ('does not redirect to an explicitly withdrawn or moved destination: %j', async (options) => {
    const fetchMock = mockCanton(options);
    expect((await worker.fetch(new Request(`${APEX}${cantonFrom}`), {}, ctx)).status).toBe(404);
    expect(fetchMock.mock.calls.map(([input]) => String(input)))
      .not.toContain(`${CDN_BASE}${corpusSectionCdnKey(cantonTarget)}`);
  });

  it('keeps a healthy registry miss as 404', async () => {
    mockCanton();
    expect((await worker.fetch(new Request(`${APEX}/de/basel-artikel/unknown/`), {}, ctx)).status).toBe(404);
  });
});

describe('canton articles moved out of the legacy national namespace', () => {
  const legacyFrom = '/de/grenzgaenger-artikel/basilea-larvicida-quattro-settimane/';
  const combined = { ...registry, ...cantonRegistry };

  it.each([
    ['arbeitslosigkeit-zurich-rav-2026', 'zurich-artikel'],
    ['zuerich-mieten-umzug-karte', 'zurich-artikel'],
    ['winterthur-regierungsrat-lehrabschluesse', 'zurich-artikel'],
    ['genfer-wirtschaft-globale-erholung', 'genf-artikel'],
    ['grenzueberschreitende-kinderkrebsversorgung-genf', 'genf-artikel'],
    ['genf-stopp-autobahn-a412', 'genf-artikel'],
  ])('resolves the exact reported German slug %s to its actual canton', (slug, section) => {
    expect(articleAliasTarget(`/de/grenzgaenger-artikel/${slug}/`, combined)).toBe(`/de/${section}/${slug}/`);
  });

  it('resolves the exact reported Italian id to Vaud, not the national hub', () => {
    expect(articleAliasTarget('/articoli-frontaliere/cdhr-frontalieri-vaud-2026/', combined))
      .toBe('/articoli-vaud/cdhr-frontalieri-vaud-2026/');
  });

  it('rejects identities shared with another canton or the other national registry', () => {
    const baselRows = cantonRegistry.cantons['canton-basilea'];
    expect(articleAliasTarget(legacyFrom, { ...combined,
      cantons: { ...cantonRegistry.cantons, 'canton-ge': baselRows },
    })).toBeNull();
    expect(articleAliasTarget(legacyFrom, { ...combined,
      swiss: { 'basilea-larvicida-quattro-settimane': { de: 'different-national-article' } },
    })).toBeNull();
  });

  it('keeps a matching national identity ahead of canton relocation', () => {
    expect(articleAliasTarget(legacyFrom, { ...combined,
      blog: { 'basilea-larvicida-quattro-settimane': { de: 'national-article' } },
    })).toBe('/de/grenzgaenger-artikel/national-article/');
  });

  it.each([[404, 'GET'], [404, 'HEAD'], [410, 'GET'], [410, 'HEAD']] as const)
  ('verifies the live canton and R2 destination after a national origin %s: %s', async (current, method) => {
    const fetchMock = mockCanton({ current });
    const response = await worker.fetch(new Request(`${APEX}${legacyFrom}?utm_source=gsc`, { method }), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${cantonTarget}?utm_source=gsc`);
    expect(fetchMock.mock.calls.map(([input]) => String(input)))
      .toContain(`${CDN_BASE}${corpusSectionCdnKey(cantonTarget)}`);
  });

  it.each([{ status: 'draft' }, { status: 'retired' }, { gone: [cantonTarget] },
    { redirects: { [cantonTarget]: '/de/basel-artikel/' } }, { target: 404 }, { target: 410 }])
  ('does not revive unavailable or withdrawn canton content: %j', async (options) => {
    mockCanton(options);
    expect((await worker.fetch(new Request(`${APEX}${legacyFrom}`), {}, ctx)).status).toBe(404);
  });

  it('does not treat an unavailable destination section registry as permanent absence', async () => {
    const fetchMock = mockCanton();
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith('/edge/sections/registry.json')
      ? new Response('unavailable', { status: 503 }) : implementation(input, init));
    const response = await worker.fetch(new Request(`${APEX}${legacyFrom}`), {}, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
