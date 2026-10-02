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
import { SKIP_LIVE_DATA } from './helpers/live-data';
import {
  collectSpecListingRows,
  createSpecUrlPolicy,
  findNextListingPageUrl,
  isLastAnnouncedListingPage,
  largestAnnouncedListingPage,
  normalizeSpecPagination,
  readDeclaredListingTotal,
  stripListingPageState,
} from '../scripts/lib/prospector/spec-crawler.mjs';

const ORIGIN = 'https://jobs.example.ch';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const STELLENTREFF_PAGE_58 = fs.readFileSync(
  path.resolve(import.meta.dirname, 'fixtures/stellentreff-page-58.html'),
  'utf8',
);
const STELLENTREFF_PAGE_57_OVERSHOOT = fs.readFileSync(
  path.resolve(import.meta.dirname, 'fixtures/stellentreff-page-57-overshoot.html'),
  'utf8',
);

function listingPage({ ids, page, total, next }: { ids: string[], page: number, total?: number, next?: string }) {
  const query = page > 1 ? `?sf_paged=${page}` : '';
  const cards = ids.map((id) => `<div class="job"><h2><a href="${ORIGIN}/job/${id}/${query}" class="listing_link">Posizione ${id} a Lugano</a></h2></div>`).join('\n');
  const counter = total == null ? '' : `<p class="jobs_found"><span class="jobs_number">${total}</span> Jobs gefunden</p>`;
  const nextLink = next ? `<a class="nextpostslink" rel="next" aria-label="Nächste Seite" href="${next}">»</a>` : '';
  return `<html><head><title>Jobs</title></head><body>${counter}${cards}${nextLink}</body></html>`;
}

// A page is its HTML body, or a bare HTTP status the source answers with.
type SitePages = Record<string, string | number>;

