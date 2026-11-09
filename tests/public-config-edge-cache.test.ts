import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const PUBLIC_CONFIG_ORIGIN = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPublicConfig';
const CACHE_KEY = `${APEX}/api/public-config/`;

beforeEach(() => {
  vi.stubGlobal('caches', { default: { match: vi.fn(), put: vi.fn() } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public config edge route', () => {
  it('enables Cloudflare caching, drops request credentials and shares an in-flight fill', async () => {
    let resolveUpstream!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      resolveUpstream = resolve;
    }));
    const firstRequest = worker.fetch(new Request(`${CACHE_KEY}?first=1`, {
      headers: { Cookie: 'private=discarded', Authorization: 'Bearer discarded' },
    }), {});
    const secondRequest = worker.fetch(new Request(`${CACHE_KEY}?second=2`), {});
    await Promise.resolve();
    resolveUpstream(new Response(
      JSON.stringify({ FIREBASE_API_KEY: 'public-key' }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300' } },
    ));
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=300');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(PUBLIC_CONFIG_ORIGIN, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cf: { cacheEverything: true },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ FIREBASE_API_KEY: 'public-key' });
    const cache = (globalThis as unknown as { caches: { default: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } } }).caches.default;
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('preserves no-store on the function fail-open response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }));

    const first = await worker.fetch(new Request(CACHE_KEY), {});
    const second = await worker.fetch(new Request(CACHE_KEY), {});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(PUBLIC_CONFIG_ORIGIN, expect.objectContaining({ cf: { cacheEverything: true } }));
  });

  it('rejects non-GET requests without contacting the function', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(new Request(CACHE_KEY, { method: 'POST' }), {});

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails open with a non-cacheable response when the function is unreachable', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));
    const [response, concurrentResponse] = await Promise.all([
      worker.fetch(new Request(CACHE_KEY), {}),
      worker.fetch(new Request(`${CACHE_KEY}?concurrent=1`), {}),
    ]);

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(concurrentResponse.status).toBe(503);
    expect(concurrentResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(errorLog.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual([
      { event: 'origin_failure', reason: 'public-config', path: '/api/public-config/' },
      { event: 'origin_failure', reason: 'public-config', path: '/api/public-config/' },
    ]);
  });

  it('logs an upstream 503 before returning it to the browser', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporarily unavailable', { status: 503 }));

    const response = await worker.fetch(new Request(CACHE_KEY), {});

    expect(response.status).toBe(503);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: 'origin_failure',
      reason: 'public-config',
      path: '/api/public-config/',
      status: 503,
    }));
  });
});
