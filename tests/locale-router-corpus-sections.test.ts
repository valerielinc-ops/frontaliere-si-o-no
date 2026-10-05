/**
 * Canton article sections served by the CORPUS from R2 (piano «sezioni
 * articoli per cantone», S2): `serveCorpusSection` / `serveCorpusEdgeFile` in
 * infra/cloudflare-worker/locale-router.js.
 *
 * The Worker deploys by itself on merge (deploy-worker.yml), so the contract
 * these tests pin is, first of all, FAIL-CLOSED: until the registry published
 * by the corpus declares a section `live`, every canton URL must be answered
 * exactly as before this branch existed — and every URL that is not a canton
 * section (article shards, job shards) must not even notice it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, * as router from '../infra/cloudflare-worker/locale-router.js';
import { CANTON_ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import {
  apexPurgeBlindSpots,
  corpusEdgeUrlForApexUrl,
  readWorkerRoutePatterns,
  shardOriginForApexUrl,
  workerRouteForUrl,
} from '../scripts/lib/cf-worker-routes.mjs';

const {
  CORPUS_CANTON_SECTION_SLUGS,
  CORPUS_SECTION_ROUTES,
  CORPUS_NOT_FOUND_CACHE_CONTROL,
  CORPUS_PAGE_CACHE_CONTROL,
  CORPUS_REGISTRY_TTL_MS,
  SECTION_ROUTES,
  __resetCorpusRegistryForTests,
  corpusEdgeFileForPath,
  loadCorpusSectionRegistry,
  matchCorpusSection,
  parseCorpusSectionRegistry,
} = router;

const APEX = 'https://frontaliereticino.ch';
const CDN = 'https://cdn.frontaliereticino.ch';
const REGISTRY_URL = `${CDN}/edge/sections/registry.json`;
const COMMIT = 'e351f2d7f1a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

type Section = { status: string; redirects?: Record<string, string>; gone?: string[] };
type FetchPlan = {
  /** Registry body; `null` → 404; a number → that status. */
  registry?: unknown;
  /** CDN objects by pathname (`/edge/...`) → body; missing → 404. */
  objects?: Record<string, string>;
  /** CDN object status override by pathname. */
  objectStatus?: Record<string, number>;
};

let fetched: string[];

function registry(sections: Record<string, Section>, extra: Record<string, unknown> = {}) {
  return { schema: 1, commit: COMMIT, sections, ...extra };
}

function mockFetch(plan: FetchPlan) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(reqUrl);
    const u = new URL(reqUrl);
    if (reqUrl === REGISTRY_URL) {
      if (plan.registry === undefined || plan.registry === null) return new Response('nope', { status: 404 });
      if (typeof plan.registry === 'number') return new Response('err', { status: plan.registry });
      return new Response(JSON.stringify(plan.registry), { status: 200 });
    }
    if (u.hostname === 'cdn.frontaliereticino.ch') {
      const status = plan.objectStatus?.[u.pathname];
      if (status) return new Response('x', { status });
      const body = plan.objects?.[u.pathname];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
    }
    // Any shard / apex origin: answer like GitHub Pages does for a path it
    // does not have, tagged with the host so the test can see who answered.
    return new Response(`origin:${u.hostname}`, { status: 404 });
  });
}

const cdnFetches = () => fetched.filter((u) => u.startsWith(CDN));
const registryFetches = () => fetched.filter((u) => u === REGISTRY_URL);
const get = (p: string, init?: RequestInit) => worker.fetch(new Request(`${APEX}${p}`, init), {}, ctx);

