import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCscAdapterConfig,
  canonicalCscDetailUrl,
  fetchCscJobUrls,
  parseCscPrimaryJobDetail,
  parseCscCareersPage,
  verifyCscDetailUrls,
} from '../scripts/update-csc-costruzioni-jobs.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';

type DetailFixture = { url: string; html: string };
type CscFixture = {
  listingWithJobs: string;
  authoritativeEmpty: string;
  degradedListing: string;
  details: DetailFixture[];
};

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'csc-careers-pages.json'), 'utf8'),
) as CscFixture;
const careersUrl = 'https://csc-sa.ch/lavoro-carriera-edilizia';

function htmlResponse(url: string, html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/html; charset=UTF-8' : null },
    text: async () => html,
  };
}

function fixtureFetch(overrides: Record<string, ReturnType<typeof htmlResponse>> = {}) {
  const responses = new Map<string, ReturnType<typeof htmlResponse>>([
    [careersUrl, htmlResponse(careersUrl, fixture.listingWithJobs)],
    ...fixture.details.map((detail) => [detail.url, htmlResponse(detail.url, detail.html)] as const),
    ...Object.entries(overrides),
  ]);
  return vi.fn(async (url: string | URL) => {
    const response = responses.get(String(url));
    if (!response) throw new Error(`Unexpected URL ${url}`);
    return response;
  });
}

