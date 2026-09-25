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
      ).toContain(`frontaliereticino.ch${pathname}`);
    }
  });
});

/**
 * Every EDGE_PUSHED_FILES route must carry a trailing `*`.
 *
 * A Cloudflare route without one matches only the exact URL with NO query
 * string, so `?anything` bypasses the Worker and is answered by the GitHub
 * Pages passthrough instead. That is not the same bytes by another path — it is
 * the OTHER origin, the one this table exists to stop serving. Measured
 * 2026-08-08 on /sitemap-topics-frontaliere.xml: bare returned
 * `cache-control: public, max-age=300` (Worker → R2) and `?cb=1` returned
 * `x-served-by: cache-mxp…` + etag + `max-age=600` (Pages). They happened to
 * carry identical bytes in that moment because a full deploy had landed hours
 * earlier; #4974 (15230→0 hreflang alternates) and #5001 (36 phantom page-N
 * URLs) are what they look like the rest of the time.
 *
 * The user-visible cost is small — real crawlers fetch these bare. The
 * diagnostic cost is not: every cache-busted probe of these paths silently
 * measures the wrong origin, which is how "this resource does not exist" gets
 * concluded about a resource that does.
 *
 * Look-alikes are safe: servePushedEdgeFile is an exact-match lookup on
 * `EDGE_PUSHED_FILES[url.pathname]`, so /llms.txt.bak matches the CF route,
 * misses the table, and falls through to the same passthrough as today — the
 * behaviour the first describe block above pins.
 */
