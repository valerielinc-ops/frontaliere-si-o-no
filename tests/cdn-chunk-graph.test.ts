import { describe, expect, it, vi } from 'vitest';
import {
  CDN_ASSETS_BASE,
  MAX_PURGE_URLS_PER_RUN,
  buildEntryPages,
  classifyEdgeVsOrigin,
  crawlChunkGraph,
  evaluateChunkGraph,
  extractAssetUrlsFromHtml,
  extractSitePaths,
  linkCheck,
  observe,
  parseModuleLinks,
  purgeUrlsInBatches,
  rotatingWindow,
} from '../scripts/ci/cdn-chunk-graph.mjs';
import { MAX_TARGETED_FILES } from '../scripts/lib/cf-purge-limits.mjs';

const A = (name: string) => `${CDN_ASSETS_BASE}${name}`;

describe('parseModuleLinks — the linking surface of a Rollup chunk', () => {
  it('reads every static import form from the prologue, after the mapDeps line', () => {
    const src = [
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["https://cdn.frontaliereticino.ch/assets/i18n.js","https://cdn.frontaliereticino.ch/assets/index.css"])))=>i.map(i=>d[i]);',
      'import{__vitePreload as u,useLocale as l}from"./i18n.js";import Yi from"./ArticleRailAdStack.js";import Dd,{b as c}from"./mixed.js";import*as NS from"./ns.js";import"./side-effect.js";(function(){',
      'const s="import{fake}from\\"./not-a-dep.js\\"";',
      'return import("./JobBoard.js")})();export{u as default,l as useLocale};',
    ].join('\n');
    const parsed = parseModuleLinks(src, A('index-entry.js'));
    const statics = parsed.imports.filter((r) => r.kind === 'static');
    expect(statics.map((r) => [r.url, r.names])).toEqual([
      [A('i18n.js'), ['__vitePreload', 'useLocale']],
      [A('ArticleRailAdStack.js'), ['default']],
      [A('mixed.js'), ['default', 'b']],
      [A('ns.js'), []],
      [A('side-effect.js'), []],
    ]);
    // A code sample inside a string literal is not a dependency.
    expect(parsed.imports.some((r) => r.url === A('not-a-dep.js') && r.kind === 'static')).toBe(false);
    expect(parsed.imports.find((r) => r.kind === 'dynamic')?.url).toBe(A('JobBoard.js'));
    // Vite's preload list: absolute CDN URLs, CSS included.
    expect(parsed.imports.filter((r) => r.kind === 'preload').map((r) => r.url)).toEqual([A('index.css')]);
    expect(parsed.exports.sort()).toEqual(['default', 'useLocale']);
  });

  it('reads re-exports, `export *` and declaration exports', () => {
    const src = 'export{a as b,c}from"./dep.js";export*from"./all.js";export*as ns from"./ns.js";export default 1;export const k=1;export function fn(){}';
    const parsed = parseModuleLinks(src, A('barrel.js'));
    const reexport = parsed.imports.find((r) => r.kind === 'reexport' && r.url === A('dep.js'));
    expect(reexport?.names).toEqual(['a', 'c']);
    expect(parsed.exportAll).toEqual([A('all.js')]);
    expect(parsed.exports.sort()).toEqual(['b', 'c', 'default', 'fn', 'k', 'ns'].sort());
  });

  it('keeps a stray relative literal as discovery-only (loose), and ignores foreign hosts', () => {
    const src = 'const w=new URL("./pdf.worker.mjs",import.meta.url);const x="https://example.com/assets/evil.js";export{w};';
    const parsed = parseModuleLinks(src, A('pdf.js'));
    expect(parsed.imports).toEqual([{ url: A('pdf.worker.mjs'), spec: './pdf.worker.mjs', names: [], kind: 'loose' }]);
  });
});