describe('CSC authoritative Drupal discovery', () => {
  it('recognises only the three CSC detail route families', () => {
    for (const detail of fixture.details) expect(canonicalCscDetailUrl(detail.url)).toBe(detail.url);
    expect(canonicalCscDetailUrl(careersUrl)).toBeNull();
    expect(canonicalCscDetailUrl('https://csc-sa.ch/node/24')).toBeNull();
    expect(canonicalCscDetailUrl('https://csc-sa.ch/node/321?preview=1')).toBeNull();
    expect(canonicalCscDetailUrl('https://other.example/node/321')).toBeNull();
    expect(canonicalCscDetailUrl('http://csc-sa.ch/node/321')).toBeNull();
  });

  it('verifies exact listing/detail parity before returning explicit seeds', async () => {
    const fetchImpl = fixtureFetch();
    const discovery = await fetchCscJobUrls({ fetchImpl, timeoutMs: 1000 });

    expect(discovery).toEqual({
      urls: fixture.details.map((detail) => detail.url),
      authoritativeEmpty: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + fixture.details.length);
    expect(new Set(discovery.urls).size).toBe(discovery.urls.length);
    expect(fixture.details.map((detail) => parseCscPrimaryJobDetail(detail.html)?.identity)).toEqual([
      'drupal-node:301',
      'drupal-node:321',
      'drupal-node:322',
    ]);
  });

  it('accepts the live-shaped explicit empty state without probing details', async () => {
    const fetchImpl = fixtureFetch({
      [careersUrl]: htmlResponse(careersUrl, fixture.authoritativeEmpty),
    });
    await expect(fetchCscJobUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toEqual({
      urls: [],
      authoritativeEmpty: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed on truncated listings and partial detail responses', async () => {
    expect(() => parseCscCareersPage(fixture.degradedListing)).toThrow(/discovery degraded/);

    const failedUrl = fixture.details[1].url;
    const fetchImpl = fixtureFetch({ [failedUrl]: htmlResponse(failedUrl, '<html>upstream error</html>', 503) });
    await expect(fetchCscJobUrls({ fetchImpl, timeoutMs: 1000 })).rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects detail redirects and non-job response shells', async () => {
    const collisionFetch = vi.fn(async (url: string | URL) => {
      const detail = fixture.details[0];
      return htmlResponse(detail.url, detail.html);
    });
    await expect(verifyCscDetailUrls(
      fixture.details.slice(0, 2).map((detail) => detail.url),
      { fetchImpl: collisionFetch, timeoutMs: 1000 },
    )).rejects.toThrow(/redirected outside its exact detail contract/);

    const shellUrl = fixture.details[0].url;
    await expect(verifyCscDetailUrls([shellUrl], {
      fetchImpl: vi.fn(async () => htmlResponse(shellUrl, '<!doctype html><html><body>career shell</body></html>')),
      timeoutMs: 1000,
    })).rejects.toThrow(/did not return a canonical work-position page/);
  });

  it('rejects job markers that exist only inside a related-vacancy widget', async () => {
    const shellUrl = fixture.details[0].url;
    const widgetShell = '<!doctype html><html><body><main><article data-history-node-id="24" class="node node--type-page"><h1>Pagina generica</h1><aside><article class="node node--type-work-position"><script type="application/ld+json">{"@type":"JobPosting","title":"Vacancy correlata"}</script></article></aside></article></main></body></html>';
    expect(parseCscPrimaryJobDetail(widgetShell)).toBeNull();
    await expect(verifyCscDetailUrls([shellUrl], {
      fetchImpl: vi.fn(async () => htmlResponse(shellUrl, widgetShell)),
      timeoutMs: 1000,
    })).rejects.toThrow(/did not return a canonical work-position page/);
  });

  it('finds the primary work-position article when a sibling widget article renders first in <main>', () => {
    const trailingText = 'Ricerchiamo un operaio edile qualificato per cantieri in Ticino, esperienza minima tre anni richiesta.';
    const siblingShell = `<!doctype html><html><body><main><article data-history-node-id="24" class="node node--type-related"><h1>Offerte correlate</h1><p>Contenuto correlato non pertinente.</p></article><article data-history-node-id="401" class="node node--type-work-position"><h1>Operaio edile</h1><p>${trailingText}</p></article></main></body></html>`;
    const detail = parseCscPrimaryJobDetail(siblingShell);
    expect(detail).toEqual({ identity: 'drupal-node:401', nodeId: '401', hasJobPosting: false });
  });

  it('does not truncate articleText when the primary article nests another <article>', () => {
    const trailingText = 'Ricerchiamo un operaio edile qualificato per cantieri in Ticino, esperienza minima tre anni richiesta.';
    const nestedShell = `<!doctype html><html><body><main><article data-history-node-id="401" class="node node--type-work-position"><h1>Operaio edile</h1><aside><article class="node node--type-related">Contenuto correlato non pertinente.</article></aside><p>${trailingText}</p></article></main></body></html>`;
    const detail = parseCscPrimaryJobDetail(nestedShell);
    expect(detail).toEqual({ identity: 'drupal-node:401', nodeId: '401', hasJobPosting: false });
  });

  it('ignores nested widget text when computing the fallback semantic hash', () => {
    const primaryText = 'Ricerchiamo un capo cantiere qualificato per progetti edili in Ticino, esperienza pluriennale richiesta.';
    const shellFor = (widgetText: string) =>
      `<!doctype html><html><body><main><article class="node node--type-work-position"><h1>Capo cantiere</h1><aside><article class="node node--type-related">${widgetText}</article></aside><p>${primaryText}</p></article></main></body></html>`;

    const first = parseCscPrimaryJobDetail(shellFor('Altre offerte correlate: magazziniere, autista.'));
    const second = parseCscPrimaryJobDetail(shellFor('Altre offerte correlate: elettricista, saldatore, gruista.'));

    expect(first).toMatchObject({ hasJobPosting: false });
    expect(first?.identity).toMatch(/^semantic:/);
    expect(second?.identity).toBe(first?.identity);
  });

  it('differentiates the fallback semantic hash for near-identical postings that only differ by a location marker carried in markup attributes', async () => {
    const bodyText = 'Ricerchiamo un operaio edile qualificato per cantieri edili, esperienza pluriennale richiesta.';
    const shellFor = (location: string) =>
      `<!doctype html><html><body><main><article class="node node--type-work-position"><h1>Operaio edile</h1><p>${bodyText}</p><span class="icon-location" data-location="${location}"></span></article></main></body></html>`;

    const bellinzona = parseCscPrimaryJobDetail(shellFor('Bellinzona'));
    const locarno = parseCscPrimaryJobDetail(shellFor('Locarno'));
    expect(bellinzona).toMatchObject({ hasJobPosting: false });
    expect(bellinzona?.identity).toMatch(/^semantic:/);
    expect(locarno?.identity).not.toBe(bellinzona?.identity);

    const urlBellinzona = 'https://csc-sa.ch/lavoro-carriera-edilizia/operaio-edile-bellinzona';
    const urlLocarno = 'https://csc-sa.ch/lavoro-carriera-edilizia/operaio-edile-locarno';
    const verified = await verifyCscDetailUrls([urlBellinzona, urlLocarno], {
      fetchImpl: vi.fn(async (url: string | URL) => {
        if (String(url) === urlBellinzona) return htmlResponse(urlBellinzona, shellFor('Bellinzona'));
        if (String(url) === urlLocarno) return htmlResponse(urlLocarno, shellFor('Locarno'));
        throw new Error(`Unexpected URL ${url}`);
      }),
      timeoutMs: 1000,
    });
    expect(verified).toEqual([urlBellinzona, urlLocarno]);
  });

  it('fails closed when the primary article never closes', () => {
    const unclosedShell = '<!doctype html><html><body><main><article data-history-node-id="401" class="node node--type-work-position"><h1>Operaio edile</h1><p>Testo senza chiusura del tag article primario.</p></main></body></html>';
    expect(parseCscPrimaryJobDetail(unclosedShell)).toBeNull();
  });

  it('accepts a legitimately long primary article whose raw markup exceeds the extractBalancedTagBlock scan cap', () => {
    // Padding well past the old 50,000-char scan cap (#7067) with nested,
    // depth-balanced <span> markup so a naive close-tag scan would still
    // find a </article> inside the window — the real regression was the
    // fail-closed reject, not a missing close tag.
    const padding = '<span>Descrizione dettagliata del cantiere e dei requisiti richiesti. </span>'.repeat(1000);
    const longShell = `<!doctype html><html><body><main><article data-history-node-id="401" class="node node--type-work-position"><h1>Operaio edile</h1><p>${padding}</p></article></main></body></html>`;
    expect(padding.length).toBeGreaterThan(50000);
    const detail = parseCscPrimaryJobDetail(longShell);
    expect(detail).toEqual({ identity: 'drupal-node:401', nodeId: '401', hasJobPosting: false });
  });

  it('fails closed when two Drupal routes expose the same semantic vacancy', async () => {
    const [first, alias] = fixture.details;
    const identitylessHtml = first.html.replace(/ data-history-node-id="301"/, '');
    const aliasFetch = fixtureFetch({
      [first.url]: htmlResponse(first.url, identitylessHtml),
      [alias.url]: htmlResponse(alias.url, identitylessHtml),
    });
    await expect(verifyCscDetailUrls([first.url, alias.url], {
      fetchImpl: aliasFetch,
      timeoutMs: 1000,
    })).rejects.toThrow(/share semantic identity semantic:/);
  });

  it('accepts a response URL that only adds a benign query string over the candidate', async () => {
    const detail = fixture.details[0];
    const verified = await verifyCscDetailUrls([detail.url], {
      fetchImpl: vi.fn(async () => htmlResponse(`${detail.url}?cb=123`, detail.html)),
      timeoutMs: 1000,
    });
    expect(verified).toEqual([detail.url]);
  });

  it('still rejects a redirect to a different route even when it also carries a query string', async () => {
    const [first, alias] = fixture.details;
    await expect(verifyCscDetailUrls([first.url], {
      fetchImpl: vi.fn(async () => htmlResponse(`${alias.url}?cb=123`, alias.html)),
      timeoutMs: 1000,
    })).rejects.toThrow(/redirected outside its exact detail contract/);
  });

  it('requires the final URL supplied by production fetch responses', async () => {
    const detail = fixture.details[0];
    await expect(verifyCscDetailUrls([detail.url], {
      fetchImpl: vi.fn(async () => ({ ...htmlResponse(detail.url, detail.html), url: '' })),
      timeoutMs: 1000,
    })).rejects.toThrow(/returned no final response URL/);
  });

  it('builds an idempotent adapter with no generic listing seeds', () => {
    const seedDetailUrls = fixture.details.map((detail) => detail.url);
    const updatedAt = 'fixed-for-test';
    const adapter = buildCscAdapterConfig(
      { companyKey: 'csc-costruzioni', seedUrls: [careersUrl], notes: 'preserved' },
      seedDetailUrls,
      updatedAt,
    );
    expect(adapter).toMatchObject({ companyKey: 'csc-costruzioni', seedDetailUrls, notes: 'preserved', updatedAt });
    expect(adapter.seedUrls).toBeUndefined();
    expect(buildCscAdapterConfig(adapter, seedDetailUrls, updatedAt)).toEqual(adapter);

    const emptyAdapter = buildCscAdapterConfig(adapter, [], updatedAt);
    expect(emptyAdapter.seedUrls).toBeUndefined();
    expect(emptyAdapter.seedDetailUrls).toEqual([]);
  });

  it('routes all representative details through explicit trust with stable canonical URLs', () => {
    const parsedUrls = fixture.details.map((detail) => {
      const json = detail.html.match(/<script type=\"application\/ld\+json\">([\s\S]*?)<\/script>/)?.[1];
      expect(json).toBeTruthy();
      const parsed = sharedCrawlerTestables.toJobFromJsonLd(
        JSON.parse(String(json)),
        'CSC Costruzioni SA',
        detail.url,
        { isSeedDetail: true, seedMeta: { canton: 'TI', location: 'Lugano' } },
      );
      expect(parsed).toMatchObject({ reason: null, job: { url: detail.url, company: 'CSC Costruzioni SA', canton: 'TI' } });
      return parsed.job.url;
    });
    expect(parsedUrls).toEqual(fixture.details.map((detail) => detail.url));
    expect(new Set(parsedUrls).size).toBe(fixture.details.length);
  });
});
