import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GE_PLATE_AUCTION_SOURCE } from '../functions/src/plateAuctionsCore.js';
import {
  classifyCantonDiscovery,
  classifyDiscovery,
  discoverGeSitemapListDocuments,
  discoverSources,
  extractGeListDocumentUrlsFromSitemap,
  extractOfficialDataLinks,
  extractSitemapPageUrls,
  probeGeOfficialList,
  READY_RECOMMENDATIONS,
  readyKeysOf,
  resolveDiscoveryUrl,
} from '../scripts/plate-auctions/discover-sources.mjs';

// Text of vente_enchere_pl_prosp_mai_26.pdf (12 cars, 6 motorcycles, 1 lot), shared with the connector test.
const MAY_2026 = readFileSync(new URL('./fixtures/ge-plate-auction-list-may-2026.txt', import.meta.url), 'utf8');

describe('plate-auction source discovery', () => {
  it('does not equate a reachable vehicle-office page with an auction feed', () => {
    const result = classifyDiscovery({ status: 200, title: 'Strassenverkehrsamt', body: 'Kontrollschilder bestellen' });
    expect(result.reachable).toBe(true);
    expect(result.recommendation).toBe('candidate-office-page-only');
  });

  it('flags an official page containing auction vocabulary for manual confirmation', () => {
    const result = classifyDiscovery({ status: 200, title: 'Auktion Kontrollschilder', body: 'Aktuelle Angebote' });
    expect(result.auctionSignal).toBe(true);
    expect(result.recommendation).toBe('manual-confirmation-needed');
  });

  it('keeps failed URLs out of activation decisions', () => {
    const result = classifyDiscovery({ status: 503, title: 'Unavailable', body: '' });
    expect(result.reachable).toBe(false);
    expect(result.recommendation).toBe('blocked-or-invalid-url');
  });

  it('requires a current official list before GE can be activated', () => {
    const pageWithoutList = classifyCantonDiscovery({
      key: 'ge',
      status: 200,
      title: 'Vente aux enchères de plaques',
      body: 'Prochaine vente : automne 2026',
    });
    expect(pageWithoutList.officialListSignal).toBe(false);
    expect(pageWithoutList.recommendation).toBe('blocked-until-official-list');

    // A link alone is not a validated list: without the connector's verdict
    // the page can only ask for a look.
    const pageWithList = classifyCantonDiscovery({
      key: 'ge',
      status: 200,
      title: 'Vente aux enchères de plaques',
      body: '<a href="/node/22794">Liste des numéros proposés à la vente</a>',
    });
    expect(pageWithList.officialListSignal).toBe(true);
    expect(pageWithList.recommendation).toBe('manual-confirmation-needed');
  });

  it('declares GE ready only when the connector reads plate rows for an open session', () => {
    const page = { key: 'ge', status: 200, title: 'Vente aux enchères de plaques', body: '<a href="/node/22794">Liste des numéros proposés à la vente</a>' };

    const open = classifyCantonDiscovery({ ...page, geList: { connectorRows: 19, sessionEndsAt: '2026-11-13T10:00:00.000Z', unknownListDocuments: [] } });
    expect(open.recommendation).toBe('ready-for-connector-check');

    // The May list is still linked after its session: zero open rows is not ready.
    const expired = classifyCantonDiscovery({ ...page, geList: { connectorRows: 0, unknownListDocuments: [] } });
    expect(expired.recommendation).toBe('blocked-until-official-list');

    // A linked list the parser cannot read may be a new layout: a look, not an activation.
    const unread = classifyCantonDiscovery({ ...page, geList: { connectorRows: 0, connectorError: 'GE: the auction list has no parsable session window', unknownListDocuments: [] } });
    expect(unread.recommendation).toBe('manual-confirmation-needed');

    // ge.ch unreachable from the connector with nothing pointing at a list stays blocked.
    const offline = classifyCantonDiscovery({ key: 'ge', status: 200, title: 'Vente aux enchères de plaques', body: 'Prochaine vente : automne 2026', geList: { connectorRows: 0, connectorError: 'fetch failed', unknownListDocuments: [] } });
    expect(offline.recommendation).toBe('blocked-until-official-list');
  });

  it('validates a GE list found only in the sitemap through the real connector, never touching Ricardo', async () => {
    const NEW_DOC = 'https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-novembre-2026';
    const NEW_PDF = 'https://www.ge.ch/document/24010/telecharger';
    const now = new Date('2026-10-20T08:00:00Z');
    const autumnList = MAY_2026.replace('dès le 11 au 20 mai 2026, 11h00', 'dès le 2 au 12 novembre 2026, 11h00');
    const documentPage = (id: number, updated: string) => `<html><head><title>Liste numéros de plaques mis aux enchères | ge.ch</title>
      <meta property="og:updated_time" content="${updated}" /></head><body><a href="/document/${id}/telecharger">pdf</a></body></html>`;
    const requested: string[] = [];
    const pages: Record<string, string> = {
      [GE_PLATE_AUCTION_SOURCE.pageUrl]: '<html><head><title>Vente aux enchères de plaques | ge.ch</title></head><body><p>Prochaine vente : automne 2026.</p></body></html>',
      'https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres': documentPage(22794, '2026-04-15T17:13:47+0200'),
      'https://www.ge.ch/document/liste-plaques-aux-encheres': documentPage(15062, '2025-10-17T14:30:06+0200'),
      [NEW_DOC]: documentPage(24010, '2026-10-14T09:02:11+0200'),
    };
    const injectedFetcher = async (url: string, options: { responseType?: string } = {}) => {
      requested.push(url);
      if (/ricardo/i.test(url)) throw new Error(`Ricardo must never be fetched: ${url}`);
      if (options.responseType === 'pdf-text') {
        const text = url === NEW_PDF ? autumnList : MAY_2026;
        return { text, pages: [text] };
      }
      return pages[url] ?? '';
    };

    const withoutSitemap = await probeGeOfficialList({ now, injectedFetcher });
    expect(withoutSitemap.connectorRows).toBe(0);

    const withSitemap = await probeGeOfficialList({ now, injectedFetcher, extraListDocumentUrls: [NEW_DOC] });
    expect(withSitemap.connectorRows).toBe(19);
    expect(withSitemap.listPdfUrl).toBe(NEW_PDF);
    expect(withSitemap.sessionEndsAt).toBe('2026-11-12T10:00:00.000Z');
    expect(withSitemap.unknownListDocuments).toEqual([NEW_DOC]);
    expect(requested.some((url) => /ricardo/i.test(url))).toBe(false);
  });

  it('finds OCV list documents in the ge.ch sitemap and skips the ones the connector knows', async () => {
    const index = `<sitemapindex><sitemap><loc>https://www.ge.ch/sitemap.xml?page=1</loc></sitemap>
      <sitemap><loc>https://www.ge.ch/sitemap.xml?page=2</loc></sitemap></sitemapindex>`;
    const page1 = `<urlset><url><loc>https://www.ge.ch/document/liste-plaques-aux-encheres</loc></url>
      <url><loc>https://www.ge.ch/document/reglement-vente-aux-encheres-plaques</loc></url>
      <url><loc>https://www.ge.ch/document/conditions-generales-vente-commandes-plaques</loc></url></urlset>`;
    const page2 = `<urlset><url><loc>https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres</loc></url>
      <url><loc>https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-0</loc></url>
      <url><loc>https://www.ge.ch/document/francais-ete-chapiteaux-enchantes</loc></url></urlset>`;

    expect(extractSitemapPageUrls(index)).toEqual(['https://www.ge.ch/sitemap.xml?page=1', 'https://www.ge.ch/sitemap.xml?page=2']);
    expect(extractGeListDocumentUrlsFromSitemap(page1)).toEqual(['https://www.ge.ch/document/liste-plaques-aux-encheres']);

    const bodies: Record<string, string> = {
      'https://www.ge.ch/sitemap.xml': index,
      'https://www.ge.ch/sitemap.xml?page=1': page1,
      'https://www.ge.ch/sitemap.xml?page=2': page2,
    };
    const unknown = await discoverGeSitemapListDocuments({
      fetcher: async (url: string) => ({ status: bodies[url] ? 200 : 404, text: async () => bodies[url] ?? '' }),
    });
    expect(unknown).toEqual(['https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-0']);
  });

  it('asks for a look, and lists GE among the ready keys, when the sitemap scan fails', async () => {
    const results = await discoverSources({
      sources: { ge: { canton: 'Ginevra', plateCode: 'GE', officialUrl: 'https://www.ge.ch/plaques/vente-aux-encheres-plaques' } },
      geSitemap: true,
      fetcher: async (url: string) => {
        if (url === 'https://www.ge.ch/sitemap.xml') {
          return { status: 200, text: async () => '<sitemapindex><sitemap><loc>https://www.ge.ch/sitemap.xml?page=1</loc></sitemap></sitemapindex>' };
        }
        if (url.startsWith('https://www.ge.ch/sitemap.xml?page=')) return { status: 503, text: async () => 'Service Unavailable' };
        return { status: 200, text: async () => '<title>Vente aux enchères de plaques | ge.ch</title><p>Prochaine vente : automne 2026.</p>' };
      },
      geListProbe: async () => ({ connectorRows: 0, unknownListDocuments: [] }),
    });
    expect(results[0].geList?.sitemapError).toBe('HTTP 503 from https://www.ge.ch/sitemap.xml?page=1');
    expect(results[0].recommendation).toBe('manual-confirmation-needed');
    expect(readyKeysOf(results)).toEqual(['ge']);
  });

  it('reports a sitemap index above the page cap instead of reading only its first pages', async () => {
    const pages = Array.from({ length: 41 }, (_, i) => `<sitemap><loc>https://www.ge.ch/sitemap.xml?page=${i + 1}</loc></sitemap>`).join('');
    await expect(discoverGeSitemapListDocuments({
      fetcher: async () => ({ status: 200, text: async () => `<sitemapindex>${pages}</sitemapindex>` }),
    })).rejects.toThrow('lists 41 sitemap pages, above the cap of 40');
  });

  it('hands the sitemap documents to the GE probe and reports its verdict', async () => {
    const probeCalls: unknown[] = [];
    const results = await discoverSources({
      sources: { ge: { canton: 'Ginevra', plateCode: 'GE', officialUrl: 'https://www.ge.ch/plaques/vente-aux-encheres-plaques' } },
      geSitemap: true,
      fetcher: async (url: string) => ({
        status: 200,
        text: async () => (url.startsWith('https://www.ge.ch/sitemap.xml')
          ? '<urlset><url><loc>https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-0</loc></url></urlset>'
          : '<title>Vente aux enchères de plaques | ge.ch</title><p>Prochaine vente : automne 2026.</p>'),
      }),
      geListProbe: async (options: unknown) => {
        probeCalls.push(options);
        return { connectorRows: 19, sessionEndsAt: '2026-11-12T10:00:00.000Z', unknownListDocuments: ['https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-0'] };
      },
    });
    expect(probeCalls).toHaveLength(1);
    expect((probeCalls[0] as { extraListDocumentUrls: string[] }).extraListDocumentUrls).toEqual(['https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-0']);
    expect(results[0].recommendation).toBe('ready-for-connector-check');
    expect(READY_RECOMMENDATIONS).toContain(results[0].recommendation);
  });

  it('keeps JU/NE blocked on today\'s pages and flags a new official data link', () => {
    // Links measured on scan-ne.ch on 2026-09-30: general conditions PDFs, the
    // captcha-protected Guichet Unique search and the Ricardo storefront.
    const neToday = `<title>Choisir mon numéro de plaques - SCAN</title>
      <a href="https://www.guichetunique.ch/public/SCAN/ACHPLQ/Start.aspx">Guichet unique</a>
      <a href="https://www.ricardo.ch/fr/shop/encheres-plaques-ne/offers/">ricardo.ch</a>
      <a href="/fileadmin/media/Section_Vehicules/2026_Conditions_Generales_Vente_Plaques_Encheres_DI30131.pdf">Veuillez prendre connaissances des conditions générales</a>
      <a href="/fileadmin/media/Documents_sans_reference/Conditions_generales_Encheres_DI30131.pdf">Conditions générales CG de la vente de numéros de plaques aux enchères</a>`;
    const today = classifyCantonDiscovery({ key: 'ne', status: 200, title: 'SCAN', body: neToday });
    expect(today.dataLinks).toEqual([]);
    expect(today.recommendation).toBe('official-feed-request-needed');

    const withList = classifyCantonDiscovery({
      key: 'ne',
      status: 200,
      title: 'SCAN',
      body: `${neToday}<a href="/fileadmin/media/Section_Vehicules/numeros-aux-encheres.csv">Numéros aux enchères (CSV)</a>`,
    });
    expect(withList.dataLinks).toEqual([{ url: 'https://www.scan-ne.ch/fileadmin/media/Section_Vehicules/numeros-aux-encheres.csv', text: 'Numéros aux enchères (CSV)' }]);
    expect(withList.recommendation).toBe('manual-confirmation-needed');

    // The OVJ page links only the captcha guichet and Ricardo (2026-09-30).
    const juToday = classifyCantonDiscovery({
      key: 'ju',
      status: 200,
      title: 'Vente aux enchères et à prix fixe des plaques',
      body: `<a href="https://guichet.jura.ch/ExternalServices/OVJ/Recherche.aspx">Guichet virtuel - Achat de plaques</a>
        <a href="https://www.ricardo.ch/fr/shop/OVJ/offers/">Ventes en cours - Ricardo</a>
        <a href="https://guichet.jura.ch/ExternalServices/OVJ/export.csv">export</a>`,
    });
    expect(juToday.dataLinks).toEqual([]);
    expect(juToday.recommendation).toBe('official-feed-request-needed');
    expect(extractOfficialDataLinks('<a href="https://www.jura.ch/ovj/plaques.json">Plaques (JSON)</a>', { baseUrl: 'https://www.jura.ch/', key: 'ju' }))
      .toEqual([{ url: 'https://www.jura.ch/ovj/plaques.json', text: 'Plaques (JSON)' }]);
  });

  it('keeps ZG non-public while the canton says auctions are suspended', () => {
    const suspended = classifyCantonDiscovery({
      key: 'zg',
      status: 200,
      title: 'Kontrollschilder',
      body: 'Bis auf Weiteres finden keine Auktionen statt.',
    });
    expect(suspended.suspended).toBe(true);
    expect(suspended.recommendation).toBe('no-public-auction');

    const reopened = classifyCantonDiscovery({
      key: 'zg',
      status: 200,
      title: 'Auktion Kontrollschilder',
      body: 'Die nächste Auktion findet im Herbst statt.',
    });
    expect(reopened.suspended).toBe(false);
    expect(reopened.recommendation).toBe('manual-confirmation-needed');
  });

  it('uses official canton alternatives and never probes Ricardo', async () => {
    const requested: string[] = [];
    const results = await discoverSources({
      sources: {
        ju: {
          canton: 'Giura',
          plateCode: 'JU',
          officialUrl: 'https://www.ricardo.ch/fr/shop/OVJ',
        },
        ne: {
          canton: 'Neuchâtel',
          plateCode: 'NE',
          officialUrl: 'https://www.ricardo.ch/de/shop/ENCHERES-PLAQUES-NE/offers/',
        },
        ricardoOnly: {
          canton: 'Test',
          plateCode: 'XX',
          officialUrl: 'https://www.ricardo.ch/shop/test',
        },
      },
      fetcher: async (url) => {
        requested.push(url);
        return {
          status: 200,
          text: async () => '<title>Kontrollschilder</title><body>Vente aux enchères</body>',
        };
      },
    });

    expect(requested.every((url) => !/ricardo\.ch/i.test(url))).toBe(true);
    expect(requested).toEqual([
      'https://www.jura.ch/fr/Autorites/Administration/DEC/OVJ/Vente-de-plaques-JU/Vente-aux-encheres-et-a-prix-fixe-des-plaques-d-immatriculation.html',
      'https://www.scan-ne.ch/vehicule/voitures-motos-scooters-quads/plaques/choisir-mon-numero-de-plaques/',
    ]);
    expect(results.find((entry) => entry.key === 'ju')?.recommendation).toBe('official-feed-request-needed');
    expect(results.find((entry) => entry.key === 'ne')?.recommendation).toBe('official-feed-request-needed');
    expect(results.find((entry) => entry.key === 'ricardoOnly')?.errorCode).toBe('unsafe-or-missing-discovery-url');
  });

  it('rejects non-HTTPS and Ricardo discovery URLs', () => {
    expect(resolveDiscoveryUrl({ plateCode: 'XX', officialUrl: 'http://example.test' })).toBeUndefined();
    expect(resolveDiscoveryUrl({ plateCode: 'XX', officialUrl: 'https://www.ricardo.ch/shop/test' })).toBeUndefined();
  });
});