describe('HTML extraction', () => {
  it('collects every CDN JS/CSS asset and the same-site hrefs', () => {
    const html = `<link rel="modulepreload" href="https://cdn.frontaliereticino.ch/assets/App.js">
      <link rel="stylesheet" crossorigin href="https://cdn.frontaliereticino.ch/assets/index.css?v=1">
      <script type="module" crossorigin src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>
      <img src="https://cdn.frontaliereticino.ch/images/a.png">
      <a href="/cerca-lavoro-ticino/tutti/">x</a><a href="https://frontaliereticino.ch/en/">y</a><a href="//evil.example/">z</a>`;
    expect(extractAssetUrlsFromHtml(html).sort()).toEqual([A('App.js'), A('index-entry.js'), A('index.css')].sort());
    expect(extractSitePaths(html)).toEqual(['/cerca-lavoro-ticino/tutti/', '/en/']);
  });

  it('builds home, calculator, job board, job listing and article index for all four locales', () => {
    const pages = buildEntryPages();
    expect(new Set(pages.map((p) => p.locale))).toEqual(new Set(['it', 'en', 'de', 'fr']));
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(pages.filter((p) => p.locale === locale).map((p) => p.kind)).toEqual(['home', 'calculator', 'jobs', 'jobs-all', 'articles']);
    }
    const itAll = pages.find((p) => p.locale === 'it' && p.kind === 'jobs-all')!;
    // A job ad has no trailing slash; the listing and category pages do.
    expect(itAll.derive!.pattern.test('/cerca-lavoro-ticino/1-addetto-reparto-verifica-mendrisio')).toBe(true);
    expect(itAll.derive!.pattern.test('/cerca-lavoro-ticino/offerte-da-ieri/')).toBe(false);
    const deArticles = pages.find((p) => p.locale === 'de' && p.kind === 'articles')!;
    expect(deArticles.path).toBe('/de/grenzgaenger-artikel/');
    expect(deArticles.derive!.pattern.test('/de/grenzgaenger-artikel/bahn-umbau-arbeitsplaetze/')).toBe(true);
    expect(deArticles.derive!.pattern.test('/de/grenzgaenger-artikel/alle/')).toBe(false);
  });
});

describe('classifyEdgeVsOrigin', () => {
  const ok = (extra: Record<string, unknown>) => ({ status: 200, ok: true, ...extra });
  it('compares weak and strong ETags as the same validator', () => {
    expect(classifyEdgeVsOrigin(ok({ etag: 'W/"abc"' }), ok({ etag: '"abc"' }))).toBe('healthy');
    expect(classifyEdgeVsOrigin(ok({ etag: 'W/"old"' }), ok({ etag: 'W/"new"' }))).toBe('stale');
  });
  it('falls back to Last-Modified, then to the body hash', () => {
    expect(classifyEdgeVsOrigin(ok({ lastModified: 'Thu, 24 Sep 2026 21:21:49 GMT' }), ok({ lastModified: 'Fri, 25 Sep 2026 04:55:32 GMT' }))).toBe('stale');
    expect(classifyEdgeVsOrigin(ok({ hash: 'h' }), ok({ hash: 'h' }))).toBe('healthy');
    expect(classifyEdgeVsOrigin(ok({}), ok({}))).toBe('unverifiable');
  });
  it('separates HTTP failures from unanswered requests', () => {
    expect(classifyEdgeVsOrigin({ status: 404, ok: false }, ok({ etag: 'x' }))).toBe('cached_failure');
    expect(classifyEdgeVsOrigin(ok({ etag: 'x' }), { status: 404, ok: false })).toBe('fresh_failure');
    expect(classifyEdgeVsOrigin({ status: 404, ok: false }, { status: 404, ok: false })).toBe('unavailable');
    // A timeout says nothing about the cached copy: never "stale", never purged.
    expect(classifyEdgeVsOrigin({ status: 0, ok: false }, ok({ etag: 'x' }))).toBe('error');
    // Neither does a rate limit or a challenge aimed at the runner's IP.
    expect(classifyEdgeVsOrigin({ status: 429, ok: false }, ok({ etag: 'x' }))).toBe('error');
    expect(classifyEdgeVsOrigin({ status: 403, ok: false, mitigated: 'challenge' }, ok({ etag: 'x' }))).toBe('error');
  });
});

describe('observe', () => {
  it('retries a 429 (honouring a short Retry-After) and a 5xx, but not a 404', async () => {
    const answers = [429, 503, 200];
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      const status = answers.shift()!;
      const headers = new Map<string, string>(status === 429 ? [['retry-after', '3']] : [['etag', '"x"']]);
      return { ok: status === 200, status, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, async text() { return 'body'; } };
    });
    const obs = await observe(A('a.js'), { fetchImpl: fetchImpl as any, sleep: async (ms: number) => { sleeps.push(ms); } });
    expect(obs).toMatchObject({ status: 200, ok: true, etag: '"x"' });
    expect(sleeps[0]).toBe(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const notFound = vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, async text() { return ''; } }));
    expect((await observe(A('b.js'), { fetchImpl: notFound as any, sleep: async () => {} })).status).toBe(404);
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('sends Origin only for the browser variant and never asks for zstd', async () => {
    const seen: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      seen.push(init.headers);
      return { ok: true, status: 200, headers: { get: () => null }, async text() { return ''; } };
    });
    await observe(A('a.js'), { fetchImpl: fetchImpl as any, origin: 'https://frontaliereticino.ch' });
    await observe(A('a.js'), { fetchImpl: fetchImpl as any });
    expect(seen[0].Origin).toBe('https://frontaliereticino.ch');
    expect('Origin' in seen[1]).toBe(false);
    expect(seen.every((h) => !/zstd/.test(h['Accept-Encoding']))).toBe(true);
  });
});

