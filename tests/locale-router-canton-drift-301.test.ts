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
import worker, { jobCanonTarget } from '../infra/cloudflare-worker/locale-router.js';

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
 * /job-canon/<sk>.json request returns `map` (or 404 when map is null). The map
 * value is the real per-locale object the plugin emits ({ it, en, de, fr }).
 */
function mockFetch(
  originStatus: number,
  map: Record<string, Record<string, string>> | null,
): void {
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
    mockFetch(404, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/some-job-xyz/');
  });

  it('301s within the request locale, never cross-locale to the IT page', async () => {
    // The slug exists under every locale (identical slug segment, localized
    // prefix). A /de orphan must 301 to the DE page, NOT the it prefix — the
    // cross-locale collapse this PR fixes.
    mockFetch(404, {
      'some-job-xyz': {
        it: '/cerca-lavoro-zurigo',
        en: '/en/find-jobs-zurich',
        de: '/de/jobs-in-zurich',
        fr: '/fr/trouver-emploi-zurich',
      },
    });

    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-zuerich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-in-zurich/some-job-xyz/');
  });

  it('falls through to the soft 404 when no prefix exists for the request locale', async () => {
    // Slug tracked only under it → a /en orphan must NOT 301 to the IT page; it
    // keeps the soft-404 path rather than emitting a permanent cross-locale 301.
    mockFetch(404, { 'some-job-xyz': { it: '/cerca-lavoro-zurigo' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
  });

  it('falls through to the soft 404 for a legacy string map value (stale deploy)', async () => {
    // A not-yet-rebuilt map may still hold the old flat string value; the Worker
    // must NOT 301 on it (would be cross-locale), it falls through to the 404.
    mockFetch(404, { 'some-job-xyz': '/en/find-jobs-zurich' as unknown as Record<string, string> });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
  });

  it('preserves query + hash on the 301 Location', async () => {
    mockFetch(404, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(
      new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/?utm=x#frag`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/some-job-xyz/?utm=x#frag');
  });

  it('falls through to the soft 404 for an unknown slug', async () => {
    mockFetch(404, { 'other-slug': { en: '/en/find-jobs-zurich' } });

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
    mockFetch(404, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/guida-frontaliere/`), {}, ctx);

    expect(res.status).toBe(404);
    // No /job-canon/ subrequest should have been attempted for a non-job path.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });

  it('does not 301 to the path already requested (no redirect loop)', async () => {
    // Map points the slug back at the same section it was requested under.
    mockFetch(404, { 'some-job-xyz': { en: '/en/jobs-in-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
  });

  it('leaves a healthy 200 untouched (no map lookup)', async () => {
    mockFetch(200, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(200);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });
});

// The build no longer writes a 200 copy of an expired (or active) non-TI job
// under the legacy TI section of en/de/fr (jobsSeoPagesPlugin: the 911k
// canonicalMismatch advisories of the full-corpus replay came from those
// copies). The shard origin therefore answers 404 for them, and THIS is what
// keeps them alive: a 301 to the job's canton page, inside the same locale.
describe('locale-router: legacy TI URL of a non-TI job (origin 404) → 301 to its canton', () => {
  const slug = 'zweigstelle-80-100-valiant-bank-ag-moutier';
  const registryEntry = {
    it: '/cerca-lavoro-giura',
    en: '/en/find-jobs-jura',
    de: '/de/jobs-im-jura',
    fr: '/fr/trouver-emploi-jura',
  };

  it.each([
    ['en', '/en/find-jobs-ticino', '/en/find-jobs-jura'],
    ['de', '/de/jobs-im-tessin', '/de/jobs-im-jura'],
    ['fr', '/fr/trouver-emploi-tessin', '/fr/trouver-emploi-jura'],
  ])('%s: %s/<slug>/ → %s/<slug>/', async (_loc, legacyRoot, cantonRoot) => {
    mockFetch(404, { [slug]: registryEntry });

    const res = await worker.fetch(new Request(`${APEX}${legacyRoot}/${slug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${cantonRoot}/${slug}/`);
  });

  it('answers HEAD with the same 301 as GET', async () => {
    mockFetch(404, { [slug]: registryEntry });

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/${slug}/`, { method: 'HEAD' }),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-jura/${slug}/`);
  });
});

// When the job's page in this locale has a DIFFERENT slug, `${prefix}/${slug}/`
// would not exist: jobCanonRedirectMapPlugin records the localized path as
// `alias` and the Worker 301s there, after seeing the target live.
describe('locale-router: registry alias for a localized slug', () => {
  const itSlug = 'acquirente-strategico-yellowshark-ag-weinfelden';
  const frTarget = '/fr/trouver-emploi-thurgovie/acheteur-strategique-yellowshark-ag-weinfelden';

  function mockAliasFetch(map: Record<string, unknown>, live: (url: URL) => number) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.includes('/job-canon/')) return Response.json(map);
      return new Response('x', { status: live(url) });
    });
  }

  it('fr legacy TI URL with the Italian slug → 301 to the French page in its canton', async () => {
    const fetchMock = mockAliasFetch(
      { [itSlug]: { it: '/cerca-lavoro-turgovia', alias: { fr: frTarget } } },
      (url) => (url.pathname === `${frTarget}/` && url.hostname === 'origin-turgovia-fr.frontaliereticino.ch' ? 200 : 404),
    );

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/?utm=x`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${frTarget}/?utm=x`);
    // The alias target was verified on its own shard before the permanent 301.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).includes(frTarget)),
    ).toBe(true);
  });

  it('TI alias (same canton, localized slug) → 301 to the localized TI page through the physical fan-out', async () => {
    const enTarget = '/en/find-jobs-ticino/buyer-food-bell-schweiz-ag';
    mockAliasFetch(
      { 'acquirente-food-bell-schweiz-ag': { it: '/cerca-lavoro-ticino', alias: { en: enTarget } } },
      (url) => (
        url.hostname === 'origin-ticino-en.frontaliereticino.ch' && url.pathname.endsWith('/buyer-food-bell-schweiz-ag/')
          ? 200
          : 404
      ),
    );

    const res = await worker.fetch(new Request(`${APEX}/en/find-jobs-ticino/acquirente-food-bell-schweiz-ag/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${enTarget}/`);
  });

  it('does not 301 to an alias whose target is not live', async () => {
    mockAliasFetch({ [itSlug]: { alias: { fr: frTarget } } }, () => 404);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('answers 503, not a permanent verdict, when the alias target cannot be verified', async () => {
    mockAliasFetch({ [itSlug]: { alias: { fr: frTarget } } }, (url) => (url.pathname === `${frTarget}/` ? 503 : 404));

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('never follows an alias into another locale', async () => {
    mockAliasFetch({ [itSlug]: { alias: { fr: '/en/find-jobs-thurgau/strategic-buyer' } } }, () => 200);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).not.toBe(301);
  });

  it('lets an exact prefix win over an alias (the slug really exists in this locale)', async () => {
    mockAliasFetch({ [itSlug]: { fr: '/fr/trouver-emploi-thurgovie', alias: { fr: frTarget } } }, () => 404);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-thurgovie/${itSlug}/`);
  });
});

describe('jobCanonTarget', () => {
  it('builds prefix targets, accepts same-locale aliases and refuses the rest', () => {
    expect(jobCanonTarget({ fr: '/fr/trouver-emploi-jura' }, 's', 'fr')).toBe('/fr/trouver-emploi-jura/s/');
    expect(jobCanonTarget({ alias: { fr: '/fr/trouver-emploi-jura/t' } }, 's', 'fr')).toBe('/fr/trouver-emploi-jura/t/');
    expect(jobCanonTarget({ alias: { fr: '/en/find-jobs-jura/t' } }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget({ alias: { it: '/fr/trouver-emploi-jura/t' } }, 's', 'it')).toBeNull();
    expect(jobCanonTarget({ alias: { fr: '/fr/x//t' } }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget({ alias: { fr: '/fr/x/t?q=1' } }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget({ alias: 'nope' }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget('legacy-string', 's', 'fr')).toBeNull();
  });
});
