/**
 * Canton-drift 404 recovery in the Cloudflare locale-router Worker.
 *
 * A job slug is globally unique, but the canton (URL section) drifted between
 * crawls, orphaning the previously-indexed URL → 404. public/404.html recovers
 * these with a soft-404 + JS `location.replace`; the Worker upgrades the en/de/fr
 * shard traffic it already sees to a REAL HTTP 301 (full link-equity transfer)
 * when the slug is in /job-canon/<shard>.json. Unknown slugs keep the soft 404.
 *
 * The Worker fetches the shard origin (404 here) and then the map JSON from the
 * public apex; the mock dispatches on URL so each gets the right response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  // recoverCantonDriftOrphan never reads the Cache API, but the happy-path 200
  // branch does — provide a no-op shim so any code path is safe.
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

/**
 * Mock fetch: the shard origin (origin-{loc}.…) returns `originStatus`; a
 * /job-canon/<sk>.json request returns `map` (or 404 when map is null).
 */
function mockFetch(originStatus: number, map: Record<string, string> | null): void {
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

describe('locale-router canton-drift 301', () => {
  it('301s a known orphan slug to its current canonical page', async () => {
    mockFetch(404, { 'some-job-xyz': '/en/find-jobs-zurich' });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/some-job-xyz/');
  });

  it('preserves query + hash on the 301 Location', async () => {
    mockFetch(404, { 'some-job-xyz': '/en/find-jobs-zurich' });

    const res = await worker.fetch(
      new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/?utm=x#frag`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/some-job-xyz/?utm=x#frag');
  });

  it('falls through to the soft 404 for an unknown slug', async () => {
    mockFetch(404, { 'other-slug': '/en/find-jobs-zurich' });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
  });

  it('falls through to the soft 404 when the map shard is missing', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-zuerich/ein-job/`), {}, ctx);

    expect(res.status).toBe(404);
  });

  it('does not redirect a non-job 404 path (no map lookup)', async () => {
    mockFetch(404, { 'some-job-xyz': '/en/find-jobs-zurich' });

    const res = await worker.fetch(new Request(`${APEX}/en/guida-frontaliere/`), {}, ctx);

    expect(res.status).toBe(404);
    // No /job-canon/ subrequest should have been attempted for a non-job path.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });

  it('does not 301 to the path already requested (no redirect loop)', async () => {
    // Map points the slug back at the same section it was requested under.
    mockFetch(404, { 'some-job-xyz': '/en/jobs-in-zurich' });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
  });

  it('leaves a healthy 200 untouched (no map lookup)', async () => {
    mockFetch(200, { 'some-job-xyz': '/en/find-jobs-zurich' });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(200);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });
});