describe('linkCheck', () => {
  const mod = (imports: any[], exports: string[] = [], exportAll: string[] = []) => ({ imports, exports, exportAll });

  it('flags the 2026-09-25 break: a new importer against an old exporter', () => {
    const modules = new Map([
      [A('JobBoard.js'), mod([{ url: A('shared-services.js'), names: ['JOBGATE_RC_KEYS', 'clearAssetCaches'], kind: 'static' }])],
      [A('shared-services.js'), mod([], ['clearAssetCaches'])],
    ]);
    const served = new Map([[A('JobBoard.js'), true], [A('shared-services.js'), true]]);
    expect(linkCheck(modules, served)).toEqual([
      { from: A('JobBoard.js'), to: A('shared-services.js'), name: 'JOBGATE_RC_KEYS', reason: 'missing_export' },
    ]);
  });

  it('resolves names through `export *` and ignores loose references', () => {
    const modules = new Map([
      [A('a.js'), mod([
        { url: A('barrel.js'), names: ['deep'], kind: 'static' },
        { url: A('gone.js'), names: [], kind: 'loose' },
      ])],
      [A('barrel.js'), mod([], [], [A('leaf.js')])],
      [A('leaf.js'), mod([], ['deep'])],
    ]);
    const served = new Map([[A('a.js'), true], [A('barrel.js'), true], [A('leaf.js'), true], [A('gone.js'), false]]);
    expect(linkCheck(modules, served)).toEqual([]);
  });

  it('reports a strongly referenced chunk that is not served, and skips unknown ones', () => {
    const modules = new Map([
      [A('a.js'), mod([
        { url: A('lazy.js'), names: [], kind: 'dynamic' },
        { url: A('timeout.js'), names: ['x'], kind: 'static' },
      ])],
    ]);
    // lazy.js answered 404; timeout.js never answered (absent from `served`).
    const served = new Map([[A('a.js'), true], [A('lazy.js'), false]]);
    expect(linkCheck(modules, served)).toEqual([
      { from: A('a.js'), to: A('lazy.js'), name: null, reason: 'missing_module' },
    ]);
  });
});

describe('rotatingWindow', () => {
  it('tiles the list so consecutive rotations cover every item once', () => {
    const items = Array.from({ length: 25 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const seen: string[] = [];
    const first = rotatingWindow(items, 10, 0);
    expect(first.windows).toBe(3);
    for (let r = 0; r < first.windows; r++) seen.push(...rotatingWindow(items, 10, 7 + r).picked);
    expect(seen.sort()).toEqual(items);
    expect(rotatingWindow(items.slice(0, 5), 10, 99).picked).toHaveLength(5);
  });
});

// ── A fake CDN + site ─────────────────────────────────────────────────────

type Answer = { status?: number; body?: string; etag?: string; lastModified?: string };

function fakeFetch(routes: (url: string, init: any) => Answer | undefined) {
  const calls: Array<{ url: string; method: string; origin: string | null }> = [];
  const impl = vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    const origin = init.headers?.Origin ?? null;
    calls.push({ url, method, origin });
    const answer = routes(url, init) ?? { status: 404, body: 'not found' };
    const status = answer.status ?? 200;
    const headers = new Map<string, string>();
    if (answer.etag) headers.set('etag', answer.etag);
    if (answer.lastModified) headers.set('last-modified', answer.lastModified);
    headers.set('cf-ray', '8c0000000000-ZRH');
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      async text() { return method === 'HEAD' ? '' : (answer.body ?? ''); },
    };
  });
  return { impl, calls };
}

const HOME_HTML = `<script type="module" crossorigin src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>
<link rel="stylesheet" crossorigin href="https://cdn.frontaliereticino.ch/assets/index.css">`;