beforeEach(() => {
  fetched = [];
  __resetCorpusRegistryForTests();
  const store = new Map<string, Response>();
  // Plain functions, not vi.fn: tests call vi.restoreAllMocks() mid-way to
  // swap the fetch plan, and the colo cache must survive that.
  const cache = {
    match: async (req: Request) => store.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => {
      store.set(req.url, res.clone());
    },
  };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe('closed set: the Worker table mirrors the generated section core', () => {
  it('has exactly the 24 canton sections with the core indexSlug in every locale', () => {
    const fromCore = Object.fromEntries(
      Object.entries(CANTON_ARTICLE_SECTION_CORE).map(([id, e]) => [id, { ...e.indexSlug }]),
    );
    expect(CORPUS_CANTON_SECTION_SLUGS).toEqual(fromCore);
    expect(Object.keys(CORPUS_CANTON_SECTION_SLUGS)).toHaveLength(24);
    expect(CORPUS_SECTION_ROUTES).toHaveLength(96);
  });

  it('IT prefixes sit at the apex, the other locales under their prefix', () => {
    const ti = CORPUS_SECTION_ROUTES.filter((r: { section: string }) => r.section === 'canton-ti');
    expect(ti.map((r: { prefix: string }) => r.prefix).sort()).toEqual(
      ['/articoli-ticino', '/de/tessin-artikel', '/en/ticino-articles', '/fr/articles-tessin'],
    );
  });

  it('never overlaps a shard section prefix (articles or jobs)', () => {
    for (const c of CORPUS_SECTION_ROUTES) {
      for (const s of SECTION_ROUTES) {
        expect(c.prefix === s.prefix || c.prefix.startsWith(`${s.prefix}/`) || s.prefix.startsWith(`${c.prefix}/`)).toBe(false);
      }
    }
  });

  it('matches root, .html flat form and deep paths, never look-alikes', () => {
    expect(matchCorpusSection('/articoli-ticino')?.section).toBe('canton-ti');
    expect(matchCorpusSection('/articoli-ticino.html')?.section).toBe('canton-ti');
    expect(matchCorpusSection('/de/tessin-artikel/treibstoff/')?.locale).toBe('de');
    expect(matchCorpusSection('/articoli-ticino-altro/')).toBeNull();
    expect(matchCorpusSection('/articoli-frontaliere/')).toBeNull();
    expect(matchCorpusSection('/cerca-lavoro-ticino/')).toBeNull();
  });
});

describe('registry validation (schema 1)', () => {
  it('accepts a well-formed registry', () => {
    const r = parseCorpusSectionRegistry(
      registry({
        'canton-ti': {
          status: 'live',
          redirects: { '/articoli-ticino/vecchio/': '/articoli-ticino/nuovo/' },
          gone: ['/en/ticino-articles/old-one/'],
        },
        'canton-gr': { status: 'draft' },
      }),
    );
    expect(r?.commit).toBe(COMMIT);
    expect(r?.sections['canton-ti'].redirects.get('/articoli-ticino/vecchio/')).toBe('/articoli-ticino/nuovo/');
    expect(r?.sections['canton-ti'].gone.has('/en/ticino-articles/old-one/')).toBe(true);
  });

  it.each(['/', '/de/', '/articoli-svizzera/', '/en/ticino-articles/fuel/'])(
    'accepts the same-origin redirect target %s',
    (target) => {
      const r = parseCorpusSectionRegistry(
        registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/vecchio/': target } } }),
      );
      expect(r?.sections['canton-ti'].redirects.get('/articoli-ticino/vecchio/')).toBe(target);
    },
  );

  it.each([
    ['not an object', null],
    ['wrong schema', { ...registry({}), schema: 2 }],
    ['missing commit', { schema: 1, sections: {} }],
    ['commit not a sha', { ...registry({}), commit: 'main' }],
    ['sections not an object', { ...registry({}), sections: [] }],
    ['unknown section id', registry({ 'canton-xx': { status: 'live' } })],
    ['historical section id', registry({ frontaliere: { status: 'live' } })],
    ['unknown status', registry({ 'canton-ti': { status: 'published' } })],
    ['redirect source outside the section', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-grigioni/x/': '/' } } })],
    ['redirect source not canonical', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x': '/' } } })],
    ['open redirect target', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x/': '//evil.example/' } } })],
    ['absolute URL target', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x/': 'https://evil.example/' } } })],
    ['protocol-relative root target', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x/': '//' } } })],
    ['target without trailing slash', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x/': '/de' } } })],
    ['self redirect', registry({ 'canton-ti': { status: 'live', redirects: { '/articoli-ticino/x/': '/articoli-ticino/x/' } } })],
    ['gone not an array', registry({ 'canton-ti': { status: 'live', gone: '/articoli-ticino/x/' } as unknown as Section })],
    ['gone outside the section', registry({ 'canton-ti': { status: 'live', gone: ['/articoli-frontaliere/x/'] } })],
  ])('rejects %s as a whole', (_label, raw) => {
    expect(parseCorpusSectionRegistry(raw)).toBeNull();
  });
});

describe('FAIL-CLOSED: nothing changes until the registry declares a section live', () => {
  it.each([
    ['no registry published yet (404)', null],
    ['registry fetch 5xx', 503],
    ['invalid registry', { schema: 1, sections: {} }],
    ['section absent from the registry', registry({ 'canton-gr': { status: 'live' } })],
    ['section still draft', registry({ 'canton-ti': { status: 'draft' } })],
  ])('%s → IT path falls through to the apex passthrough', async (_label, reg) => {
    mockFetch({ registry: reg, objects: { '/edge/sections/articoli-ticino/index.html': '<html>corpus</html>' } });
    const res = await get('/articoli-ticino/');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('origin:frontaliereticino.ch');
    // The R2 page is never read for a section that is not live.
    expect(cdnFetches().filter((u) => u.includes('/edge/sections/articoli-'))).toEqual([]);
  });

  it('en/de/fr paths of a non-live section still reach their locale shard as before', async () => {
    mockFetch({ registry: registry({ 'canton-ti': { status: 'draft' } }) });
    for (const [p, host] of [
      ['/en/ticino-articles/', 'origin-en.frontaliereticino.ch'],
      ['/de/tessin-artikel/treibstoff/', 'origin-de.frontaliereticino.ch'],
      ['/fr/articles-tessin/un-article/', 'origin-fr.frontaliereticino.ch'],
    ]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(`origin:${host}`);
      // Same 404 Cache-Control the locale shard always stamped.
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
    }
  });

  it('a non-live section stays 404 even when its R2 objects already exist (pre-staged bootstrap)', async () => {
    mockFetch({
      registry: registry({ 'canton-ti': { status: 'draft' } }),
      objects: { '/edge/sections/en/ticino-articles/index.html': '<html>staged</html>' },
    });
    const res = await get('/en/ticino-articles/');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('staged');
  });

  it('POST and other methods are never handled by the corpus branch', async () => {
    mockFetch({ registry: registry({ 'canton-ti': { status: 'live' } }) });
    const res = await get('/articoli-ticino/', { method: 'POST', body: 'x' });
    expect(await res.text()).toBe('origin:frontaliereticino.ch');
    expect(registryFetches()).toEqual([]);
  });
});

describe('NO REGRESSION on the URLs that exist today', () => {
  beforeEach(() => {
    // A LIVE registry for every canton: the worst case for a regression — the
    // existing sections must still not be touched by it.
    const all = Object.fromEntries(Object.keys(CORPUS_CANTON_SECTION_SLUGS).map((id) => [id, { status: 'live' }]));
    mockFetch({ registry: registry(all) });
  });

  it.each([
    ['/articoli-frontaliere/', 'origin-articolifrontaliere-it.frontaliereticino.ch'],
    ['/articoli-frontaliere/un-articolo/', 'origin-articolifrontaliere-it.frontaliereticino.ch'],
    ['/articoli-svizzera/', 'origin-articolisvizzera-it.frontaliereticino.ch'],
    ['/articoli-svizzera/tutti/', 'origin-articolisvizzera-it.frontaliereticino.ch'],
    ['/en/cross-border-articles/x/', 'origin-articolifrontaliere-en.frontaliereticino.ch'],
    ['/de/schweiz-artikel/', 'origin-articolisvizzera-de.frontaliereticino.ch'],
    ['/fr/articles-suisse/x/', 'origin-articolisvizzera-fr.frontaliereticino.ch'],
    ['/fr/articles-frontalier/', 'origin-articolifrontaliere-fr.frontaliereticino.ch'],
  ])('article section %s still goes to its shard, registry untouched', async (p, host) => {
    const res = await get(p);
    expect(await res.text()).toBe(`origin:${host}`);
    expect(registryFetches()).toEqual([]);
  });

  it.each([
    ['/cerca-lavoro-ticino/', 'origin-ticino-it.frontaliereticino.ch'],
    ['/cerca-lavoro-ticino/un-lavoro-abc123/', 'origin-ticino-it.frontaliereticino.ch'],
    ['/cerca-lavoro-grigioni/', 'origin-grigioni-it.frontaliereticino.ch'],
    ['/cerca-lavoro-san-gallo/', 'origin-sangallo-it.frontaliereticino.ch'],
    ['/en/find-jobs-ticino/', 'origin-ticino-en.frontaliereticino.ch'],
    ['/de/jobs-im-tessin/x/', 'origin-ticino-de.frontaliereticino.ch'],
    ['/fr/trouver-emploi-bale/', 'origin-basilea-fr.frontaliereticino.ch'],
  ])('canton job page %s still goes to its job shard, registry untouched', async (p, host) => {
    const res = await get(p);
    expect(await res.text()).toBe(`origin:${host}`);
    expect(registryFetches()).toEqual([]);
  });

  it.each([
    ['/articoli-ticino-altro/', 'frontaliereticino.ch'],
    ['/articoli-qualcosa/', 'frontaliereticino.ch'],
    ['/en/', 'origin-en.frontaliereticino.ch'],
    ['/en/ticino-articles-old/', 'origin-en.frontaliereticino.ch'],
  ])('look-alike / unrelated path %s keeps its old origin, registry untouched', async (p, host) => {
    const res = await get(p);
    expect(await res.text()).toBe(`origin:${host}`);
    expect(registryFetches()).toEqual([]);
  });
});

describe('live section: pages from R2', () => {
  const live = registry({
    'canton-ti': {
      status: 'live',
      redirects: { '/articoli-ticino/vecchio-slug/': '/articoli-ticino/nuovo-slug/' },
      gone: ['/articoli-ticino/ritirato/'],
    },
    'canton-be': { status: 'retired', redirects: { '/de/bern-artikel/x/': '/de/schweiz-artikel/' } },
  });
  const objects = {
    '/edge/sections/articoli-ticino/index.html': '<html>landing TI</html>',
    '/edge/sections/en/ticino-articles/fuel/index.html': '<html>hub fuel</html>',
    '/edge/sections/articoli-ticino/un-articolo/index.html': '<html>articolo</html>',
  };

  it('serves the landing with a short Cache-Control (not the 6h of shard pages)', async () => {
    mockFetch({ registry: live, objects });
    const res = await get('/articoli-ticino/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>landing TI</html>');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe(CORPUS_PAGE_CACHE_CONTROL);
    const maxAge = Number(/max-age=(\d+)/.exec(CORPUS_PAGE_CACHE_CONTROL)?.[1]);
    expect(maxAge).toBeLessThan(21600);
    expect(cdnFetches()).toContain(`${CDN}/edge/sections/articoli-ticino/index.html`);
  });

  it('serves hubs and articles in every locale from edge/sections/<path>/index.html', async () => {
    mockFetch({ registry: live, objects });
    expect(await (await get('/en/ticino-articles/fuel/')).text()).toBe('<html>hub fuel</html>');
    expect(await (await get('/articoli-ticino/un-articolo/')).text()).toBe('<html>articolo</html>');
  });

  it('HEAD answers the same status without a body', async () => {
    mockFetch({ registry: live, objects });
    const res = await get('/articoli-ticino/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it.each([
    ['/articoli-ticino', '/articoli-ticino/'],
    ['/articoli-ticino.html', '/articoli-ticino/'],
    ['/articoli-ticino/un-articolo', '/articoli-ticino/un-articolo/'],
    ['/articoli-ticino/un-articolo.html', '/articoli-ticino/un-articolo/'],
    ['/articoli-ticino/un-articolo/index.html', '/articoli-ticino/un-articolo/'],
  ])('%s → 301 to the canonical directory form %s', async (from, to) => {
    mockFetch({ registry: live, objects });
    const res = await get(`${from}?utm_source=x`);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${to}?utm_source=x`);
  });

  it('an R2 miss is a REAL 404 + noindex with a short negative TTL', async () => {
    mockFetch({ registry: live, objects });
    const res = await get('/articoli-ticino/non-esiste/');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toBe(CORPUS_NOT_FOUND_CACHE_CONTROL);
    const sMax = Number(/s-maxage=(\d+)/.exec(CORPUS_NOT_FOUND_CACHE_CONTROL)?.[1]);
    expect(sMax).toBeLessThanOrEqual(300);
    const body = await res.text();
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(body).toContain('href="/articoli-ticino/"');
  });

  it('a path no publisher could have written is a 404 without a subrequest', async () => {
    mockFetch({ registry: live, objects });
    for (const p of ['/articoli-ticino/Maiuscolo/', '/articoli-ticino/a%20b/', '/articoli-ticino/a/b/c/d/e/']) {
      fetched = [];
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(cdnFetches().filter((u) => u.endsWith('/index.html'))).toEqual([]);
    }
  });

  it('an R2 5xx serves the last good copy (stale-if-error), else 503 — never a cached 404', async () => {
    mockFetch({ registry: live, objects });
    const ok = await get('/articoli-ticino/');
    expect(ok.status).toBe(200);
    vi.restoreAllMocks();
    mockFetch({ registry: live, objectStatus: { '/edge/sections/articoli-ticino/index.html': 502, '/edge/sections/articoli-ticino/altro/index.html': 502 } });
    const stale = await get('/articoli-ticino/');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Served-Stale')).toBe('corpus-502');
    const none = await get('/articoli-ticino/altro/');
    expect(none.status).toBe(503);
    expect(none.headers.get('Cache-Control')).toBe('no-store');
  });

  it('registry redirects are 301s and gone paths are 410 + noindex', async () => {
    mockFetch({ registry: live, objects });
    const moved = await get('/articoli-ticino/vecchio-slug/');
    expect(moved.status).toBe(301);
    expect(moved.headers.get('Location')).toBe('/articoli-ticino/nuovo-slug/');
    const gone = await get('/articoli-ticino/ritirato/');
    expect(gone.status).toBe(410);
    expect(gone.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('a retired section answers 410 everywhere except its declared redirects', async () => {
    mockFetch({ registry: live, objects });
    expect((await get('/articoli-berna/')).status).toBe(410);
    expect((await get('/en/bern-articles/anything/')).status).toBe(410);
    const moved = await get('/de/bern-artikel/x/');
    expect(moved.status).toBe(301);
    expect(moved.headers.get('Location')).toBe('/de/schweiz-artikel/');
  });
});

describe('registry memo and last-known-good', () => {
  it('fetches the registry once per TTL across many requests', async () => {
    mockFetch({ registry: registry({ 'canton-ti': { status: 'live' } }), objects: {} });
    await Promise.all([get('/articoli-ticino/a/'), get('/articoli-ticino/b/'), get('/en/ticino-articles/')]);
    await get('/articoli-ticino/c/');
    expect(registryFetches()).toHaveLength(1);
  });

  it('keeps serving the last-known-good registry when a refresh fails or is invalid', async () => {
    const t0 = 1_800_000_000_000;
    mockFetch({ registry: registry({ 'canton-ti': { status: 'live' } }) });
    expect((await loadCorpusSectionRegistry(t0))?.sections['canton-ti'].status).toBe('live');

    vi.restoreAllMocks();
    mockFetch({ registry: 500 });
    const afterError = await loadCorpusSectionRegistry(t0 + CORPUS_REGISTRY_TTL_MS + 1);
    expect(afterError?.sections['canton-ti'].status).toBe('live');

    vi.restoreAllMocks();
    mockFetch({ registry: { schema: 99 } });
    const afterInvalid = await loadCorpusSectionRegistry(t0 + 10 * CORPUS_REGISTRY_TTL_MS);
    expect(afterInvalid?.sections['canton-ti'].status).toBe('live');
  });

  it('picks up a newer valid registry once the TTL expires (draft → live)', async () => {
    const t0 = 1_800_000_000_000;
    mockFetch({ registry: registry({ 'canton-ti': { status: 'draft' } }) });
    expect((await loadCorpusSectionRegistry(t0))?.sections['canton-ti'].status).toBe('draft');
    vi.restoreAllMocks();
    mockFetch({ registry: registry({ 'canton-ti': { status: 'live' } }) });
    expect((await loadCorpusSectionRegistry(t0 + 1000))?.sections['canton-ti'].status).toBe('draft');
    expect((await loadCorpusSectionRegistry(t0 + CORPUS_REGISTRY_TTL_MS + 1))?.sections['canton-ti'].status).toBe('live');
  });
});

describe('corpus sitemaps: one regex rule against the closed set', () => {
  it('maps the index and the per-section sitemaps, nothing else', () => {
    expect(corpusEdgeFileForPath('/sitemap-cantons.xml')).toEqual({ cdnKey: '/edge/sitemap-cantons.xml', section: null });
    expect(corpusEdgeFileForPath('/sitemap-articles-canton-ti.xml')).toEqual({
      cdnKey: '/edge/sitemap-articles-canton-ti.xml',
      section: 'canton-ti',
    });
    expect(corpusEdgeFileForPath('/sitemap-articles-canton-xx.xml')).toBeNull();
    expect(corpusEdgeFileForPath('/sitemap-articles-archive.xml')).toBeNull();
    expect(corpusEdgeFileForPath('/sitemap-articles-canton-ti.xml.bak')).toBeNull();
  });

  it('serves the index from R2 when published, 404 short TTL when not (robots.txt-safe)', async () => {
    mockFetch({ objects: { '/edge/sitemap-cantons.xml': '<sitemapindex/>' } });
    const res = await get('/sitemap-cantons.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(await res.text()).toBe('<sitemapindex/>');

    vi.restoreAllMocks();
    mockFetch({});
    const missing = await get('/sitemap-cantons.xml');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe(CORPUS_NOT_FOUND_CACHE_CONTROL);
  });

  it('serves a section sitemap only while that section is live', async () => {
    const objects = { '/edge/sitemap-articles-canton-ti.xml': '<urlset/>' };
    mockFetch({ registry: registry({ 'canton-ti': { status: 'draft' } }), objects });
    expect((await get('/sitemap-articles-canton-ti.xml')).status).toBe(404);
    __resetCorpusRegistryForTests();
    vi.restoreAllMocks();
    mockFetch({ registry: registry({ 'canton-ti': { status: 'live' } }), objects });
    const res = await get('/sitemap-articles-canton-ti.xml');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<urlset/>');
  });

  it('/sitemap-articles-archive.xml keeps its exact EDGE_PUSHED_FILES entry', async () => {
    mockFetch({ objects: { '/edge/sitemap-articles-archive.xml': '<archive/>' } });
    const res = await get('/sitemap-articles-archive.xml');
    expect(await res.text()).toBe('<archive/>');
    expect(registryFetches()).toEqual([]);
  });
});

describe('wrangler routes and purge mapping', () => {
  const patterns = readWorkerRoutePatterns();
  const toml = readFileSync(path.resolve(__dirname, '..', 'infra', 'cloudflare-worker', 'wrangler.toml'), 'utf-8');

  it('routes every IT canton prefix (with or without a query string) to the Worker', () => {
    for (const r of CORPUS_SECTION_ROUTES.filter((x: { locale: string }) => x.locale === 'it')) {
      for (const suffix of ['/', '/x/?utm_source=a', '']) {
        expect(workerRouteForUrl(new URL(`${APEX}${r.prefix}${suffix}`), patterns), r.prefix).not.toBeNull();
      }
    }
  });

  it('declares the corpus sitemap routes with a wildcard', () => {
    expect(toml).toContain('{ pattern = "frontaliereticino.ch/articoli-*", zone_name');
    expect(toml).toContain('{ pattern = "frontaliereticino.ch/sitemap-cantons*", zone_name');
    expect(toml).toContain('{ pattern = "frontaliereticino.ch/sitemap-articles-*", zone_name');
  });

  it('keeps the explicit routes of the two historical article sections', () => {
    expect(patterns).toContain('frontaliereticino.ch/articoli-frontaliere*');
    expect(patterns).toContain('frontaliereticino.ch/articoli-svizzera*');
  });

  it('a canton section path is keyed on R2, never on a shard origin', () => {
    expect(shardOriginForApexUrl(new URL(`${APEX}/en/ticino-articles/x/`))).toBeNull();
    expect(shardOriginForApexUrl(new URL(`${APEX}/articoli-ticino/`))).toBeNull();
    expect(corpusEdgeUrlForApexUrl(new URL(`${APEX}/en/ticino-articles/x/`))).toBe(
      `${CDN}/edge/sections/en/ticino-articles/x/index.html`,
    );
    expect(corpusEdgeUrlForApexUrl(new URL(`${APEX}/sitemap-cantons.xml`))).toBe(`${CDN}/edge/sitemap-cantons.xml`);
    expect(corpusEdgeUrlForApexUrl(new URL(`${APEX}/articoli-frontaliere/`))).toBeNull();
  });

  it('an apex-only purge of a canton page is flagged with its R2 companion, and silent once paired', () => {
    const gaps = apexPurgeBlindSpots([`${APEX}/articoli-ticino/x/`]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].expectedCompanion).toBe(`${CDN}/edge/sections/articoli-ticino/x/index.html`);
    expect(
      apexPurgeBlindSpots([`${APEX}/articoli-ticino/x/`, `${CDN}/edge/sections/articoli-ticino/x/index.html`]),
    ).toEqual([]);
  });
});
