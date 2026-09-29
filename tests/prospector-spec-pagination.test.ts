/**
 * Paginazione opt-in delle spec del prospector (`spec.pagination`).
 *
 * Caso reale: yellowshark dichiara 1103 annunci su 56 pagine e il runtime ne
 * leggeva solo la prima (20). Ogni annuncio scivolato a pagina 2 sembrava
 * chiuso: la miss grace archiviava offerte vive e la guardia anti-shrink
 * bloccava la slice (run corpus 36380344842). Questi casi fissano il contratto:
 * seguire `rel="next"`, tenere un solo URL per annuncio su ogni pagina e
 * fallire chiuso quando la lettura non copre il totale dichiarato dalla fonte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import {
  collectSpecListingRows,
  createSpecUrlPolicy,
  findNextListingPageUrl,
  normalizeSpecPagination,
  readDeclaredListingTotal,
  stripListingPageState,
} from '../scripts/lib/prospector/spec-crawler.mjs';

const ORIGIN = 'https://jobs.example.ch';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function listingPage({ ids, page, total, next }: { ids: string[], page: number, total?: number, next?: string }) {
  const query = page > 1 ? `?sf_paged=${page}` : '';
  const cards = ids.map((id) => `<div class="job"><h2><a href="${ORIGIN}/job/${id}/${query}" class="listing_link">Posizione ${id} a Lugano</a></h2></div>`).join('\n');
  const counter = total == null ? '' : `<p class="jobs_found"><span class="jobs_number">${total}</span> Jobs gefunden</p>`;
  const nextLink = next ? `<a class="nextpostslink" rel="next" aria-label="Nächste Seite" href="${next}">»</a>` : '';
  return `<html><head><title>Jobs</title></head><body>${counter}${cards}${nextLink}</body></html>`;
}

function siteFetch(pages: Record<string, string>, fetched: string[]) {
  return async (url: string) => {
    fetched.push(url);
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const body = pages[url];
    if (body == null) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

function specWith(extra: Record<string, unknown> = {}) {
  return {
    companyKey: 'example-board',
    companyName: 'Example Board',
    companyHost: 'jobs.example.ch',
    platform: '',
    mode: 'template',
    seedUrls: [`${ORIGIN}/`],
    detailTemplate: '/job/*/',
    sampleVacancyCount: 2,
    sampleTitles: [],
    sourceLang: 'it',
    learnedAt: '2026-09-19T00:00:00.000Z',
    ...extra,
  } as any;
}

async function collect(spec: any, pages: Record<string, string>) {
  const fetched: string[] = [];
  const policy = createSpecUrlPolicy(spec, { lookupImpl: publicLookup as any });
  try {
    const rows = await collectSpecListingRows(spec, {
      fetchImpl: siteFetch(pages, fetched),
      sleepImpl: async () => {},
      retries: 0,
      disableWafProxy: true,
    }, policy);
    return { rows, fetched };
  } finally {
    await (policy as any).dispatcher.close();
  }
}

const PAGINATION = {
  maxPages: 10,
  declaredTotalPattern: 'class="jobs_number"[^>]*>\\s*([\\d\'’.,]+)\\s*<',
  minCoverage: 0.95,
  pageStateParams: ['sf_paged'],
};

