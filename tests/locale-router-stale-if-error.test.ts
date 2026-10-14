/**
 * Stale-if-error behaviour of the Cloudflare locale-router Worker.
 *
 * When a shard origin fails (5xx after retries, or a thrown timeout/network
 * error) the Worker must serve the last-good apex-keyed copy stored in
 * caches.default — instead of propagating the error to a crawler (SEO) or a
 * user (revenue). On a cache MISS it falls back to surfacing the origin error.
 *
 * The Worker uses Web-platform globals (fetch, caches, Request, Response, URL,
 * Headers, AbortController). jsdom/Node provide all but `caches`, which we mock
 * here together with `fetch`. No miniflare harness needed: we import the
 * module's default export and call its fetch() directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

let cacheStore: Map<string, Response>;

beforeEach(() => {
  cacheStore = new Map();
  // Minimal Cache API shim keyed by request URL.
  const cache = {
    match: vi.fn(async (req: Request) => {
      const key = typeof req === 'string' ? req : req.url;
      const hit = cacheStore.get(key);
      return hit ? hit.clone() : undefined;
    }),
    put: vi.fn(async (req: Request, res: Response) => {
      const key = typeof req === 'string' ? req : req.url;
      cacheStore.set(key, res.clone());
    }),
  };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

function seedCache(url: string, body: string): void {
  cacheStore.set(
    url,
    new Response(body, { status: 200, headers: { 'Cache-Control': 'public, max-age=300, s-maxage=86400' } }),
  );
}

describe('locale-router stale-if-error', () => {
  it('serves the stale cached copy when the shard origin returns 5xx', async () => {
    const path = `${APEX}/en/jobs/`;
    seedCache(path, '<html>last-good EN</html>');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));

    const res = await worker.fetch(new Request(path), {}, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Served-Stale')).toBe('origin-503');
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    expect(await res.text()).toBe('<html>last-good EN</html>');
  });

  it('serves the stale cached copy when the shard origin throws (timeout/network)', async () => {
    const path = `${APEX}/de/lavoro/`;
    seedCache(path, '<html>last-good DE</html>');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const res = await worker.fetch(new Request(path), {}, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Served-Stale')).toBe('origin-timeout');
    expect(await res.text()).toBe('<html>last-good DE</html>');
  });

  it('does not cache origin 5xx and propagates it when there is no cached copy', async () => {
    const cfOptions: Array<Record<string, unknown> | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      cfOptions.push((init as RequestInit & { cf?: Record<string, unknown> } | undefined)?.cf);
      return new Response('boom', { status: 502 });
    });

    const res = await worker.fetch(new Request(`${APEX}/fr/emploi/`), {}, ctx);

    expect(res.status).toBe(502);
    expect(res.headers.get('X-Served-Stale')).toBeNull();
    expect(cfOptions).toHaveLength(2);
    expect(cfOptions[0]).toMatchObject({
      cacheEverything: true,
      cacheTtlByStatus: {
        '200-299': 7200,
        '300-399': 7200,
        '400-427': 7200,
        '428-429': -1,
        '430': 7200,
        '431': -1,
        '432-499': 7200,
        '500-599': -1,
      },
    });
    expect(cfOptions[1]).toEqual(cfOptions[0]);
  });

  it.each([
    [200, 7200], [301, 7200], [404, 7200], [410, 7200],
    [427, 7200], [428, -1], [429, -1], [430, 7200],
    [431, -1], [432, 7200], [499, 7200],
  ])('uses one unambiguous origin-cache rule for HTTP %s', async (status, expectedTtl) => {
    let policy: Record<string, number> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      policy = (init as RequestInit & { cf?: { cacheTtlByStatus?: Record<string, number> } })?.cf?.cacheTtlByStatus;
      return new Response('page', { status });
    });
    await worker.fetch(new Request(`${APEX}/fr/emploi/`), {}, ctx);
    const matches = Object.entries(policy || {}).filter(([range]) => {
      const [first, last = first] = range.split('-').map(Number);
      return status >= first && status <= last;
    });
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe(expectedTtl);
  });

  it('returns 503 on origin throw when there is no cached copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const res = await worker.fetch(new Request(`${APEX}/en/missing/`), {}, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  it('does not serve stale for a healthy 200 (happy path unaffected)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>fresh</html>', { status: 200 }),
    );

    const res = await worker.fetch(new Request(`${APEX}/en/ok/`), {}, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Served-Stale')).toBeNull();
    expect(await res.text()).toBe('<html>fresh</html>');
  });

  it('retries when reading a shard body fails and pins the subrequest to identity encoding', async () => {
    const truncated = new Response(null, { status: 200 });
    vi.spyOn(truncated, 'arrayBuffer').mockRejectedValue(new Error('gzip truncated'));
    const originRequests: Request[] = [];
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      originRequests.push(input instanceof Request ? input : new Request(input));
      calls += 1;
      return calls === 1 ? truncated : new Response('<html>recovered</html>', { status: 200 });
    });

    const res = await worker.fetch(
      new Request(`${APEX}/articoli-frontaliere/tutti/retry-body/`),
      {},
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>recovered</html>');
    expect(calls).toBe(2);
    expect(originRequests.every((req) => req.headers.get('Accept-Encoding') === 'identity')).toBe(true);
  });

  it('serves stale when the retried shard body is still unreadable', async () => {
    const path = `${APEX}/articoli-frontaliere/tutti/body-error/`;
    seedCache(path, '<html>last-good body</html>');
    const unreadable = new Response(null, { status: 200 });
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new Error('gzip truncated'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(unreadable);

    const res = await worker.fetch(new Request(path), {}, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Served-Stale')).toBe('origin-body');
    expect(await res.text()).toBe('<html>last-good body</html>');
  });
});
