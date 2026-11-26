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
  it('enables Cloudflare caching, drops request credentials and keeps concurrent fetches request-local', async () => {
    const resolveUpstream: Array<(response: Response) => void> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      resolveUpstream.push(resolve);
    }));
    const requests = [
      worker.fetch(new Request(`${CACHE_KEY}?first=1`, {
        headers: { Cookie: 'private=discarded', Authorization: 'Bearer discarded' },
      }), {}),
      worker.fetch(new Request(`${CACHE_KEY}?second=2`), {}),
      worker.fetch(new Request(`${CACHE_KEY}?third=3`), {}),
    ];

    expect(fetchMock).toHaveBeenCalledTimes(requests.length);
    expect(resolveUpstream).toHaveLength(requests.length);
    resolveUpstream.forEach((resolve, index) => resolve(new Response(
      JSON.stringify({ FIREBASE_API_KEY: `public-key-${index + 1}` }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
          'X-Upstream-Request': String(index + 1),
        },
      },
    )));
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.map((response) => response.headers.get('X-Upstream-Request'))).toEqual(['1', '2', '3']);
    expect(responses.map((response) => response.headers.get('Cache-Control'))).toEqual([
      'public, max-age=300, s-maxage=300',
      'public, max-age=300, s-maxage=300',
      'public, max-age=300, s-maxage=300',
    ]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { FIREBASE_API_KEY: 'public-key-1' },
      { FIREBASE_API_KEY: 'public-key-2' },
      { FIREBASE_API_KEY: 'public-key-3' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(requests.length);
    for (let index = 1; index <= requests.length; index += 1) {
      expect(fetchMock).toHaveBeenNthCalledWith(index, PUBLIC_CONFIG_ORIGIN, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
        cf: { cacheEverything: true },
      });
    }
    const cache = (globalThis as unknown as { caches: { default: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } } }).caches.default;
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('fails open on an upstream 5xx without affecting the next request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ FIREBASE_API_KEY: 'recovered-key' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
        },
      }));

    const failed = await worker.fetch(new Request(CACHE_KEY), {});
    const recovered = await worker.fetch(new Request(CACHE_KEY), {});

    expect(failed.status).toBe(200);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(await failed.json()).toEqual({});
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=300');
    expect(await recovered.json()).toEqual({ FIREBASE_API_KEY: 'recovered-key' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('fails open independently when fetch is unreachable and a later request recovers', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ FIREBASE_API_KEY: 'recovered-key' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
        },
      }));
    const [response, concurrentResponse] = await Promise.all([
      worker.fetch(new Request(CACHE_KEY), {}),
      worker.fetch(new Request(`${CACHE_KEY}?concurrent=1`), {}),
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual({});
    expect(concurrentResponse.status).toBe(200);
    expect(concurrentResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(await concurrentResponse.json()).toEqual({});
    const recovered = await worker.fetch(new Request(CACHE_KEY), {});
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=300');
    expect(await recovered.json()).toEqual({ FIREBASE_API_KEY: 'recovered-key' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(errorLog.mock.calls.map(([entry]) => entry)).toEqual([
      { event: 'origin_failure', reason: 'public-config', path: '/api/public-config/' },
      { event: 'origin_failure', reason: 'public-config', path: '/api/public-config/' },
    ]);
  });

  it('fails open when the upstream body stream breaks after a successful response', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        controller.error(new Error('upstream body truncated'));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(brokenBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    }));

    const response = await worker.fetch(new Request(CACHE_KEY), {});

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({});
    expect(errorLog).toHaveBeenCalledExactlyOnceWith({
      event: 'origin_failure',
      reason: 'public-config',
      path: '/api/public-config/',
    });
  });

  it.each([500, 503])('logs an upstream %i and fails open before returning it to the browser', async (status) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporarily unavailable', { status }));

    const response = await worker.fetch(new Request(CACHE_KEY), {});

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({});
    expect(errorLog).toHaveBeenCalledExactlyOnceWith({
      event: 'origin_failure',
      reason: 'public-config',
      path: '/api/public-config/',
      status,
    });
  });
});