describe('spec.pagination', () => {
  beforeEach(() => clearPoliteFetchStateForTests());
  afterEach(() => {
    clearPoliteFetchStateForTests();
    vi.restoreAllMocks();
  });

  it('segue rel=next fino all\'ultima pagina e tiene un solo URL per annuncio', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, total: 5, next: `${ORIGIN}/?sf_paged=2` }),
      [`${ORIGIN}/?sf_paged=2`]: listingPage({ ids: ['sa3', 'sa4'], page: 2, total: 5, next: `${ORIGIN}/?sf_paged=3` }),
      // L'annuncio sa4 compare di nuovo: un'offerta chiusa durante la lettura
      // sposta la pagina successiva di una riga.
      [`${ORIGIN}/?sf_paged=3`]: listingPage({ ids: ['sa4', 'sa5'], page: 3, total: 5 }),
    };
    const { rows, fetched } = await collect(specWith({ pagination: PAGINATION }), pages);
    expect(rows.map((r) => r.url)).toEqual([
      `${ORIGIN}/job/sa1/`,
      `${ORIGIN}/job/sa2/`,
      `${ORIGIN}/job/sa3/`,
      `${ORIGIN}/job/sa4/`,
      `${ORIGIN}/job/sa5/`,
    ]);
    expect(fetched.filter((u) => !u.endsWith('/robots.txt'))).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/?sf_paged=2`,
      `${ORIGIN}/?sf_paged=3`,
    ]);
  });

  it('fallisce chiuso quando la lettura non copre il totale dichiarato (link next sparito)', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, total: 40 }),
    };
    await expect(collect(specWith({ pagination: PAGINATION }), pages))
      .rejects.toThrow(/listing incompleta: 2\/40/);
  });

  it('fallisce chiuso anche quando il totale arrotondato per difetto basterebbe', async () => {
    // 2/3 = 66,7%: con Math.floor(3 * 0.95) = 2 la guardia passava.
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, total: 3 }),
    };
    await expect(collect(specWith({ pagination: PAGINATION }), pages))
      .rejects.toThrow(/listing incompleta: 2\/3/);
  });

  it('fallisce chiuso quando rel=next torna a una pagina gia letta', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1'], page: 1, next: `${ORIGIN}/?sf_paged=2` }),
      [`${ORIGIN}/?sf_paged=2`]: listingPage({ ids: ['sa2'], page: 2, next: `${ORIGIN}/?sf_paged=2` }),
    };
    await expect(collect(specWith({ pagination: { maxPages: 10, pageStateParams: ['sf_paged'] } }), pages))
      .rejects.toThrow(/torna a una pagina gia letta/);
  });

  it('tratta un self-link finale come terminatore solo per una spec opt-in', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1'], page: 1, next: `${ORIGIN}/?sf_paged=2` }),
      [`${ORIGIN}/?sf_paged=2`]: listingPage({ ids: ['sa2'], page: 2, next: `${ORIGIN}/?sf_paged=2` }),
    };
    const { rows, fetched } = await collect(specWith({
      pagination: { maxPages: 10, pageStateParams: ['sf_paged'], selfNextIsTerminal: true },
    }), pages);
    expect(rows.map((row) => row.url)).toEqual([
      `${ORIGIN}/job/sa1/`,
      `${ORIGIN}/job/sa2/`,
    ]);
    expect(fetched.filter((url) => !url.endsWith('/robots.txt'))).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/?sf_paged=2`,
    ]);
  });

  it('fallisce chiuso quando maxPages si esaurisce con un next ancora presente', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1'], page: 1, total: 3, next: `${ORIGIN}/?sf_paged=2` }),
      [`${ORIGIN}/?sf_paged=2`]: listingPage({ ids: ['sa2'], page: 2, total: 3, next: `${ORIGIN}/?sf_paged=3` }),
    };
    await expect(collect(specWith({ pagination: { ...PAGINATION, maxPages: 2 } }), pages))
      .rejects.toThrow(/listing troncata: 2 pagine lette, maxPages=2/);
  });

  it('fallisce chiuso quando il contatore dichiarato non si trova piu nella pagina', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1 }),
    };
    await expect(collect(specWith({ pagination: PAGINATION }), pages))
      .rejects.toThrow(/totale dichiarato dalla fonte non trovato/);
  });

  it('una pagina successiva che risponde con errore non produce una listing parziale', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, total: 4, next: `${ORIGIN}/?sf_paged=2` }),
    };
    await expect(collect(specWith({ pagination: PAGINATION }), pages)).rejects.toThrow(/HTTP 404/);
  });

  it('senza spec.pagination legge solo il seed e segnala il next non seguito', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, total: 5, next: `${ORIGIN}/?sf_paged=2` }),
    };
    const { rows, fetched } = await collect(specWith(), pages);
    expect(rows).toHaveLength(2);
    expect(fetched).not.toContain(`${ORIGIN}/?sf_paged=2`);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n'))
      .toMatch(/rel=next non seguito \(https:\/\/jobs\.example\.ch\/\?sf_paged=2\)/);
  });
});

