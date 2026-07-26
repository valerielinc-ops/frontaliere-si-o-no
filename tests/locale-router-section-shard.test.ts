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
import worker, { SECTION_ROUTES } from '../infra/cloudflare-worker/locale-router.js';

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
};

/** Capture the upstream host the Worker fetches for a given public path. */
let lastUpstreamHost: string | null;

beforeEach(() => {
  lastUpstreamHost = null;
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
    lastUpstreamHost = new URL(reqUrl).hostname;
    return new Response('<html>page</html>', { status: 200 });
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

  it('routes the IT Ticino section root to origin-ticino-it', async () => {
    await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.ticino.it);
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

  it('routes /fr/trouver-emploi-zurich to origin-zurigo-fr', async () => {
    await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-zurich/un-emploi/`), {}, ctx);
    expect(lastUpstreamHost).toBe(SECTION_ORIGIN.zurigo.fr);
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
