/**
 * Soft-404 contract of the locale-router Worker for job-detail URLs.
 *
 * Until 2026-10 every job-detail 404 whose slug matched no recovery was 301'd to
 * the canton listing (`/cerca-lavoro-ticino/lavoro-inesistente-abc-xyz-lugano/`
 * → `/cerca-lavoro-ticino/`), which Google classifies as a soft 404. Contract:
 *   - unknown slug (absent from /job-canon) → real 404, localized page, no
 *     client-side redirect, links to the section listing and the national board;
 *   - known old slug (canton drift) → one 301 straight to the live canonical;
 *   - known expired slug whose page is gone → unchanged 301 to the section root;
 *     an expired job whose origin still serves its page → untouched 200;
 *   - registry unavailable → temporary 503, never a guessed 404 or 301;
 *   - non-job 404 on an en/de/fr shard → localized title/lang, SPA hand-off kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { renderNotFoundPage } from '../infra/cloudflare-worker/locale-router.js';

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

type Map = Record<string, Record<string, string>>;

/**
 * Shard origins: `live` paths answer 200 (the Worker tries Ticino's physical
 * fan-out first and the public path last, so an exact match is enough),
 * anything else is the gh-pages 404. /job-canon answers `map`, a 404 (null) or `canonStatus`.
 */
function mockFetch({ map = null, live = [], canonStatus = 200 }: { map?: Map | null; live?: string[]; canonStatus?: number }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes('/job-canon/')) {
      if (canonStatus !== 200) return new Response('unavailable', { status: canonStatus });
      return map ? Response.json(map) : new Response('not found', { status: 404 });
    }
    const { pathname } = new URL(u);
    const isLive = live.includes(pathname);
    return isLive ? new Response('<html>live</html>', { status: 200 }) : new Response('gh-pages-404', { status: 404 });
  });
}

const UNKNOWN = [
  ['/cerca-lavoro-ticino/lavoro-inesistente-abc-xyz-lugano/', 'it', 'Offerta non trovata', '/cerca-lavoro-ticino/', '/cerca-lavoro-svizzera/'],
  ['/en/find-jobs-zurich/lavoro-inesistente-abc-xyz-lugano/', 'en', 'Job not found', '/en/find-jobs-zurich/', '/en/find-jobs-switzerland/'],
  ['/de/jobs-im-tessin/lavoro-inesistente-abc-xyz-lugano/', 'de', 'Stelle nicht gefunden', '/de/jobs-im-tessin/', '/de/jobs-in-schweiz/'],
  ['/fr/trouver-emploi-tessin/lavoro-inesistente-abc-xyz-lugano/', 'fr', 'Offre introuvable', '/fr/trouver-emploi-tessin/', '/fr/trouver-emploi-suisse/'],
] as const;

