/**
 * Legacy related-search CLUSTER orphans in the Cloudflare locale-router Worker.
 *
 * Old per-canton cluster URLs (`/cerca-lavoro-<canton>/ricerca-<role>-svizzera/`)
 * were migrated to `/cerca-lavoro-svizzera/ricerca-<role>-<city>/`. The KNOWN
 * legacy URLs (data/search-cluster-301-map.json) are served by the origin as
 * compat bridges, so they never reach the Worker's 404 chain. The Worker used to
 * 301 every OTHER `ricerca-/search-/suche-/recherche-` slug to the national
 * board: any invented cluster URL became a 301 to a listing, a soft 404 for
 * Google. Unknown cluster slugs now answer 200 from the national board under an
 * explicit noindex (owner decision 2026-10-30: job pages link them), and stay a
 * real 404 with a localized page when the slug word is not the locale's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

/**
 * Mock fetch: the shard origin answers 404 for the orphan and 200
 * for every listing; the /job-canon/<sk>.json request returns `map` (200) or a
 * 404 when `map` is null (canton-drift miss).
 */
function mockFetch(map: Record<string, Record<string, string>> | null): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes('/job-canon/')) {
      return map
        ? new Response(JSON.stringify(map), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 });
    }
    // Section roots and boards (one segment after the locale) are live; any
    // deeper path, including Ticino's physical fan-out, is a gh-pages 404.
    const segs = new URL(u).pathname.split('/').filter(Boolean);
    const depth = /^(?:en|de|fr)$/.test(segs[0] ?? '') ? segs.length - 1 : segs.length;
    return depth > 1 ? new Response('gh-pages-404', { status: 404 }) : new Response('ok', { status: 200 });
  });
}

describe('locale-router unknown search-cluster slug', () => {
  it.each([
    ['/en/find-jobs-ticino/search-painter-switzerland/'],
    ['/de/jobs-im-tessin/suche-maler-schweiz/'],
    ['/fr/trouver-emploi-tessin/recherche-peintre-suisse/'],
    ['/cerca-lavoro-zurigo/ricerca-pittore-inesistente-svizzera/'],
  ])('%s is served from the board under noindex, with no redirect', async (path) => {
    mockFetch(null);

    const res = await worker.fetch(new Request(`${APEX}${path}?utm_source=google`), {}, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, follow');
  });

  it('keeps a real localized 404 when the slug word belongs to another locale', async () => {
    mockFetch(null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/ricerca-stipendio-pittore-svizzera/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('href="/fr/trouver-emploi-suisse/"');
    expect(html).not.toContain('location.replace');
  });

  it('never hijacks a real job slug in /job-canon (canton-drift 301 still wins)', async () => {
    mockFetch({ 'ricercatore-acme-lugano': { en: '/en/find-jobs-ticino' } });

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-zurich/ricercatore-acme-lugano/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-ticino/ricercatore-acme-lugano/');
  });
});
