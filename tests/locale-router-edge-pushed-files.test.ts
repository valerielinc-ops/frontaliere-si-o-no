/**
 * Pushable-origin edge files in the Cloudflare locale-router Worker
 * (issue #4881 Fase 3).
 *
 * EDGE_PUSHED_FILES lets a handful of apex paths (starting with
 * /sitemap-blog-ch.xml) be served from an R2 copy that scripts/publish-edge-
 * files.mjs PUTs right after a fast-published article's commit, instead of
 * waiting for the next full deploy. servePushedEdgeFile must fail OPEN on any
 * R2 miss/error: the request then falls through the rest of the dispatch
 * chain to the exact same IT-apex passthrough (fetchOriginWithRetry) that
 * served this path before EDGE_PUSHED_FILES existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { EDGE_PUSHED_FILES } from '../infra/cloudflare-worker/locale-router.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
 * Mock fetch: a request to cdn.frontaliereticino.ch/edge/... returns
 * `edgeStatus`/`edgeBody`; everything else (the apex-passthrough origin
 * fetch) returns `originStatus`/`originBody`, so we can tell which branch
 * actually served the response.
 */
function mockFetch(opts: {
  edgeStatus?: number;
  edgeBody?: string;
  originStatus: number;
  originBody?: string;
}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes('cdn.frontaliereticino.ch/edge/')) {
      return opts.edgeStatus === undefined
        ? new Response('should not be called', { status: 500 })
        : new Response(opts.edgeBody ?? 'edge-body', { status: opts.edgeStatus });
    }
    return new Response(opts.originBody ?? 'origin-body', { status: opts.originStatus });
  });
}

describe('locale-router pushable-origin edge files (#4881)', () => {
  it('serves the R2 copy for a registered path when the R2 fetch is a 200', async () => {
    mockFetch({ edgeStatus: 200, edgeBody: '<xml>fresh</xml>', originStatus: 200, originBody: 'stale-origin' });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-blog-ch.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<xml>fresh</xml>');
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
  });

  it('falls open to the origin passthrough when the R2 object is missing (404)', async () => {
    mockFetch({ edgeStatus: 404, originStatus: 200, originBody: 'origin-served' });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-blog-ch.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-served');
  });

  it('falls open to the origin passthrough when the R2 fetch throws (network/timeout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u.includes('cdn.frontaliereticino.ch/edge/')) throw new Error('network error');
      return new Response('origin-served-after-error', { status: 200 });
    });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-blog-ch.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-served-after-error');
  });

  it('never touches R2 for a path not in EDGE_PUSHED_FILES (origin passthrough only)', async () => {
    mockFetch({ originStatus: 200, originBody: 'unrelated-page' });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-jobs-ch.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('unrelated-page');
  });

  it('falls open to origin passthrough when the R2 fetch is a non-2xx error status (500)', async () => {
    mockFetch({ edgeStatus: 500, originStatus: 200, originBody: 'origin-served-on-5xx' });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-blog-ch.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-served-on-5xx');
  });
});

/**
 * /sitemap-blog.xml (#4974). Registered for CORRECTNESS, not freshness: the
 * apex passthrough origin was serving this file stripped of all 15225 hreflang
 * alternates while the committed copy had them, and its already-registered
 * sibling /sitemap-blog-ch.xml was byte-identical live. Whatever drops them
 * lives downstream of what this repo commits; the edge origin bypasses it.
 *
 * Both files must therefore stay registered — dropping either one from the
 * table silently returns that sitemap to the origin that mangles it, with no
 * failing build and no error anywhere. Only the index would notice.
 */
describe('locale-router serves the frontaliere article sitemap from the edge origin (#4974)', () => {
  it('serves the R2 copy when the R2 fetch is a 200', async () => {
    mockFetch({
      edgeStatus: 200,
      edgeBody: '<urlset><url><xhtml:link rel="alternate" /></url></urlset>',
      originStatus: 200,
      originBody: 'origin-copy-without-alternates',
    });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-blog.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('xhtml:link');
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
  });

  it('falls open to the origin passthrough when the R2 object is missing (404)', async () => {
    mockFetch({ edgeStatus: 404, originStatus: 200, originBody: 'origin-served' });

    const res = await worker.fetch(new Request(`${APEX}/sitemap-blog.xml`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-served');
  });

  it('keeps BOTH article sitemaps registered, each with a wrangler route', () => {
    for (const pathname of ['/sitemap-blog.xml', '/sitemap-blog-ch.xml']) {
      expect(
        EDGE_PUSHED_FILES[pathname],
        `${pathname} must stay in EDGE_PUSHED_FILES — without it the file falls back ` +
          `to the apex origin, which serves it without hreflang alternates`,
      ).toBeTruthy();

      const toml = readFileSync(
        path.resolve(__dirname, '..', 'infra', 'cloudflare-worker', 'wrangler.toml'),
        'utf-8',
      );
      expect(
        toml,
        `${pathname} is registered in EDGE_PUSHED_FILES but has no wrangler route — ` +
          `the Worker would never see the request`,
      ).toContain(`frontaliereticino.ch${pathname}"`);
    }
  });
});

/**
 * llms.txt family entries (#4881 residual — see locale-router.js
 * EDGE_PUSHED_FILES comment). Same servePushedEdgeFile mechanism as
 * /sitemap-blog-ch.xml above, just three more apex paths.
 */
describe.each([
  { pathname: '/llms.txt' },
  { pathname: '/llms-full.txt' },
  { pathname: '/.well-known/llms.txt' },
])('locale-router pushable-origin edge files — $pathname (#4881 residual)', ({ pathname }) => {
  it('serves the R2 copy when the R2 fetch is a 200', async () => {
    mockFetch({ edgeStatus: 200, edgeBody: 'fresh llms content', originStatus: 200, originBody: 'stale-origin' });

    const res = await worker.fetch(new Request(`${APEX}${pathname}`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fresh llms content');
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('falls open to the origin passthrough when the R2 object is missing (404)', async () => {
    mockFetch({ edgeStatus: 404, originStatus: 200, originBody: 'origin-served' });

    const res = await worker.fetch(new Request(`${APEX}${pathname}`), {}, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin-served');
  });
});

/**
 * The locale variants (/en|de|fr/llms.txt) are deliberately NOT registered in
 * EDGE_PUSHED_FILES (see that table's comment: different origin — the
 * locale-root shard via serveShard, not the apex passthrough — plus a
 * materially larger, full-index file for a marginal per-publish freshness
 * gain). These must keep behaving exactly as before this rollout: R2 is
 * never consulted, and the request reaches the normal locale-shard dispatch.
 */
describe('locale llms.txt variants stay excluded from EDGE_PUSHED_FILES (#4881 residual)', () => {
  it.each(['/en/llms.txt', '/de/llms.txt', '/fr/llms.txt'])(
    'never touches R2 for %s (falls through to locale-shard dispatch)',
    async (pathname) => {
      mockFetch({ originStatus: 200, originBody: 'shard-served' });

      const res = await worker.fetch(new Request(`${APEX}${pathname}`), {}, ctx);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('shard-served');
    },
  );
});
