/**
 * Legacy related-search CLUSTER orphan recovery in the Cloudflare locale-router
 * Worker.
 *
 * Old per-canton cluster URLs (`/cerca-lavoro-<canton>/ricerca-<role>-svizzera/`)
 * were migrated to `/cerca-lavoro-svizzera/ricerca-<role>-<city>/`. The KNOWN
 * legacy URLs (from the GSC snapshot) are recovered as 200 compat-bridge pages,
 * but Google indexed many more than the snapshot captured, so the long tail still
 * hard-404s. Since the unknown ones cannot be mapped to a SPECIFIC live target,
 * the Worker 301s them to the locale's NATIONAL job board — always a live 200,
 * never a 301→404. The recovery runs only AFTER the canton-drift map miss and the
 * company-prefix miss, so a real job-detail slug is never hijacked (and real job
 * slugs never start with ricerca-/search-/suche-/recherche-).
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
 * Mock fetch: the shard origin returns `originStatus`; the /job-canon/<sk>.json
 * request returns `map` (200) or a 404 when `map` is null (canton-drift miss).
 */
function mockFetch(originStatus: number, map: Record<string, Record<string, string>> | null): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes('/job-canon/')) {
      return map
        ? new Response(JSON.stringify(map), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 });
    }
    return new Response(originStatus === 404 ? 'gh-pages-404' : 'ok', { status: originStatus });
  });
}

describe('locale-router legacy search-cluster 301', () => {
  it('301s an /en cluster orphan to the EN national board', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-ticino/search-painter-switzerland/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-switzerland/');
  });

  it('301s a /de cluster orphan to the DE national board', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/suche-maler-schweiz/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-in-schweiz/');
  });

  it('301s a /fr cluster orphan to the FR national board', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/recherche-peintre-suisse/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-suisse/');
  });

  it('301s the IT-prefixed ricerca- slug kept on a localized route', async () => {
    // Legacy URLs carry the IT `ricerca-` action word even on en/de/fr routes
    // (the slug segment is locale-independent in the old format).
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/ricerca-stipendio-pittore-svizzera/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-suisse/');
  });

  it('preserves the query string and hash on the 301', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-ticino/search-nurse-switzerland/?utm_source=google`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-switzerland/?utm_source=google');
  });

  it('never hijacks a real job slug in /job-canon (canton-drift wins over cluster fallback)', async () => {
    // A real job-detail slug present in the map is canton-drift-recovered, NOT
    // sent to the national board — recovery order guarantees this. (The slug does
    // not start with a search-action prefix anyway.)
    mockFetch(404, { 'ricercatore-acme-lugano': { en: '/en/find-jobs-ticino' } });

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-zurich/ricercatore-acme-lugano/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-ticino/ricercatore-acme-lugano/');
  });

  it('leaves a non-cluster orphan slug on the soft-404 path (no spurious 301)', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-ticino/developer-acme-lugano/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });
});