describe('unknown job slug → real 404 (no soft-404 301 to the listing)', () => {
  it.each(UNKNOWN)('%s', async (path, lang, title, section, board) => {
    // The listing is live: before this contract the Worker 301'd here.
    mockFetch({ map: null, live: [section, board] });

    const res = await worker.fetch(new Request(`${APEX}${path}`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=');
    const html = await res.text();
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(`<title>${title} — Frontaliere Ticino</title>`);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain(`href="${section}"`);
    expect(html).toContain(`href="${board}"`);
    // A client-side redirect to the listing would be the same soft 404 in the browser.
    expect(html).not.toMatch(/location\.replace|http-equiv="refresh"/);
  });

  it('a slug present in another shard of the registry but not this one is still unknown', async () => {
    mockFetch({ map: { 'altro-annuncio': { it: '/cerca-lavoro-ticino' } }, live: ['/cerca-lavoro-ticino/'] });
    const res = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/lavoro-inesistente-abc-xyz-lugano/`), {}, ctx);
    expect(res.status).toBe(404);
  });

  it('HEAD gets the same 404 status with no body', async () => {
    mockFetch({ map: null, live: ['/cerca-lavoro-ticino/'] });
    const res = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-ticino/lavoro-inesistente-abc-xyz-lugano/`, { method: 'HEAD' }),
      {},
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('an unreadable registry is a temporary 503, not a 404 nor a guessed 301', async () => {
    mockFetch({ canonStatus: 503, live: ['/cerca-lavoro-ticino/'] });
    const res = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/lavoro-inesistente-abc-xyz-lugano/`), {}, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('Location')).toBeNull();
  });
});

describe('known old slug → 301 in one hop', () => {
  it.each([
    ['/cerca-lavoro-ticino/sviluppatore-acme-lugano/', 'it', '/cerca-lavoro-zurigo'],
    ['/en/find-jobs-ticino/sviluppatore-acme-lugano/', 'en', '/en/find-jobs-zurich'],
    ['/de/jobs-im-tessin/sviluppatore-acme-lugano/', 'de', '/de/jobs-in-zurich'],
  ])('%s → its live canonical, which answers 200 (no second redirect)', async (path, locale, prefix) => {
    const canonical = `${prefix}/sviluppatore-acme-lugano/`;
    mockFetch({ map: { 'sviluppatore-acme-lugano': { [locale]: prefix } }, live: [canonical] });

    const first = await worker.fetch(new Request(`${APEX}${path}`), {}, ctx);
    expect(first.status).toBe(301);
    expect(first.headers.get('Location')).toBe(canonical);

    const second = await worker.fetch(new Request(`${APEX}${first.headers.get('Location')}`), {}, ctx);
    expect(second.status).toBe(200);
    expect(second.headers.get('Location')).toBeNull();
  });
});

describe('expired job → behaviour unchanged', () => {
  it('an expired job whose page is still on the origin stays a 200 (no registry lookup)', async () => {
    const fetchMock = mockFetch({ map: null, live: ['/de/jobs-im-tessin/abgelaufene-stelle/'] });
    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-tessin/abgelaufene-stelle/`), {}, ctx);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0] instanceof Request ? c[0].url : c[0]).includes('/job-canon/'))).toBe(false);
  });

  it('a registry-known expired job whose page is gone keeps the 301 to the section root', async () => {
    mockFetch({
      map: { 'abgelaufene-stelle': { de: '/de/jobs-im-tessin' } },
      live: ['/de/jobs-im-tessin/'],
    });
    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-tessin/abgelaufene-stelle/`), {}, ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-im-tessin/');
  });
});

describe('localized 404 page on en/de/fr shards (non-job paths)', () => {
  it.each([
    ['/en/questa-non-esiste/', 'en', 'Page not found', '/en/find-jobs-switzerland/'],
    ['/de/questa-non-esiste/', 'de', 'Seite nicht gefunden', '/de/jobs-in-schweiz/'],
    ['/fr/questa-non-esiste/', 'fr', 'Page introuvable', '/fr/trouver-emploi-suisse/'],
  ])('%s has a %s title and keeps the SPA hand-off', async (path, lang, title, board) => {
    mockFetch({ live: [] });
    const res = await worker.fetch(new Request(`${APEX}${path}`), {}, ctx);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(`<title>${title} — Frontaliere Ticino</title>`);
    expect(html).not.toContain('Pagina non trovata');
    expect(html).toContain(`href="${board}"`);
    // Same SPA fallback as public/404.html: save the URL, hand off to `/`.
    expect(html).toContain('sessionStorage.redirect');
    expect(html).toContain("location.replace('/')");
  });

  it('keeps the origin body for a non-document 404 (asset)', async () => {
    mockFetch({ live: [] });
    const res = await worker.fetch(new Request(`${APEX}/en/missing-image.png`), {}, ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('gh-pages-404');
  });

  it('renderNotFoundPage leaves IT non-job paths to the origin 404.html', () => {
    expect(renderNotFoundPage('/cerca-lavoro-ticino/a/b/', 'it')).toBeNull();
    expect(renderNotFoundPage('/en/x/', 'xx')).toBeNull();
  });

  it('never links a free-form canton segment the router does not know', () => {
    const html = renderNotFoundPage('/en/find-jobs-atlantis/some-job/', 'en');
    expect(html).not.toContain('href="/en/find-jobs-atlantis/"');
    expect(html).toContain('href="/en/find-jobs-switzerland/"');
  });
});