function siteFetch(pages: SitePages, fetched: string[]) {
  return async (url: string) => {
    fetched.push(url);
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const body = pages[url];
    if (body == null) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (typeof body === 'number') return new Response('unavailable', { status: body, headers: { 'content-type': 'text/html' } });
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

async function collect(spec: any, pages: SitePages) {
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
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, total: 40, next: `${ORIGIN}/?sf_paged=2` })
        + `<a href="${ORIGIN}/?sf_paged=3">3</a>`,
    };
    await expect(collect(specWith({ pagination: PAGINATION }), pages)).rejects.toThrow(/HTTP 404/);
  });

  it('accetta un 404 successivo quando la copertura dichiarata e sufficiente', async () => {
    const pages = {
      [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2', 'sa3', 'sa4'], page: 1, total: 4, next: `${ORIGIN}/?sf_paged=2` })
        + `<a href="${ORIGIN}/?sf_paged=3">3</a>`,
    };
    const { rows } = await collect(specWith({ pagination: PAGINATION }), pages);
    expect(rows).toHaveLength(4);
  });

  it('accetta il 404 della pagina finale annunciata dal fixture reale Stellentreff', async () => {
    const pageUrl = 'https://www.stellentreff.ch/stellen/page/58/';
    const nextUrl = 'https://www.stellentreff.ch/stellen/page/59/';
    const spec = specWith({
      companyKey: 'stellentreff',
      companyName: 'Stellentreff AG',
      companyHost: 'stellentreff.ch',
      seedUrls: [pageUrl],
      detailTemplate: '/stellen/*/',
      pagination: { maxPages: 120 },
    });
    const { rows, fetched } = await collect(spec, { [pageUrl]: STELLENTREFF_PAGE_58 });
    expect(isLastAnnouncedListingPage(STELLENTREFF_PAGE_58, pageUrl, nextUrl)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(fetched).toContain(pageUrl);
    expect(fetched).toContain(nextUrl);
  });

  describe('pagine annunciate oltre la fine reale (fonte senza totale dichiarato)', () => {
    // Stellentreff, run corpus 36988228462: pagina 57 piena, annuncia 58 e 59,
    // entrambe 404. Il 404 sulla 58 non era l'ultima pagina annunciata e il
    // crawler falliva l'intero gruppo 10.
    const PAGE_57 = 'https://www.stellentreff.ch/stellen/page/57/';
    const PAGE_58 = 'https://www.stellentreff.ch/stellen/page/58/';
    const PAGE_59 = 'https://www.stellentreff.ch/stellen/page/59/';
    const stellentreffSpec = () => specWith({
      companyKey: 'stellentreff',
      companyName: 'Stellentreff AG',
      companyHost: 'stellentreff.ch',
      seedUrls: [PAGE_57],
      detailTemplate: '/stellen/*/',
      pagination: { maxPages: 120 },
    });

    it('chiude la listing al primo 404 quando anche l\'ultima pagina annunciata non esiste', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(isLastAnnouncedListingPage(STELLENTREFF_PAGE_57_OVERSHOOT, PAGE_57, PAGE_58)).toBe(false);
      expect(largestAnnouncedListingPage(STELLENTREFF_PAGE_57_OVERSHOOT, PAGE_57, PAGE_58))
        .toEqual({ number: 59, url: PAGE_59 });

      const { rows, fetched } = await collect(stellentreffSpec(), { [PAGE_57]: STELLENTREFF_PAGE_57_OVERSHOOT });

      expect(rows.map((row) => row.url)).toEqual([
        'https://www.stellentreff.ch/stellen/zimmermann-zimmerin-beispielort-dauerstelle-100001/',
        'https://www.stellentreff.ch/stellen/zimmermann-zimmerin-vorarbeiter-in-beispielort-dauerstelle-100002/',
      ]);
      expect(fetched.filter((url) => !url.endsWith('/robots.txt'))).toEqual([PAGE_57, PAGE_58, PAGE_59]);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n'))
        .toMatch(/page\/58\/ risponde HTTP 404 dopo 1 pagine; fine della paginazione accettata \(anche l'ultima pagina annunciata .*page\/59\/ risponde 404\)/);
    });

    it('fallisce chiuso quando la pagina annunciata dopo il 404 esiste (buco a meta listing)', async () => {
      await expect(collect(stellentreffSpec(), {
        [PAGE_57]: STELLENTREFF_PAGE_57_OVERSHOOT,
        [PAGE_59]: listingPage({ ids: ['sa9'], page: 59 }),
      })).rejects.toThrow(/page\/58\/ risponde HTTP 404 ma la pagina annunciata .*page\/59\/ esiste/);
    });

    it('fallisce chiuso quando la verifica dell\'ultima pagina annunciata non da una risposta definitiva', async () => {
      await expect(collect(stellentreffSpec(), {
        [PAGE_57]: STELLENTREFF_PAGE_57_OVERSHOOT,
        [PAGE_59]: 503,
      })).rejects.toThrow(/Prospector fetch failed for .*page\/58\/: HTTP 404/);
    });

    it('fallisce chiuso quando la pagina appena letta non aveva annunci', async () => {
      const emptyPage = STELLENTREFF_PAGE_57_OVERSHOOT.replace(/<ul class="ff-job-list">[\s\S]*?<\/ul>/, '<ul class="ff-job-list"></ul>');
      await expect(collect(stellentreffSpec(), { [PAGE_57]: emptyPage }))
        .rejects.toThrow(/HTTP 404/);
    });

    it('fallisce chiuso quando il 404 non e la pagina numerata successiva', async () => {
      const skipping = STELLENTREFF_PAGE_57_OVERSHOOT.replace(
        'rel="next" href="https://www.stellentreff.ch/stellen/page/58/"',
        'rel="next" href="https://www.stellentreff.ch/stellen/page/60/"',
      );
      await expect(collect(stellentreffSpec(), { [PAGE_57]: skipping }))
        .rejects.toThrow(/page\/60\/: HTTP 404/);
    });

    it('chiude al primo 404 una listing con solo rel=next e nessuna pagina numerata', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pages = {
        [`${ORIGIN}/`]: listingPage({ ids: ['sa1', 'sa2'], page: 1, next: `${ORIGIN}/?sf_paged=2` }),
        [`${ORIGIN}/?sf_paged=2`]: listingPage({ ids: ['sa3'], page: 2, next: `${ORIGIN}/?sf_paged=3` }),
      };
      const { rows, fetched } = await collect(specWith({ pagination: { maxPages: 10, pageStateParams: ['sf_paged'] } }), pages);
      expect(rows).toHaveLength(3);
      expect(fetched.filter((url) => !url.endsWith('/robots.txt'))).toEqual([
        `${ORIGIN}/`,
        `${ORIGIN}/?sf_paged=2`,
        `${ORIGIN}/?sf_paged=3`,
      ]);
    });
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

  it('richiede un controllo numerato distinto dal rel=next', () => {
    const pageUrl = `${ORIGIN}/jobs/page/58`;
    const nextUrl = `${ORIGIN}/jobs/page/59`;
    expect(isLastAnnouncedListingPage(
      `<link rel="next" href="${nextUrl}">`,
      pageUrl,
      nextUrl,
    )).toBe(false);
    expect(isLastAnnouncedListingPage(
      `<link rel="next" href="${nextUrl}"><a href="${nextUrl}">59</a>`,
      pageUrl,
      nextUrl,
    )).toBe(true);
    expect(isLastAnnouncedListingPage(
      `<link rel="next" href="${nextUrl}"><a href="${nextUrl}">offerta</a>`,
      pageUrl,
      nextUrl,
    )).toBe(false);
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

  // I due casi qui sotto leggono le spec VIVE in data/prospector/crawlers/, che
  // il bot prospector riscrive: fuori dal gate delle PR, nel monitor post-merge
  // (replay del 2026-09-30: l'esito cambia con i dati di 7 e 14 giorni fa).
  it.skipIf(SKIP_LIVE_DATA)('la spec yellowshark dichiara la paginazione e il contatore reale della fonte', () => {
    const spec = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/prospector/crawlers/yellowshark.json'), 'utf8'));
    const pagination = normalizeSpecPagination(spec);
    // Markup osservato su https://jobs.yellowshark.com/ il 2026-09-28.
    const seed = '<p class="jobs_found"><span class="jobs_number">1103</span> Jobs gefunden</p>';
    expect(readDeclaredListingTotal(seed, pagination, spec)).toBe(1103);
    // 1103 annunci a 20 per pagina sono 56 pagine: il limite deve starci largo.
    expect(pagination.maxPages).toBeGreaterThanOrEqual(56);
    expect(pagination.pageStateParams).toEqual(['sf_paged']);
  });

  it.skipIf(SKIP_LIVE_DATA)('le spec promosse con una listing paginata dichiarano la paginazione', () => {
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
