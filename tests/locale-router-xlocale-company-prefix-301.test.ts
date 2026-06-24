/**
 * Cross-locale company-hub prefix recovery in the Cloudflare locale-router Worker.
 *
 * Company-hub URLs carry a LOCALIZED prefix on the last path segment
 * (IT azienda- / EN company- / DE unternehmen- / FR entreprise-). The build
 * emits each locale's hub ONLY under that locale's prefix, so a hub requested
 * with a foreign prefix — e.g. the IT `azienda-` prefix kept on an /fr
 * `trouver-emploi-*` route — is a hard origin 404. The Worker upgrades these to
 * a within-locale 301 that swaps ONLY the company prefix to the request
 * locale's canonical one, leaving the rest of the path byte-identical.
 *
 * The recovery runs only AFTER the canton-drift map miss, so a real job-detail
 * slug (tracked in /job-canon) is never hijacked. The mock therefore returns a
 * 404 origin and a missing map (the /job-canon/ shard 404s) for the
 * company-prefix cases, and a populated map for the no-hijack case.
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

const SLUG = 'azienda-amministrazione-cantonale-ticino';
const REST = 'amministrazione-cantonale-ticino';

describe('locale-router cross-locale company-prefix 301', () => {
  it('301s an /fr route carrying the IT azienda- prefix to entreprise-', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${SLUG}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-tessin/entreprise-${REST}/`);
  });

  it('301s an /de route carrying the IT azienda- prefix to unternehmen-', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-tessin/${SLUG}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/de/jobs-im-tessin/unternehmen-${REST}/`);
  });

  it('301s an /en route carrying the IT azienda- prefix to company-', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(new Request(`${APEX}/en/find-jobs-ticino/${SLUG}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/en/find-jobs-ticino/company-${REST}/`);
  });

  it('normalises any foreign prefix, not just the IT one (EN company- on /fr → entreprise-)', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/company-${REST}/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-tessin/entreprise-${REST}/`);
  });

  it('does NOT 301 when the prefix already matches the locale (loop guard → soft 404)', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/entreprise-${REST}/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });

  it('preserves the query string and hash on the 301', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/${SLUG}/?utm_source=x`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-tessin/entreprise-${REST}/?utm_source=x`);
  });

  it('never hijacks a real job slug that happens to start with a prefix word (canton-drift wins)', async () => {
    // A job-detail slug present in /job-canon must be canton-drift-recovered to
    // its mapped canonical, NOT prefix-swapped — recovery order guarantees this.
    mockFetch(404, { 'azienda-energetica-role-lugano': { fr: '/fr/trouver-emploi-tessin' } });

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-zurich/azienda-energetica-role-lugano/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/azienda-energetica-role-lugano/');
  });

  it('leaves a non-company orphan slug on the soft-404 path (no spurious 301)', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/developpeur-acme-lugano/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });
});
