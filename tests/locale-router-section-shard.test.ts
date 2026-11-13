/**
 * Section-shard routing of the Cloudflare locale-router Worker.
 *
 * Three job sections have each grown too large for a single Pages repo to stay
 * under the 10 GB actions/deploy-pages cap, so each is carved out to ONE Pages
 * repo PER LOCALE (origin-<section>-<loc>.frontaliereticino.ch): ticino (the
 * original carve-out, the single largest subtree in the build), svizzera (the
 * nationwide aggregator), and zurigo (Zurich canton). The Worker must:
 *   - route each section's IT prefix (e.g. /cerca-lavoro-ticino/**) to
 *     origin-<section>-it;
 *   - route each section's localized prefixes (e.g. /en/find-jobs-ticino/**,
 *     /de/jobs-im-tessin/**, /fr/trouver-emploi-tessin/**) to
 *     origin-<section>-{loc} (NOT origin-{loc}), which requires the section
 *     check to run BEFORE the locale check;
 *   - leave every other path untouched: non-section /en|/de|/fr → origin-{loc},
 *     non-section IT → apex passthrough, and look-alikes (…-ticino-altro) → apex.
 *
 * Same lightweight harness as locale-router-stale-if-error: import the default
 * export and call fetch() directly, mocking `fetch` (to capture the upstream
 * Host) and the Cache API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, {
  resetSectionTreeLayoutCacheForTests,
  SECTION_ROUTES,
  SECTION_TREE_FANOUT_SECTIONS,
} from '../infra/cloudflare-worker/locale-router.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — runtime-neutral Worker helper has no separate declarations.
import {
  legacyTicinoTreeBucket,
  sectionTreeBucket,
  ticinoTreeBucket,
} from '../infra/cloudflare-worker/ticino-tree-bucket.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const SECTION_ORIGIN = {
  ticino: {
    it: 'origin-ticino-it.frontaliereticino.ch',
    en: 'origin-ticino-en.frontaliereticino.ch',
    de: 'origin-ticino-de.frontaliereticino.ch',
    fr: 'origin-ticino-fr.frontaliereticino.ch',
  },
  svizzera: {
    it: 'origin-svizzera-it.frontaliereticino.ch',
    en: 'origin-svizzera-en.frontaliereticino.ch',
    de: 'origin-svizzera-de.frontaliereticino.ch',
    fr: 'origin-svizzera-fr.frontaliereticino.ch',
  },
  zurigo: {
    it: 'origin-zurigo-it.frontaliereticino.ch',
    en: 'origin-zurigo-en.frontaliereticino.ch',
    de: 'origin-zurigo-de.frontaliereticino.ch',
    fr: 'origin-zurigo-fr.frontaliereticino.ch',
  },
  berna: {
    it: 'origin-berna-it.frontaliereticino.ch',
    en: 'origin-berna-en.frontaliereticino.ch',
    de: 'origin-berna-de.frontaliereticino.ch',
    fr: 'origin-berna-fr.frontaliereticino.ch',
  },
  lucerna: {
    it: 'origin-lucerna-it.frontaliereticino.ch',
    en: 'origin-lucerna-en.frontaliereticino.ch',
    de: 'origin-lucerna-de.frontaliereticino.ch',
    fr: 'origin-lucerna-fr.frontaliereticino.ch',
  },
};

/** Capture the upstream request the Worker fetches for a given public path. */
let lastUpstreamHost: string | null;
let lastUpstreamPath: string | null;
let upstreamPathHistory: string[];
let upstreamHandler: (url: URL) => Response;
let sectionTreeLayoutResponse: () => Response;
let sectionTreeLayoutFetches: number;

