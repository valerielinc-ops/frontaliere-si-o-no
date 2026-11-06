/** Apex passthrough: last-good copy, failure logs and the CDN image redirect. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const page = `${APEX}/calcola-stipendio/`;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const collect = (promises: Promise<unknown>[]) =>
  ({ waitUntil: (p: Promise<unknown>) => promises.push(p) }) as unknown as ExecutionContext;

let cacheStore: Map<string, Response>;

beforeEach(() => {
  cacheStore = new Map();
  const cache = {
    match: vi.fn(async (req: Request) => cacheStore.get(req.url)?.clone()),
    put: vi.fn(async (req: Request, res: Response) => {
      cacheStore.set(req.url, res.clone());
    }),
  };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe('locale-router apex resilience', () => {
  it('stores a last-good copy of an apex page and serves it when the origin fails', async () => {
    const pending: Promise<unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>ok</html>', { status: 200 }));
    const live = await worker.fetch(new Request(page), {}, collect(pending));
    expect(await live.text()).toBe('<html>ok</html>');
    await Promise.all(pending);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const stale = await worker.fetch(new Request(page), {}, ctx);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Served-Stale')).toBe('apex-timeout');
    expect(await stale.text()).toBe('<html>ok</html>');
  });

  it('does not store version files or query-string URLs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x', { status: 200 }));
    const pending: Promise<unknown>[] = [];
    await worker.fetch(new Request(`${APEX}/commit-hash.txt`), {}, collect(pending));
    await worker.fetch(new Request(`${page}?utm_source=x`), {}, collect(pending));
    expect(cacheStore.size).toBe(0);
  });

  it('answers a bounded 503 and logs one structured line without the query string', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const res = await worker.fetch(new Request(`${page}?token=secret`), {}, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: 'origin_failure',
      reason: 'apex-timeout',
      path: '/calcola-stipendio/',
      stale: false,
    });
  });

  it('never logs on the happy path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html></html>', { status: 200 }));
    await worker.fetch(new Request(page), {}, ctx);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['/sitemap_index.xml', '/sitemap-jobs-ticino.xml'])('redirects %s to the sitemap index', async (pathname) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
    const res = await worker.fetch(new Request(`${APEX}${pathname}`), {}, ctx);
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get('Location')!, APEX).pathname).toBe('/sitemap.xml');
  });

  it('redirects a missing apex blog image to the CDN', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
    const res = await worker.fetch(new Request(`${APEX}/images/blog/foto.webp`), {}, ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://cdn.frontaliereticino.ch/images/blog/foto.webp');
  });
});
