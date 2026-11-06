/**
 * Legacy listing-pagination recovery in the Cloudflare locale-router Worker.
 *
 * The old listing URL format `/<locale>/<section>-<canton>/<filter>/page-<N>/`
 * (filter = the per-locale "all jobs" word: tutte/tutti · alle · tous/toutes ·
 * all) was retired; every `/page-N/` now hard-404s on origin. These are real
 * legacy listing pages (Google indexed the deep pagination), so the Worker 301s
 * them to the canton section root — always a live 200, never a 301→404. This
 * upgrades the previous behaviour, where the multi-segment pagination path fell
 * through public/404.html's single-segment job jobRe to spaRedirect → the
 * homepage. The recovery runs in the 404 branch after the canton-drift map miss
 * and the company/cluster fallbacks; its path shape (multi-segment, ends in
 * /page-N/) never collides with the single-segment job-detail recoveries.
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
 * request returns a 404 (canton-drift miss) so the pagination fallback is reached.
 */
function mockFetch(originStatus: number): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes('/job-canon/')) {
      return new Response('not found', { status: 404 });
    }
    return new Response(originStatus === 404 ? 'gh-pages-404' : 'ok', { status: originStatus });
  });
}

describe('locale-router legacy listing-pagination 301', () => {
  it('301s a /de /alle/page-N orphan to the DE canton section root', async () => {
    mockFetch(404);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/alle/page-868/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-im-tessin/');
  });

  it('301s a /fr /tous/page-N orphan to the FR canton section root', async () => {
    mockFetch(404);

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/tous/page-1138/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/');
  });

  it('301s an /en /all/page-N orphan to the EN canton section root', async () => {
    mockFetch(404);

    const res = await worker.fetch(
      new Request(`${APEX}/en/find-jobs-zurich/all/page-12/`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/');
  });

  it('preserves the query string and hash on the 301', async () => {
    mockFetch(404);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/alle/page-3/?utm_source=google#top`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-im-tessin/?utm_source=google#top');
  });

  it('does not redirect a real single-segment job-detail orphan (no false pagination match)', async () => {
    // A normal job slug (no /<filter>/page-N/ tail) must NOT be pagination-redirected;
    // it stays on the soft-404 path when not in the canon map.
    mockFetch(404);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/business-analyst-hitachi-energy-zurich/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });

  it('does not redirect a non-pagination /page-like segment with an unknown filter word', async () => {
    // Only the per-locale "all jobs" filter words gate the recovery; an arbitrary
    // intermediate segment must not be treated as pagination.
    mockFetch(404);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/finanz/page-3/`),
      {},
      ctx,
    );

    expect(res.status).toBe(404);
  });

  it('does not redirect a listing root that legitimately serves 200', async () => {
    // When origin serves the page (200), the Worker passes through untouched —
    // the recovery only runs in the 404 branch.
    mockFetch(200);

    const res = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/alle/page-2/`),
      {},
      ctx,
    );

    expect(res.status).toBe(200);
  });
});