beforeEach(() => {
  resetSectionTreeLayoutCacheForTests();
  lastUpstreamHost = null;
  lastUpstreamPath = null;
  upstreamPathHistory = [];
  upstreamHandler = () => new Response('<html>page</html>', { status: 200 });
  sectionTreeLayoutResponse = () => new Response(JSON.stringify({ version: 1, sections: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  sectionTreeLayoutFetches = 0;
  const cacheStore = new Map<string, Response>();
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

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const upstreamUrl = new URL(reqUrl);
    if (upstreamUrl.hostname === 'cdn.frontaliereticino.ch' && upstreamUrl.pathname === '/edge/section-tree-layout.json') {
      sectionTreeLayoutFetches += 1;
      return sectionTreeLayoutResponse();
    }
    lastUpstreamHost = upstreamUrl.hostname;
    lastUpstreamPath = upstreamUrl.pathname;
    upstreamPathHistory.push(upstreamUrl.pathname);
    return upstreamHandler(upstreamUrl);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe('locale-router Ticino-section shard routing', () => {
  it('routes the IT Ticino prefix to origin-ticino-it', async () => {
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/consulente-vendita-jumbo-sant-antonino-ticino-abc123/`),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.it);
  });

  it('fans out a Ticino page below its shared hash bucket', async () => {
    await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/consulente-vendita/`),
      {},
      ctx,
    );
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.it);
    expect(lastUpstreamPath).toBe(
      `/cerca-lavoro-ticino/_tree/${ticinoTreeBucket('consulente-vendita')}/consulente-vendita/`,
    );
  });

  it('routes the IT Ticino section root to origin-ticino-it', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.it);
    expect(lastUpstreamPath).toBe('/cerca-lavoro-ticino/');
  });

  it('keeps the physical root index at its canonical path', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/index.html`), {}, ctx);
    expect(lastUpstreamPath).toBe('/cerca-lavoro-ticino/index.html');
  });

  it('routes /en/find-jobs-ticino to origin-ticino-en, not origin-en', async () => {
    await worker.fetch(new Request(`${APEX}/en/find-jobs-ticino/some-job-zurich/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.en);
  });

  it('routes /de/jobs-im-tessin to origin-ticino-de', async () => {
    await worker.fetch(new Request(`${APEX}/de/jobs-im-tessin/irgendein-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.de);
  });

  it('routes /fr/trouver-emploi-tessin to origin-ticino-fr', async () => {
    await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/un-emploi/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.fr);
    expect(lastUpstreamPath).toBe(
      `/fr/trouver-emploi-tessin/_tree/${ticinoTreeBucket('un-emploi')}/un-emploi/`,
    );
  });

  it('proves hash-v1 support through a no-store HTTP probe', async () => {
    const response = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/?__frontaliere_ticino_tree_layout=hash-v1`, { method: 'HEAD' }),
      {},
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('x-frontaliere-ticino-tree-layout')).toBe('hash-v1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(upstreamPathHistory).toEqual([]);
  });

  it('proves hash-v1 support for Zurich through a no-store HTTP probe', async () => {
    const response = await worker.fetch(
      new Request(`${APEX}/de/jobs-in-zurich/?__frontaliere_zurigo_tree_layout=hash-v1`, { method: 'HEAD' }),
      {},
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('x-frontaliere-zurigo-tree-layout')).toBe('hash-v1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(upstreamPathHistory).toEqual([]);
  });

  it('reads the old first-two-character physical layout during migration', async () => {
    const slug = 'irgendein-job';
    const hashed = `/de/jobs-im-tessin/_tree/${ticinoTreeBucket(slug)}/${slug}/`;
    const legacy = `/de/jobs-im-tessin/_tree/${legacyTicinoTreeBucket(slug)}/${slug}/`;
    upstreamHandler = (url) => url.pathname === hashed
      ? new Response(null, { status: 404 })
      : url.pathname === legacy
        ? new Response('<html>legacy bucket</html>', { status: 200 })
        : new Response(null, { status: 404 });

    const response = await worker.fetch(new Request(`${APEX}/de/jobs-im-tessin/${slug}/`), {}, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('legacy bucket');
    expect(upstreamPathHistory).toEqual([hashed, legacy]);
  });

  it('retries the canonical path after both physical layouts miss', async () => {
    upstreamHandler = (url) => url.pathname.includes('/_tree/')
      ? new Response(null, { status: 404 })
      : new Response('<html>legacy</html>', { status: 200 });

    const response = await worker.fetch(
      new Request(`${APEX}/de/jobs-im-tessin/irgendein-job/`),
      {},
      ctx,
    );
    expect(response.status).toBe(200);
    expect(upstreamPathHistory).toEqual([
      `/de/jobs-im-tessin/_tree/${ticinoTreeBucket('irgendein-job')}/irgendein-job/`,
      `/de/jobs-im-tessin/_tree/${legacyTicinoTreeBucket('irgendein-job')}/irgendein-job/`,
      '/de/jobs-im-tessin/irgendein-job/',
    ]);
  });

  it('rewrites physical origin redirects back to the public path', async () => {
    upstreamHandler = () => new Response(null, {
      status: 302,
      headers: {
        location: `https://${SECTION_ORIGIN.ticino.it}/cerca-lavoro-ticino/_tree/co/consulente-vendita/`,
      },
    });

    const response = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/consulente-vendita/`),
      {},
      ctx,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${APEX}/cerca-lavoro-ticino/consulente-vendita/`,
    );
  });
});

