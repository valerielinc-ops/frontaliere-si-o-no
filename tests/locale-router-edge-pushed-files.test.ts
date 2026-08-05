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
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS script module, no type declarations.
import { selectedEntries } from '../scripts/publish-edge-files.mjs';
import { readdirSync, readFileSync } from 'node:fs';
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

  it('keeps EVERY apex sitemap registered, each with a wrangler route', () => {
    // All four measured to lose their alternates on the passthrough origin
    // (blog 15230→0, glossario 210→0, news 50→0) or already proven correct here
    // (-ch, byte-identical live). Dropping any one of them silently returns
    // that sitemap to the origin that strips them.
    for (const pathname of [
      '/sitemap-blog.xml',
      '/sitemap-blog-ch.xml',
      '/sitemap-glossario.xml',
      '/sitemap-news.xml',
    ]) {
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

/**
 * Publisher coverage — the invariant whose absence took the Google News
 * surface offline for three days (issues #5006 / #5005 / #5001).
 *
 * servePushedEdgeFile PREFERS the R2 object over the origin passthrough
 * whenever the object exists. That asymmetry is the point of the table, and
 * it is also its one sharp edge: an R2 object that stops being refreshed does
 * not decay back to the origin, it SHADOWS it forever. Registering a path
 * here is therefore a promise that something keeps PUTting it.
 *
 * When the table shipped, the only caller of publish-edge-files.mjs was
 * fast-publish-article.yml — `workflow_dispatch` only. Measured 2026-08-05,
 * three days after its last run: R2 /edge/sitemap-news.xml carried 3 <url>
 * with publication dates 2026-07-31…08-02 while public/sitemap-news.xml
 * carried 22, all inside the 48h Google News window. Google News accepts
 * nothing older than two days, so the live surface offered zero eligible URLs
 * while the corpus published ~22 a day. /sitemap-glossario.xml and the
 * llms.txt family were frozen the same way.
 *
 * A manual trigger is not a publisher. This asserts every registered path is
 * covered by a workflow that fires on its own.
 */
describe('every EDGE_PUSHED_FILES path has an automatically-triggered publisher', () => {
  const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows');
  /** Triggers that fire without a human. `workflow_dispatch` is excluded on purpose. */
  const AUTOMATIC_TRIGGERS = ['push', 'schedule', 'workflow_run', 'repository_dispatch'];

  /**
   * Pathnames a workflow's publish-edge-files.mjs invocations cover.
   * `--only=a,b` covers exactly a and b; a bare invocation covers everything.
   */
  function coveredPaths(workflowSource: string): Set<string> {
    const covered = new Set<string>();
    for (const line of workflowSource.split('\n')) {
      if (!line.includes('scripts/publish-edge-files.mjs')) continue;
      // Skip prose: only a `run:`-style shell line actually invokes it.
      if (/^\s*#/.test(line)) continue;
      const only = line.match(/--only=(\S+)/);
      if (only) {
        for (const p of only[1].split(',')) if (p) covered.add(p);
      } else {
        for (const p of Object.keys(EDGE_PUSHED_FILES)) covered.add(p);
      }
    }
    return covered;
  }

  function hasAutomaticTrigger(workflowSource: string): boolean {
    const onBlock = workflowSource.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? '';
    return AUTOMATIC_TRIGGERS.some((t) => new RegExp(`^\\s{2}${t}:`, 'm').test(onBlock));
  }

  const publishers = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ file: f, source: readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8') }))
    .filter(({ source }) => source.includes('scripts/publish-edge-files.mjs'));

  it('at least one workflow invokes publish-edge-files.mjs', () => {
    expect(publishers.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(EDGE_PUSHED_FILES))(
    '%s is published by a workflow that fires without a manual dispatch',
    (pathname) => {
      const covering = publishers
        .filter(({ source }) => hasAutomaticTrigger(source) && coveredPaths(source).has(pathname))
        .map(({ file }) => file);

      expect(
        covering,
        `${pathname} is registered in EDGE_PUSHED_FILES, so the Worker serves its R2 copy in ` +
          `preference to the origin — but no automatically-triggered workflow runs ` +
          `scripts/publish-edge-files.mjs for it. The R2 object will freeze and shadow the ` +
          `origin indefinitely (this is exactly how sitemap-news.xml went 3 days stale and ` +
          `took the Google News surface to zero eligible URLs). Add a publish step to a ` +
          `workflow with a push/schedule/workflow_run/repository_dispatch trigger.`,
      ).not.toHaveLength(0);
    },
  );
});

/**
 * `--only` is a hard gate, not a filter that shrugs: every skip inside
 * publish-edge-files.mjs is a ::warning:: + exit 0, so a typo'd pathname
 * would be indistinguishable from a successful run that published nothing.
 */
describe('publish-edge-files --only selection', () => {
  it('defaults to the whole table when no --only is passed', () => {
    expect(selectedEntries(['node', 'publish-edge-files.mjs']).map(([p]) => p)).toEqual(
      Object.keys(EDGE_PUSHED_FILES),
    );
  });

  it('narrows to the named registered pathnames', () => {
    const picked = selectedEntries(['node', 'publish-edge-files.mjs', '--only=/sitemap-news.xml']);
    expect(picked.map(([p]) => p)).toEqual(['/sitemap-news.xml']);
    expect(picked[0][1]).toBe(EDGE_PUSHED_FILES['/sitemap-news.xml']);
  });

  it('throws on a pathname that is not registered', () => {
    expect(() =>
      selectedEntries(['node', 'publish-edge-files.mjs', '--only=/sitemap-typo.xml']),
    ).toThrow(/not registered in EDGE_PUSHED_FILES/);
  });
});
