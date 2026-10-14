// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOrphanQueryAliases } from '../scripts/lib/orphan-query-aliases.mjs';
// @ts-expect-error — standalone JavaScript Worker.
import worker, { orphanQueryAliasTarget } from '../infra/cloudflare-worker/locale-router.js';
const cluster = (canonicalSlug = 'rhb-jobs', query = 'jobs rhb', locale = 'de') => ({ locale, canonicalSlug, canonicalQuery: canonicalSlug.replaceAll('-', ' '), queries: [{ query }] });
const registry = { schema: 1, aliases: buildOrphanQueryAliases([cluster(), cluster('volg-jobs', 'jobs volg'), cluster('offerte', 'posti', 'it')]) };
beforeEach(() => vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('exact query variants within a known cluster', () => {
  it('uses only declared query membership, protecting canonicals and ambiguous variants', () => {
    expect(registry.aliases['/de/suche/jobs-rhb/']).toBe('/de/suche/rhb-jobs/');
    expect(registry.aliases['/de/suche/rhb-jobs/']).toBeUndefined();
    expect(buildOrphanQueryAliases([cluster(), cluster('other', 'jobs rhb')])['/de/suche/jobs-rhb/']).toBeUndefined();
    expect(buildOrphanQueryAliases([cluster(), cluster('jobs-rhb', 'other')])['/de/suche/jobs-rhb/']).toBeUndefined();
  });
  it('keeps explicit nursing aliases in the requested locale', () => {
    expect(orphanQueryAliasTarget('/de/suche/nursing-jobs/', registry)).toBe('/de/pflegejobs-schweiz/');
  });
  it.each(['/de/suche/unknown/', '/de/suche/jobs-rhb/more/', '/fr/recherche/jobs-rhb/'])('preserves unknown or wrong-domain paths: %s', (pathname) => {
    expect(orphanQueryAliasTarget(pathname, registry)).toBeNull();
  });
  it.each(['https://example.test/', '//example.test/', '/de/suche/../other/', '/en/search/rhb-jobs/', '/de/suche/rhb-jobs/?q=x'])('rejects unsafe or cross-locale targets: %s', (target) => {
    expect(orphanQueryAliasTarget('/de/suche/jobs-rhb/', { schema: 1, aliases: { '/de/suche/jobs-rhb/': target } })).toBeNull();
  });
  it.each(['/de/suche/jobs-rhb/', '/ricerca/posti/', '/de/suche/nursing-jobs/'])('returns 301 after origin 404 and verified same-language destination: %s', async (from) => {
    const target = registry.aliases[from];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/orphan-query-aliases.json') return new Response(JSON.stringify(registry));
      return new Response('page', { status: url.pathname === target ? 200 : 404 });
    });
    const response = await worker.fetch(new Request(`https://frontaliereticino.ch${from}?utm_source=gsc`), {}, { waitUntil: () => {} });
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${target}?utm_source=gsc`);
  });
  it.each([404, 410, 429, 503])('does not confuse a missing destination with unavailable verification (%s)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/orphan-query-aliases.json') return new Response(JSON.stringify(registry));
      return new Response('page', { status: url.pathname === '/de/suche/rhb-jobs/' ? status : 404 });
    });
    const response = await worker.fetch(new Request('https://frontaliereticino.ch/de/suche/jobs-rhb/'), {}, {});
    expect(response.status).toBe(status === 404 || status === 410 ? 404 : 503);
    expect(response.headers.get('Location')).toBeNull();
    if (response.status === 503) expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each(['network', 'bad-json', 'bad-schema', 'server'])('keeps a %s registry failure temporary', async (mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/orphan-query-aliases.json') {
        if (mode === 'network') throw new TypeError('Network unavailable');
        if (mode === 'bad-json') return new Response('{');
        if (mode === 'bad-schema') return Response.json({ schema: 1, aliases: [] });
        return new Response('unavailable', { status: 503 });
      }
      return new Response('missing', { status: 404 });
    });
    const response = await worker.fetch(new Request('https://frontaliereticino.ch/de/suche/jobs-rhb/'), {}, {});
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('does not turn a healthy-catalog miss into a server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return url.pathname === '/orphan-query-aliases.json'
        ? Response.json(registry) : new Response('missing', { status: 404 });
    });
    expect((await worker.fetch(new Request('https://frontaliereticino.ch/de/suche/unknown/'), {}, {})).status).toBe(404);
  });
});