describe('locale-router Svizzera-section shard routing', () => {
  it('routes the IT svizzera prefix to origin-svizzera-it', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-svizzera/qualche-lavoro/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.svizzera.it);
  });

  it('routes /en/find-jobs-switzerland to origin-svizzera-en, not origin-en', async () => {
    await worker.fetch(new Request(`${APEX}/en/find-jobs-switzerland/some-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.svizzera.en);
  });

  it('routes /de/jobs-in-schweiz to origin-svizzera-de', async () => {
    await worker.fetch(new Request(`${APEX}/de/jobs-in-schweiz/irgendein-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.svizzera.de);
  });

  it('routes /fr/trouver-emploi-suisse to origin-svizzera-fr', async () => {
    await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-suisse/un-emploi/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.svizzera.fr);
  });
});

describe('locale-router Zurigo-section shard routing', () => {
  it('routes the IT zurigo prefix to origin-zurigo-it', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo/qualche-lavoro/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.zurigo.it);
  });

  it('routes /en/find-jobs-zurich to origin-zurigo-en, not origin-en', async () => {
    await worker.fetch(new Request(`${APEX}/en/find-jobs-zurich/some-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.zurigo.en);
  });

  it('routes /de/jobs-in-zurich to origin-zurigo-de', async () => {
    await worker.fetch(new Request(`${APEX}/de/jobs-in-zurich/irgendein-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.zurigo.de);
  });

  it('fans out a Zurich page below its shared hash bucket', async () => {
    await worker.fetch(new Request(`${APEX}/de/jobs-in-zurich/irgendein-job/`), {}, ctx);
    expect(lastUpstreamPath).toBe(
      `/de/jobs-in-zurich/_tree/${sectionTreeBucket('irgendein-job')}/irgendein-job/`,
    );
  });

  it('retries the canonical Zurich path during hash-v1 migration', async () => {
    const slug = 'irgendein-job';
    const hashed = `/de/jobs-in-zurich/_tree/${sectionTreeBucket(slug)}/${slug}/`;
    upstreamHandler = (url) => url.pathname === hashed
      ? new Response(null, { status: 404 })
      : new Response('<html>canonical</html>', { status: 200 });

    const response = await worker.fetch(new Request(`${APEX}/de/jobs-in-zurich/${slug}/`), {}, ctx);
    expect(response.status).toBe(200);
    expect(upstreamPathHistory).toEqual([hashed, `/de/jobs-in-zurich/${slug}/`]);
  });

  it('routes /fr/trouver-emploi-zurich to origin-zurigo-fr', async () => {
    await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-zurich/un-emploi/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.zurigo.fr);
  });
});