const SOURCES: Record<string, { body: string; etag: string }> = {
  'index-entry.js': { body: 'import{clearAssetCaches as c}from"./shared-services.js";const j=()=>import("./JobBoard.js");export{c};', etag: 'W/"entry"' },
  'JobBoard.js': { body: 'import{JOBGATE_RC_KEYS as k,clearAssetCaches as c}from"./shared-services.js";export{k as keys};', etag: 'W/"jb-new"' },
  'shared-services.js': { body: 'const JOBGATE_RC_KEYS=1,clearAssetCaches=2;export{JOBGATE_RC_KEYS,clearAssetCaches};', etag: 'W/"ss-new"' },
  'index.css': { body: 'body{}', etag: 'W/"css"' },
};
// The July copy of shared-services the edge kept for the browser variant.
const STALE_SHARED = { body: 'const clearAssetCaches=2;export{clearAssetCaches};', etag: 'W/"ss-old"' };

function site({ staleBrowserShared = false } = {}) {
  return fakeFetch((url, init) => {
    if (url === 'https://frontaliereticino.ch/') return { body: HOME_HTML };
    if (!url.startsWith(CDN_ASSETS_BASE)) return undefined;
    const u = new URL(url);
    const name = u.pathname.replace('/assets/', '');
    const src = SOURCES[name];
    if (!src) return undefined;
    const isOrigin = u.searchParams.has('ft_reliability');
    if (!isOrigin && staleBrowserShared && name === 'shared-services.js' && init.headers?.Origin) return STALE_SHARED;
    return src;
  });
}

const ENTRY = [{ locale: 'it', kind: 'home', path: '/' }];

describe('crawlChunkGraph + evaluateChunkGraph on a fake CDN', () => {
  it('walks static and dynamic imports and finds a clean graph healthy', async () => {
    const { impl, calls } = site();
    const crawl = await crawlChunkGraph({ fetchImpl: impl as any, entryPages: ENTRY, nonce: 'n', sleep: async () => {} });
    expect(crawl.chunks.map((c: any) => c.path).sort()).toEqual(['/assets/JobBoard.js', '/assets/index-entry.js', '/assets/index.css', '/assets/shared-services.js']);
    expect(crawl.broken).toEqual([]);
    expect(crawl.namedImports).toEqual({ browser: 3, plain: 3 });
    const verdict = evaluateChunkGraph(crawl);
    expect(verdict).toMatchObject({ ok: true, purgeUrls: [], reasons: [] });
    // Edge read in both variants with GET, origin read with a cache-busted HEAD.
    const shared = calls.filter((c) => c.url.includes('shared-services.js'));
    expect(shared.filter((c) => c.method === 'GET' && c.origin === 'https://frontaliereticino.ch')).toHaveLength(1);
    expect(shared.filter((c) => c.method === 'GET' && c.origin === null && !c.url.includes('ft_reliability'))).toHaveLength(1);
    expect(shared.filter((c) => c.method === 'HEAD' && c.url.includes('ft_reliability=n'))).toHaveLength(1);
  });

  it('catches the stale browser-variant exporter, the broken import, and selects only that URL for purge', async () => {
    const { impl } = site({ staleBrowserShared: true });
    const crawl = await crawlChunkGraph({ fetchImpl: impl as any, entryPages: ENTRY, nonce: 'n', sleep: async () => {} });
    const shared = crawl.chunks.find((c: any) => c.path === '/assets/shared-services.js');
    expect(shared.states).toEqual({ browser: 'stale', plain: 'healthy' });
    expect(crawl.broken).toEqual([
      { from: A('JobBoard.js'), to: A('shared-services.js'), name: 'JOBGATE_RC_KEYS', reason: 'missing_export', variant: 'browser' },
    ]);
    const verdict = evaluateChunkGraph(crawl);
    expect(verdict.ok).toBe(false);
    expect(verdict.purgeUrls).toEqual([A('shared-services.js')]);
    expect(verdict.reasons.join('\n')).toContain("/assets/JobBoard.js → /assets/shared-services.js lacks 'JOBGATE_RC_KEYS' (browser)");
    expect(verdict.reasons.join('\n')).toContain('browser variant 1, plain 0');
  });

  it('samples a content loader in rotating windows instead of walking all of it', async () => {
    const bodies: Record<string, string> = {
      'blogBodyLoader.js': Array.from({ length: 9 }, (_, i) => `()=>import("./a${i}.it.js")`).join(';') + ';export{x as load};',
    };
    for (let i = 0; i < 9; i++) bodies[`a${i}.it.js`] = `const e={};export{e as default};`;
    const { impl } = fakeFetch((url) => {
      if (url === 'https://frontaliereticino.ch/') return { body: '<script type="module" src="https://cdn.frontaliereticino.ch/assets/blogBodyLoader.js"></script>' };
      const name = new URL(url).pathname.replace('/assets/', '');
      return bodies[name] !== undefined ? { body: bodies[name], etag: `"${name}"` } : undefined;
    });
    const crawl = await crawlChunkGraph({
      fetchImpl: impl as any, entryPages: ENTRY, fanoutThreshold: 4, fanoutSample: 4, rotation: 1, sleep: async () => {},
    });
    expect(crawl.families).toEqual([{ loader: '/assets/blogBodyLoader.js', total: 9, sampled: 4, window: 1, windows: 3, rotation: 1 }]);
    expect(crawl.chunks.map((c: any) => c.path).sort()).toEqual(['/assets/a4.it.js', '/assets/a5.it.js', '/assets/a6.it.js', '/assets/a7.it.js', '/assets/blogBodyLoader.js']);
    expect(evaluateChunkGraph(crawl).ok).toBe(true);
  });

  it('never passes a truncated walk, a failed entry page or a crash for health', async () => {
    const { impl } = site();
    const crawl = await crawlChunkGraph({ fetchImpl: impl as any, entryPages: ENTRY, maxChunks: 2, sleep: async () => {} });
    expect(crawl.truncated).toBe(true);
    expect(evaluateChunkGraph(crawl).reasons.join('\n')).toContain('coverage truncated');

    const missing = await crawlChunkGraph({ fetchImpl: impl as any, entryPages: [{ locale: 'en', kind: 'home', path: '/en/' }], sleep: async () => {} });
    const verdict = evaluateChunkGraph(missing);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain('chunk graph entry /en/: HTTP 404');

    expect(evaluateChunkGraph({ entries: [], chunks: [], broken: [], error: 'boom' }).reasons).toEqual(['chunk graph: walk failed (boom)']);
  });
});