describe('every EDGE_PUSHED_FILES route is query-string-proof', () => {
  const toml = readFileSync(
    path.resolve(__dirname, '..', 'infra', 'cloudflare-worker', 'wrangler.toml'),
    'utf-8',
  );

  it.each(Object.keys(EDGE_PUSHED_FILES))('%s has a wildcarded wrangler route', (pathname) => {
    expect(
      toml,
      `the route for ${pathname} has no trailing "*", so "${pathname}?x=1" bypasses the ` +
        `Worker and is served by GitHub Pages instead of the R2 copy — a different origin ` +
        `with the same status code, which makes every cache-busted probe of this path lie.`,
    ).toContain(`{ pattern = "frontaliereticino.ch${pathname}*", zone_name`);
  });

  it('does NOT wildcard the three locale .html routes', () => {
    // The opposite call, deliberately. Measured 2026-08-08: /en.html, /de.html
    // and /fr.html are 404 bare (the Worker routes them to origin-{loc}, which
    // has no such file — origin-en/en.html → 404, origin-en/index.html → 200)
    // and 200 with ?cb=1, because the bypass reaches the Pages trunk that does
    // carry them. Here the query-string variant is the working one, so widening
    // these routes would convert the last working variant into a third 404.
    for (const loc of ['en', 'de', 'fr']) {
      expect(toml).toContain(`{ pattern = "frontaliereticino.ch/${loc}.html", zone_name`);
      expect(toml).not.toContain(`{ pattern = "frontaliereticino.ch/${loc}.html*", zone_name`);
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
   * `--only=a,b` covers exactly a and b; `--producer=X` covers every entry in
   * EDGE_PUSHED_FILES whose `producer` field is X (resolved against the SAME
   * table this test already imports — not a second guess at the mapping); a
   * bare invocation (neither flag) covers everything.
   */
  function coveredPaths(workflowSource: string): Set<string> {
    const covered = new Set<string>();
    for (const line of workflowSource.split('\n')) {
      if (!line.includes('scripts/publish-edge-files.mjs')) continue;
      // Skip prose: only a `run:`-style shell line actually invokes it.
      if (/^\s*#/.test(line)) continue;
      const producerFlag = line.match(/--producer=(\S+)/);
      if (producerFlag) {
        for (const [p, entry] of Object.entries(EDGE_PUSHED_FILES)) {
          if (entry.producer === producerFlag[1]) covered.add(p);
        }
        continue;
      }
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

  const RSS_FEEDS = [
    '/rss.xml',
    '/rss-it.xml',
    '/rss-en.xml',
    '/rss-de.xml',
    '/rss-fr.xml',
    '/rss-svizzera.xml',
    '/rss-svizzera-it.xml',
    '/rss-svizzera-en.xml',
    '/rss-svizzera-de.xml',
    '/rss-svizzera-fr.xml',
  ];

  /**
   * The feeds need a publisher that is NOT deploy.yml, and the block above
   * cannot express that.
   *
   * `deploy.yml` invokes publish-edge-files.mjs BARE (no `--only`, line ~1146)
   * on a `push` trigger, so coveredPaths() credits it with EVERY key in the
   * table — including any key added later. The guard above would therefore stay
   * green for these ten paths even if the sync workflow's publish step were
   * deleted, because it cannot tell a publisher that runs within minutes of an
   * article landing from one that runs at the end of a deploy chain measured at
   * over two hours, and self-cancelling on churn (48 of 60 runs `cancelled`).
   *
   * That distinction is the entire point of registering them: before this,
   * /rss.xml on the apex was 2h57m behind the corpus with 5 of 50 items
   * missing, while /edge/rss.xml answered 404.
   */
  it.each(RSS_FEEDS)('%s has a publisher other than deploy.yml', (pathname) => {
    const covering = publishers
      .filter(
        ({ file, source }) =>
          file !== 'deploy.yml' && hasAutomaticTrigger(source) && coveredPaths(source).has(pathname),
      )
      .map(({ file }) => file);

    expect(
      covering,
      `${pathname} is only published by deploy.yml, whose chain takes >2h and cancels on ` +
        `churn. A feed is a subscription surface: whoever reads it does not come back to ` +
        `check whether it moved. It needs a publisher on the article-publication path ` +
        `(sync-articles-sitemaps.yml), not on the deploy path.`,
    ).not.toHaveLength(0);
  });

  it('keeps all ten RSS feeds registered, each with a wildcarded route', () => {
    const toml = readFileSync(
      path.resolve(__dirname, '..', 'infra', 'cloudflare-worker', 'wrangler.toml'),
      'utf-8',
    );
    for (const pathname of RSS_FEEDS) {
      expect(
        EDGE_PUSHED_FILES[pathname],
        `${pathname} must stay in EDGE_PUSHED_FILES — without it the feed returns to the ` +
          `GitHub Pages passthrough, which only refreshes when the site deploys`,
      ).toBeTruthy();
      expect(
        toml,
        `${pathname} is in EDGE_PUSHED_FILES but has no wildcarded wrangler route`,
      ).toContain(`{ pattern = "frontaliereticino.ch${pathname}*", zone_name`);
    }
  });

  // Scoped to producer 'build' / 'sync' (issue #5458): these are the two
  // classes this repo's OWN workflow set can actually attest to by scanning
  // `.github/workflows/*.yml` for a literal `--only=`/`--producer=` match.
  // 'corpus' (published cross-repo, by nanakokyobashi-rgb/frontaliere-articles'
  // publish-api.yml) and 'hub-render' (rerender-article-hubs.yml, but its
  // `--only="/$REL"` is a runtime shell variable, never a literal string in
  // this source) are checked below by mechanism instead — a bare `Object.keys`
  // scan here would have reported them "covered" for the wrong reason (deploy.yml's
  // now-removed bare invocation), which is exactly the vacuous gate #5458 found.
  const inRepoCheckablePaths = Object.entries(EDGE_PUSHED_FILES)
    .filter(([, entry]) => entry.producer === 'build' || entry.producer === 'sync')
    .map(([pathname]) => pathname);

  it('accounts for every registered path across the four known producer classes', () => {
    // A future entry with a typo'd or unhandled `producer` value would
    // otherwise silently fall out of ALL the coverage assertions below
    // (in-repo, corpus, and hub-render) rather than failing loudly.
    const known = new Set(['build', 'sync', 'corpus', 'hub-render']);
    for (const [pathname, entry] of Object.entries(EDGE_PUSHED_FILES)) {
      expect(known.has(entry.producer), `${pathname} has an unrecognized producer: '${entry.producer}'`).toBe(true);
    }
  });

  it.each(inRepoCheckablePaths)(
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

  // producer: 'corpus' — published straight to this same R2 prefix by
  // nanakokyobashi-rgb/frontaliere-articles' publish-api.yml, cross-repo, on
  // every push to its main touching content/ (verified 2026-08-10:
  // `.github/workflows/publish-api.yml` there PUTs `dist/api/<f>` to
  // `edge/<f>` for exactly these three names). This repo's workflow scan
  // structurally cannot see that job, so the only thing enforceable HERE is
  // the failure mode #5458 was actually about: deploy.yml, whose checkout can
  // be 2h30m+ stale, may not claim to publish it too — that specific race is
  // what clobbered the corpus's fresher copy. Scoped to deploy.yml, not "any
  // workflow in this repo": fast-publish-article.yml also names these paths,
  // via its own `--producer=corpus` invocation (narrowed from a bare call in
  // the #5458 review round — its checkout is minutes, not hours, behind the
  // very commit create-article.mjs just wrote them in, but the same clobber
  // class applied at a smaller window, so it is scoped too, not exempted).
  const corpusOwnedPaths = Object.entries(EDGE_PUSHED_FILES)
    .filter(([, entry]) => entry.producer === 'corpus')
    .map(([pathname]) => pathname);

  it.each(corpusOwnedPaths)('%s is not (re-)published by deploy.yml', (pathname) => {
    const deployYml = publishers.find(({ file }) => file === 'deploy.yml');
    const stillCovers = deployYml ? coveredPaths(deployYml.source).has(pathname) : false;

    expect(
      stillCovers,
      `${pathname} is producer: 'corpus' (published cross-repo by the corpus repo's own ` +
        `publish-api.yml straight to the same R2 key) but deploy.yml's invocation still covers ` +
        `it — that race, deploy.yml's 2h30m-stale checkout overwriting the corpus's fresh PUT, ` +
        `is the exact #5458 failure mode.`,
    ).toBe(false);
  });

  // producer: 'hub-render' — rerender-article-hubs.yml selects its --only
  // pathname at RUNTIME from that run's own render summary (`--only="/$REL"`),
  // so it can never appear as a literal string for coveredPaths() to match.
  // The static-scan approach above is structurally blind here; this instead
  // asserts the MECHANISM is wired: the workflow exists, fires automatically,
  // and actually invokes the publish script against its own render output.
  const hubRenderPaths = Object.entries(EDGE_PUSHED_FILES)
    .filter(([, entry]) => entry.producer === 'hub-render')
    .map(([pathname]) => pathname);

  it.each(hubRenderPaths)('%s has an automatically-triggered render+publish mechanism wired', () => {
    const hubWorkflow = publishers.find(({ file }) => file === 'rerender-article-hubs.yml');

    expect(hubWorkflow, 'rerender-article-hubs.yml no longer invokes scripts/publish-edge-files.mjs').toBeTruthy();
    if (!hubWorkflow) return;

    expect(
      hasAutomaticTrigger(hubWorkflow.source),
      'rerender-article-hubs.yml lost its automatic (push/workflow_run) trigger — it would only run on workflow_dispatch, same failure class as fast-publish-article.yml',
    ).toBe(true);
    expect(
      hubWorkflow.source,
      'rerender-article-hubs.yml no longer publishes its own render output to the edge (expected a `--only="/$REL" --from-dir=` -shaped invocation)',
    ).toMatch(/scripts\/publish-edge-files\.mjs\s+--only="[^"]+"\s+--from-dir=/);
  });
});

/**
 * The invocation deploy.yml actually runs, not the table (issue #5458).
 *
 * The describe block above proves every path HAS a publisher somewhere; it
 * does not prove deploy.yml stays out of the way of the ones it does not own.
 * That was exactly the gap: `tests/locale-router-edge-pushed-files.test.ts`
 * stayed green while deploy.yml invoked publish-edge-files.mjs bare, because
 * a bare invocation credits deploy.yml with covering EVERY key — including
 * ones it does not produce — so the coverage assertions above could never
 * have caught deploy.yml re-publishing (and clobbering) a corpus- or
 * sync-owned entry with its own 2h30m-stale checkout. Only a check on the
 * literal `run:` line in deploy.yml, not on EDGE_PUSHED_FILES, closes that.
 */
describe('deploy.yml only publishes the EDGE_PUSHED_FILES entries it actually produces (#5458)', () => {
  const DEPLOY_YML_SOURCE = readFileSync(
    path.resolve(__dirname, '..', '.github', 'workflows', 'deploy.yml'),
    'utf-8',
  );

  function deployEdgePublishInvocations(): string[] {
    return DEPLOY_YML_SOURCE.split('\n').filter(
      (line) => line.includes('scripts/publish-edge-files.mjs') && !/^\s*#/.test(line),
    );
  }

  it('still invokes publish-edge-files.mjs (this test would be vacuous otherwise)', () => {
    expect(deployEdgePublishInvocations().length).toBeGreaterThan(0);
  });

  it('never invokes it bare — every call is scoped with --only= or --producer=', () => {
    for (const line of deployEdgePublishInvocations()) {
      expect(
        line,
        `deploy.yml runs "${line.trim()}" with neither --only= nor --producer= — this re-publishes ` +
          `the WHOLE EDGE_PUSHED_FILES table from deploy.yml's own checkout, which can be 2h30m+ ` +
          `stale by the time this step runs, clobbering fresher R2 copies written by the corpus ` +
          `repo's publish-api.yml, sync-articles-sitemaps.yml and rerender-article-hubs.yml (#5458).`,
      ).toMatch(/--only=|--producer=/);
    }
  });

  it('resolves to a set that is entirely producer: "build" — nothing owned by another workflow', () => {
    for (const line of deployEdgePublishInvocations()) {
      const producerMatch = line.match(/--producer=(\S+)/);
      const onlyMatch = line.match(/--only=(\S+)/);
      const coveredPathnames = producerMatch
        ? Object.entries(EDGE_PUSHED_FILES)
            .filter(([, entry]) => entry.producer === producerMatch[1])
            .map(([pathname]) => pathname)
        : onlyMatch
          ? onlyMatch[1].split(',').filter(Boolean)
          : []; // an unscoped line is already failed by the previous test

      for (const pathname of coveredPathnames) {
        expect(
          EDGE_PUSHED_FILES[pathname]?.producer,
          `deploy.yml's invocation covers ${pathname}, whose producer is ` +
            `'${EDGE_PUSHED_FILES[pathname]?.producer}' — deploy.yml only owns producer: 'build' ` +
            `entries (see the producer table in infra/cloudflare-worker/locale-router.js).`,
        ).toBe('build');
      }
    }
  });
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

/**
 * `--producer` (issue #5458) is `--only`'s sibling for a caller that owns a
 * whole CLASS of entries: it resolves against EDGE_PUSHED_FILES's own
 * `producer` field rather than a second, hand-maintained path list, so
 * deploy.yml's invocation stays correct automatically as entries are added
 * or reclassified.
 */
describe('publish-edge-files --producer selection', () => {
  it('narrows to every entry whose producer field matches', () => {
    const picked = selectedEntries(['node', 'publish-edge-files.mjs', '--producer=build']);
    const buildOwned = Object.entries(EDGE_PUSHED_FILES).filter(([, entry]) => entry.producer === 'build');

    expect(picked).toEqual(buildOwned);
    // Guards against a vacuous pass: if a future edit accidentally marked
    // every entry 'build' (or none), this equality above would still hold
    // trivially. Pin the known shape too.
    expect(picked.map(([p]) => p)).toEqual(
      expect.arrayContaining(['/sitemap-glossario.xml', '/llms.txt', '/llms-full.txt', '/.well-known/llms.txt']),
    );
    expect(picked.every(([, entry]) => entry.producer === 'build')).toBe(true);
  });

  it('throws on a producer value nothing in the table declares', () => {
    expect(() => selectedEntries(['node', 'publish-edge-files.mjs', '--producer=typo'])).toThrow(
      /matched no entries in EDGE_PUSHED_FILES/,
    );
  });

  it('rejects --only and --producer together — pick one selection mechanism', () => {
    expect(() =>
      selectedEntries(['node', 'publish-edge-files.mjs', '--only=/sitemap-news.xml', '--producer=build']),
    ).toThrow(/mutually exclusive/);
  });
});