describe('locale-router Berna-section shard routing', () => {
  it('routes and fans out a Berna page while keeping its public URL', async () => {
    const slug = 'berner-job';
    const response = await worker.fetch(new Request(`${APEX}/de/jobs-in-bern/${slug}/`), {}, ctx);
    expect(response.status).toBe(200);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.berna.de);
    expect(lastUpstreamPath).toBe(
      `/de/jobs-in-bern/_tree/${sectionTreeBucket(slug)}/${slug}/`,
    );
  });

  it('advertises the generic hash-v1 probe for Berna without an origin request', async () => {
    const response = await worker.fetch(
      new Request(`${APEX}/de/jobs-in-bern/?__frontaliere_section_tree_layout=hash-v1&section=berna`, { method: 'HEAD' }),
      {},
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('x-frontaliere-section-tree-layout')).toBe('hash-v1');
    expect(response.headers.get('x-frontaliere-section')).toBe('berna');
    expect(response.headers.get('x-frontaliere-berna-tree-layout')).toBe('hash-v1');
    expect(upstreamPathHistory).toEqual([]);
  });

  it('exposes the expected static fan-out floor', () => {
    expect(SECTION_TREE_FANOUT_SECTIONS).toEqual(['ticino', 'zurigo', 'berna']);
  });

  it('routes registry-fanned sections through hash-v1 and falls back to the canonical path during migration', async () => {
    const route = SECTION_ROUTES.find((entry: { section: string; locale: string }) => entry.section === 'lucerna' && entry.locale === 'de');
    expect(route).toBeDefined();
    sectionTreeLayoutResponse = () => new Response(JSON.stringify({
      version: 1,
      sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    upstreamHandler = (url) => url.pathname.includes('/_tree/')
      ? new Response(null, { status: 404 })
      : new Response('<html>canonical fallback</html>', { status: 200 });

    const page = `${APEX}${route.prefix}/sample-job/`;
    const response = await worker.fetch(new Request(page), {}, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('canonical fallback');
    expect(upstreamPathHistory).toEqual([
      route.prefix + `/_tree/${sectionTreeBucket('sample-job')}/sample-job/`,
      route.prefix + '/sample-job/',
    ]);
    expect(sectionTreeLayoutFetches).toBe(1);
  });

  it('advertises hash-v1 through the generic probe for a registry-fanned section', async () => {
    const route = SECTION_ROUTES.find((entry: { section: string; locale: string }) => entry.section === 'lucerna' && entry.locale === 'de');
    expect(route).toBeDefined();
    sectionTreeLayoutResponse = () => new Response(JSON.stringify({
      version: 1,
      sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await worker.fetch(new Request(
      `${APEX}${route.prefix}/?__frontaliere_section_tree_layout=hash-v1&section=lucerna`,
      { method: 'HEAD' },
    ), {}, ctx);
    expect(response.status).toBe(204);
    expect(response.headers.get('x-frontaliere-section-tree-layout')).toBe('hash-v1');
    expect(response.headers.get('x-frontaliere-section')).toBe('lucerna');
    expect(response.headers.get('x-frontaliere-lucerna-tree-layout')).toBe('hash-v1');
    expect(upstreamPathHistory).toEqual([]);
  });

  it('serves a newly fanned tree through a stale isolate registry after the canonical path misses', async () => {
    const route = SECTION_ROUTES.find((entry: { section: string; locale: string }) => entry.section === 'lucerna' && entry.locale === 'de');
    expect(route).toBeDefined();
    let registered = false;
    sectionTreeLayoutResponse = () => new Response(JSON.stringify({
      version: 1,
      sections: registered
        ? { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } }
        : {},
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    upstreamHandler = (url) => new Response('<html>canonical</html>', { status: 200 });

    const root = await worker.fetch(new Request(`${APEX}${route.prefix}/`), {}, ctx);
    expect(root.status).toBe(200);
    expect(sectionTreeLayoutFetches).toBe(1);

    registered = true;
    upstreamPathHistory = [];
    upstreamHandler = (url) => url.pathname.includes('/_tree/')
      ? new Response('<html>hash-v1</html>', { status: 200 })
      : new Response(null, { status: 404 });
    const page = await worker.fetch(new Request(`${APEX}${route.prefix}/after-registry-write/`), {}, ctx);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('hash-v1');
    expect(upstreamPathHistory).toEqual([
      route.prefix + '/after-registry-write/',
      route.prefix + `/_tree/${sectionTreeBucket('after-registry-write')}/after-registry-write/`,
    ]);
    expect(sectionTreeLayoutFetches).toBe(1);
  });

  it('rewrites a registry-fanned physical redirect back to its public URL', async () => {
    const route = SECTION_ROUTES.find((entry: { section: string; locale: string }) => entry.section === 'lucerna' && entry.locale === 'de');
    expect(route).toBeDefined();
    sectionTreeLayoutResponse = () => new Response(JSON.stringify({
      version: 1,
      sections: { lucerna: { layout: 'hash-v1', since: '2026-11-12T00:00:00.000Z', reason: { locale: 'de', pct: 44.2 } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    upstreamHandler = (url) => new Response(null, {
      status: 301,
      headers: { location: `https://${SECTION_ORIGIN.lucerna.de}${url.pathname}continued/` },
    });

    const slug = 'sample-job';
    const response = await worker.fetch(new Request(`${APEX}${route.prefix}/${slug}/`), {}, ctx);
    expect(response.status).toBe(301);
    expect(new URL(response.headers.get('location') as string).pathname).toBe(`${route.prefix}/${slug}/continued/`);
    expect(new URL(response.headers.get('location') as string).hostname).toBe('frontaliereticino.ch');
  });
});

// The 24 sections added alongside ticino/svizzera/zurigo (22 cantons + the 2
// article-hub sections) — every SECTION_ROUTES entry not already covered by
// name above. Iterated straight from the real table (named-exported solely
// for this) instead of a hand-copied list, so a future section addition
// can't silently go untested.
const REMAINING_SECTION_ROUTES = SECTION_ROUTES.filter(
  (r: { section: string }) => !['ticino', 'svizzera', 'zurigo'].includes(r.section),
);

describe('locale-router remaining-section shard routing (all cantons + article hubs)', () => {
  it.each(REMAINING_SECTION_ROUTES)('routes $locale $prefix to origin-$section-$locale', async ({ section, prefix, locale }: { section: string; prefix: string; locale: string }) => {
    await worker.fetch(new Request(`${APEX}${prefix}/some-page/`), {}, ctx);
    expect(lastUpstreamHost).toBe(`origin-${section}-${locale}.frontaliereticino.ch`);
  });
});

describe('locale-router section-shard regression guards', () => {
  it('still routes an ordinary non-sharded EN path to origin-en (regression guard)', async () => {
    // Every canton URL-group is now a section shard (see SECTION_ROUTES), so
    // /en/find-jobs-bern — the prior control path here — now correctly routes
    // to origin-berna-en (covered by the "remaining-section" describe block
    // above) instead of serving as a "not a section" example. /en/find-jobs/
    // (no canton suffix at all) is not a prefix of any SECTION_ROUTES entry,
    // so matchSection must return null for it and it must fall through to
    // the generic whole-locale shard router (LOCALE_RE), landing on origin-en.
    await worker.fetch(new Request(`${APEX}/en/find-jobs/some-job/`), {}, ctx);
    expect(lastUpstreamHost).toBe('origin-en.frontaliereticino.ch');
  });

  it('does NOT route a look-alike section to a section shard', async () => {
    // /cerca-lavoro-ticino-altro must not match the Ticino prefix; as a non-locale
    // IT path it is an apex passthrough (upstream host stays the public apex).
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino-altro/x/`), {}, ctx);
    expect(lastUpstreamHost).toBe('frontaliereticino.ch');
  });

  it('does NOT route a look-alike svizzera/zurigo section to a section shard', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-svizzera-altro/x/`), {}, ctx);
    expect(lastUpstreamHost).toBe('frontaliereticino.ch');
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo-altro/x/`), {}, ctx);
    expect(lastUpstreamHost).toBe('frontaliereticino.ch');
  });

  it('leaves a non-section IT path as an apex passthrough', async () => {
    await worker.fetch(new Request(`${APEX}/calcola-stipendio/`), {}, ctx);
    expect(lastUpstreamHost).toBe('frontaliereticino.ch');
  });
});

describe('locale-router section-shard happy path', () => {
  it('serves the Ticino 200 happy path with public Cache-Control', async () => {
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/some-slug/`),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=');
    expect(await res.text()).toBe('<html>page</html>');
  });

  it('serves the svizzera 200 happy path with public Cache-Control', async () => {
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-svizzera/some-slug/`),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=');
    expect(await res.text()).toBe('<html>page</html>');
  });

  it('serves the zurigo 200 happy path with public Cache-Control', async () => {
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-zurigo/some-slug/`),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=');
    expect(await res.text()).toBe('<html>page</html>');
  });
});