describe('evaluateChunkGraph — verdict details', () => {
  const rec = (path: string, states: any, strong = true) => ({ url: `https://cdn.frontaliereticino.ch${path}`, path, states, strong, variants: {}, origin: {} });
  const entry = { locale: 'it', kind: 'home', path: '/', status: 200, derived: null };

  it('ignores a discovery-only 404 but fails on a referenced chunk missing everywhere', () => {
    const verdict = evaluateChunkGraph({
      entries: [entry],
      chunks: [
        rec('/assets/pdf.worker.mjs', { browser: 'unavailable', plain: 'unavailable' }, false),
        rec('/assets/lazy.js', { browser: 'unavailable', plain: 'unavailable' }, true),
      ],
      broken: [],
    });
    expect(verdict.reasons).toEqual(['chunk graph: 1 referenced chunk(s) missing at edge and origin: /assets/lazy.js']);
    expect(verdict.purgeUrls).toEqual([]);
  });

  it('does not purge a chunk R2 no longer has, and reports it', () => {
    const verdict = evaluateChunkGraph({ entries: [entry], chunks: [rec('/assets/old.js', { browser: 'fresh_failure', plain: 'fresh_failure' })], broken: [] });
    expect(verdict.purgeUrls).toEqual([]);
    expect(verdict.reasons[0]).toContain('missing at origin (not purged)');
  });

  it('treats an entry the runner could not observe as coverage, not as a site failure', () => {
    const verdict = evaluateChunkGraph({
      entries: [entry, { ...entry, path: '/en/', status: 429, error: 'HTTP 429', inconclusive: true }],
      chunks: [rec('/assets/a.js', { browser: 'healthy', plain: 'healthy' })],
      broken: [],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toEqual(['chunk graph entry /en/: HTTP 429']);
  });

  it('fails an entry the CDN offload missed: no CDN asset, or same-origin /assets/ references', () => {
    const chunk = rec('/assets/main.js', { browser: 'healthy', plain: 'healthy' });
    const bare = evaluateChunkGraph({ entries: [{ path: '/it/', status: 200, inconclusive: false, assets: 0 }], chunks: [chunk], broken: [] });
    expect(bare.ok).toBe(false);
    expect(bare.reasons).toEqual(['chunk graph entry /it/: 200 without any CDN asset reference (CDN offload missing)']);
    const halfway = evaluateChunkGraph({
      entries: [{ ...entry, assets: 3, derived: { kind: 'article', path: '/articoli-frontaliere/a-b-c/', status: 200, assets: 1, sameOriginAssets: 2 } }],
      chunks: [chunk],
      broken: [],
    });
    expect(halfway.reasons).toEqual(['chunk graph entry /articoli-frontaliere/a-b-c/: 2 same-origin /assets/ reference(s) (CDN offload missing)']);
  });

  it('counts same-origin /assets/ references while crawling an entry page', async () => {
    const html = '<script type="module" src="/assets/index-entry.js"></script><link rel="stylesheet" href="/assets/index.css">';
    const { impl } = fakeFetch((url) => (url === 'https://frontaliereticino.ch/' ? { body: html } : undefined));
    const crawl = await crawlChunkGraph({ fetchImpl: impl as any, entryPages: ENTRY, sleep: async () => {} });
    expect(crawl.entries[0]).toMatchObject({ assets: 0, sameOriginAssets: 2 });
    expect(evaluateChunkGraph(crawl).ok).toBe(false);
  });

  it('keeps a missing derived page to a coverage warning', () => {
    const verdict = evaluateChunkGraph({
      entries: [{ ...entry, derived: { kind: 'job-ad', path: null, status: 0, error: 'no matching link on the page' } }],
      chunks: [rec('/assets/a.js', { browser: 'healthy', plain: 'healthy' })],
      broken: [],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toEqual(['chunk graph: no job-ad checked from / (no matching link on the page)']);
  });

  it('purges chunks on a broken link first and caps the list per run', () => {
    const chunks = Array.from({ length: MAX_PURGE_URLS_PER_RUN + 5 }, (_, i) => rec(`/assets/c${i}.js`, { browser: 'stale', plain: 'healthy' }));
    const last = chunks[chunks.length - 1];
    const verdict = evaluateChunkGraph({
      entries: [entry],
      chunks,
      broken: [{ from: 'https://cdn.frontaliereticino.ch/assets/x.js', to: last.url, name: 'k', reason: 'missing_export', variant: 'browser' }],
    });
    expect(verdict.purgeUrls[0]).toBe(last.url);
    expect(verdict.purgeUrls).toHaveLength(MAX_PURGE_URLS_PER_RUN);
    expect(verdict.warnings.join('\n')).toContain('over the 3000-URL purge ceiling');
  });

  it('tolerates a few unanswered requests but not a blind walk', () => {
    const few = evaluateChunkGraph({ entries: [entry], chunks: [rec('/assets/a.js', { browser: 'error', plain: 'healthy' })], broken: [] });
    expect(few.ok).toBe(true);
    expect(few.warnings[0]).toContain('could not be observed');
    const many = evaluateChunkGraph({ entries: [entry], chunks: Array.from({ length: 10 }, (_, i) => rec(`/assets/e${i}.js`, { browser: 'error', plain: 'error' })), broken: [] });
    expect(many.ok).toBe(false);
  });
});

describe('purgeUrlsInBatches', () => {
  it('splits into batches within the Cloudflare cap and goes through cf-purge-cache.mjs --files=', () => {
    const urls = Array.from({ length: 65 }, (_, i) => A(`c${i}.js`));
    const exec = vi.fn();
    const outcome = purgeUrlsInBatches([...urls, urls[0]], { exec });
    expect(MAX_TARGETED_FILES).toBe(30);
    expect(outcome).toEqual({ batches: 3, purged: 65, failed: [] });
    const lists = exec.mock.calls.map(([args]) => {
      expect(args[0]).toMatch(/scripts\/cf-purge-cache\.mjs$/);
      expect(args[1].startsWith('--files=')).toBe(true);
      return args[1].slice('--files='.length).split(',');
    });
    expect(lists.map((l) => l.length)).toEqual([30, 30, 5]);
    expect(lists.flat()).toEqual(urls);
  });

  it('records a failed batch and keeps purging the rest', () => {
    let n = 0;
    const exec = vi.fn(() => { if (n++ === 0) throw new Error('HTTP 429'); });
    const outcome = purgeUrlsInBatches(Array.from({ length: 31 }, (_, i) => A(`c${i}.js`)), { exec });
    expect(outcome.batches).toBe(2);
    expect(outcome.purged).toBe(1);
    expect(outcome.failed).toEqual([{ index: 0, error: 'HTTP 429' }]);
  });

  it('never asks for more than the cap even if a caller does', () => {
    const exec = vi.fn();
    purgeUrlsInBatches(Array.from({ length: 40 }, (_, i) => A(`c${i}.js`)), { exec, size: 100 });
    expect(exec.mock.calls.map(([args]) => args[1].split(',').length)).toEqual([30, 10]);
  });
});