describe('helper di paginazione', () => {
  it('trova solo un next dello stesso origin, con rel multiplo e &amp;', () => {
    expect(findNextListingPageUrl('<a rel="nofollow next" href="/list?a=1&amp;page=2#top">»</a>', `${ORIGIN}/list`))
      .toBe(`${ORIGIN}/list?a=1&page=2`);
    expect(findNextListingPageUrl('<link rel="next" href="https://other.example/list?page=2">', `${ORIGIN}/list`))
      .toBeNull();
    expect(findNextListingPageUrl('<a rel="prev" href="/list?page=1">«</a>', `${ORIGIN}/list`)).toBeNull();
  });

  it('ignora un rel=next placeholder che punta a un fragment della pagina corrente', () => {
    expect(findNextListingPageUrl('<a rel="next" href="#">Pagina successiva</a>', `${ORIGIN}/list?page=3`))
      .toBeNull();
  });

  it('mantiene i fragment non-placeholder per la guardia anti-loop', () => {
    expect(findNextListingPageUrl('<a rel="next" href="#/page=2">Pagina successiva</a>', `${ORIGIN}/list?page=3`))
      .toBe(`${ORIGIN}/list?page=3`);
  });

  it('toglie dall\'URL di dettaglio solo i parametri di paginazione dichiarati', () => {
    const state = ['sf_paged'];
    expect(stripListingPageState(`${ORIGIN}/job/sa3/?sf_paged=2`, `${ORIGIN}/?sf_paged=2`, state)).toBe(`${ORIGIN}/job/sa3/`);
    expect(stripListingPageState(`${ORIGIN}/job/?id=7&sf_paged=2`, `${ORIGIN}/?sf_paged=2`, state)).toBe(`${ORIGIN}/job/?id=7`);
    expect(stripListingPageState(`${ORIGIN}/job/?id=7`, `${ORIGIN}/?sf_paged=2`, state)).toBe(`${ORIGIN}/job/?id=7`);
    // Un parametro reale del dettaglio condiviso con la listing resta.
    expect(stripListingPageState('https://x.test/job/7?lang=de&sf_paged=2', 'https://x.test/jobs?lang=de&sf_paged=2', state))
      .toBe('https://x.test/job/7?lang=de');
    // Senza parametri dichiarati l'URL non cambia.
    expect(stripListingPageState(`${ORIGIN}/job/sa3/?sf_paged=2`, `${ORIGIN}/?sf_paged=2`)).toBe(`${ORIGIN}/job/sa3/?sf_paged=2`);
  });

  it('legge il totale con separatori delle migliaia e usa default prudenti', () => {
    const pagination = normalizeSpecPagination(specWith({ pagination: PAGINATION }));
    expect(readDeclaredListingTotal('<span class="jobs_number">1’103</span>', pagination, specWith())).toBe(1103);
    expect(normalizeSpecPagination(specWith({ pagination: {} })))
      .toMatchObject({ maxPages: 50, minCoverage: 0.95, declaredTotalRx: null, pageStateParams: [] });
  });

  it('la spec yellowshark dichiara la paginazione e il contatore reale della fonte', () => {
    const spec = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/prospector/crawlers/yellowshark.json'), 'utf8'));
    const pagination = normalizeSpecPagination(spec);
    // Markup osservato su https://jobs.yellowshark.com/ il 2026-09-28.
    const seed = '<p class="jobs_found"><span class="jobs_number">1103</span> Jobs gefunden</p>';
    expect(readDeclaredListingTotal(seed, pagination, spec)).toBe(1103);
    // 1103 annunci a 20 per pagina sono 56 pagine: il limite deve starci largo.
    expect(pagination.maxPages).toBeGreaterThanOrEqual(56);
    expect(pagination.pageStateParams).toEqual(['sf_paged']);
  });

  it('le spec promosse con una listing paginata dichiarano la paginazione', () => {
    // Pagine misurate il 2026-09-28: pagina 2 di ciascun seed contiene annunci
    // assenti da pagina 1, quindi leggere solo il seed archivia offerte vive.
    const measuredPages: Record<string, number> = { yellowshark: 56, sta: 88, stellenpartner: 41, stellentreff: 57, gmo: 3 };
    for (const [key, pages] of Object.entries(measuredPages)) {
      const spec = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `data/prospector/crawlers/${key}.json`), 'utf8'));
      expect(spec.pagination, key).toBeTruthy();
      expect(normalizeSpecPagination(spec).maxPages, key).toBeGreaterThan(pages);
    }
    const gmo = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/prospector/crawlers/gmo.json'), 'utf8'));
    expect(normalizeSpecPagination(gmo).selfNextIsTerminal).toBe(true);
  });
});
