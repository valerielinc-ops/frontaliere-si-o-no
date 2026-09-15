import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  extractPdfUrl,
  fetchHtml,
  parseAiFixedPricePdfText,
  parseBsFixedPricePdfText,
  parseGlFixedPriceJson,
  parseLuFixedPricePdfText,
  parseUrFixedPricePdfText,
} from '../functions/src/plateAuctionsCore.js';
import { parseGrAuctionRows } from '../scripts/plate-auctions/connectors/gr.mjs';
import { parseSgAuctionRows } from '../scripts/plate-auctions/connectors/sg.mjs';
import { parseShAuctionRows } from '../scripts/plate-auctions/connectors/sh.mjs';
import {
  fetchSzPlateAuctions,
  parseSzAuctionRows,
  SZ_AUCTION_URL,
  SZ_PUBLIC_API_RELAY_URL,
} from '../scripts/plate-auctions/connectors/sz.mjs';
import { parseTiAuctionRows } from '../scripts/plate-auctions/connectors/ti.mjs';
import { parseTgAuctionRows } from '../scripts/plate-auctions/connectors/tg.mjs';
import { parseZhAuctions } from '../scripts/plate-auctions/connectors/zh.mjs';
import { parseExpandedCard, parseExpandedEcari } from '../scripts/plate-auctions/connectors/expanded.mjs';
import { validatePlateAuction } from '../services/plateAuctions/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GR_SAMPLE = `
<div id="tabContent1">
<table><tbody>
<tr class="L" style="border-bottom:1px solid #aaa">
  <td><a onclick="openDetails(2230)" href="#"><div class="plaqueAuto"><div class="number">12219</div></div></a></td>
  <td class="amount">500</td><td class="amount">50</td><td class="amount">900</td>
  <td class="closingTime">2026/09/13 20:00:00</td><td>4</td><td>hidden-bidder</td>
</tr>
</tbody></table>
</div><div id="tabContent2">Kontrollschilder nicht verfügbar</div>`;

const ZH_SAMPLE = `
<a href="/de/auction/43423" class="auction-element-link">
  <figure title="ZH 626"><figcaption>ZH 626</figcaption></figure>
  <div class="auction-element-title"><img src="/bundles/auction/icons/car.svg" alt="Icon eines Autos"/></div>
  <div class="auction-current-bid">CHF&nbsp;11&nbsp;200</div>
  <div class="auction-element-text"><div class="auction-number-bids">17 Gebote</div>
  <div class="auction-ends-at-text">Endet am:</div><div>16.09.2026, 19:00:00</div></div>
</a>`;

const TI_SAMPLE = `
<div id="tabContent1"><table><tbody><tr class="L">
  <td><a onclick="openDetails(1532)" href="#"><div class="number">13457</div></a></td>
  <td class="amount">500</td><td class="amount">50</td><td class="amount">650</td>
  <td class="closingTime">2026/09/14 20:00:00</td><td>3</td><td>offerente privato</td>
</tr></tbody></table></div>`;

const CARD_SAMPLE = `
<div class="auction-grid"><div class="auctions">
  <div>Auktionsende am 23.09.2026</div>
  <a href="/de/auction/109715" class="auction-element-link">
    <figure title="TG 13926"><figcaption>TG 13926</figcaption></figure>
    <div class="auction-element-title"><img src="/bundles/auction/icons/car.svg" alt="Icon eines Autos"/></div>
    <div class="auction-current-bid">CHF&nbsp;600</div>
    <div class="auction-element-text"><div class="auction-number-bids">1 Gebot</div>
      <div class="auction-ends-at-text">Endet am:</div><div>19:00:00</div>
    </div>
  </a>
</div></div>`;

const EXPANDED_ECARI_SAMPLE = readFileSync(join(__dirname, 'fixtures/expanded-ecari-auction-sample.html'), 'utf8');
const EXPANDED_CARD_SAMPLE = readFileSync(join(__dirname, 'fixtures/expanded-card-auction-sample.html'), 'utf8');

describe('expanded plate-auction connectors', () => {
  it('does not substitute an unrelated PDF when a configured pattern misses', () => {
    const html = '<a href="/cars.pdf">Cars</a><a href="/motorcycles.pdf">Motorcycles</a>';
    expect(extractPdfUrl(html, { baseUrl: 'https://example.test/source', pattern: /trailer\.pdf/i })).toBeUndefined();
    expect(extractPdfUrl(html, { baseUrl: 'https://example.test/source' })).toBe('https://example.test/cars.pdf');
  });

  it('retries transient catalogue fetch failures before degrading a source', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('temporary network reset'))
      .mockResolvedValueOnce(new Response('<html>ok</html>', { status: 200 }));

    try {
      await expect(fetchHtml('https://example.test/catalogue', { retries: 1, retryDelayMs: 0 })).resolves.toBe('<html>ok</html>');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('retries when the response body stream fails after headers arrive', async () => {
    const firstResponse = {
      ok: true,
      text: vi.fn().mockRejectedValueOnce(new TypeError('temporary stream reset')),
    } as unknown as Response;
    const secondResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue('<html>ok</html>'),
    } as unknown as Response;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    try {
      await expect(fetchHtml('https://example.test/catalogue', { retries: 1, retryDelayMs: 0 })).resolves.toBe('<html>ok</html>');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('parses the GR eCari full-width row and never exposes bidder text', () => {
    const [row] = parseGrAuctionRows(GR_SAMPLE, { fetchedAt: '2026-09-13T08:00:00.000Z' });
    expect(row).toMatchObject({
      id: 'gr-2230', sourceKey: 'GR', normalizedPlate: 'GR12219', startingPriceChf: 500,
      minimumIncrementChf: 50, currentBidChf: 900, bidCount: 4, endsAt: '2026-09-13T18:00:00.000Z',
    });
    expect(JSON.stringify(row)).not.toContain('hidden-bidder');
    expect(validatePlateAuction(row)).toEqual([]);
  });

  it('parses the ZH public card into a detail URL and Zurich UTC timestamp', () => {
    const [row] = parseZhAuctions(ZH_SAMPLE, { fetchedAt: '2026-09-13T08:00:00.000Z' });
    expect(row).toMatchObject({
      id: 'zh-43423', sourceKey: 'ZH', normalizedPlate: 'ZH626', currentBidChf: 11200,
      bidCount: 17, officialDetailUrl: 'https://www.auktion.stva.zh.ch/de/auction/43423',
      endsAt: '2026-09-16T17:00:00.000Z',
    });
    expect(validatePlateAuction(row)).toEqual([]);
  });

  it('keeps direct-sale and wanted tabs public even when price/deadline cells are absent', () => {
    const html = `
      <div id="tabContent3"><table><tbody><tr class="L"><td><a onclick="openDetails(77)"><div class="number">8008</div></a></td><td class="amount">2500</td></tr></tbody></table></div>
      <div id="tabContent4"><table><tbody><tr class="L"><td><a onclick="openDetails(78)"><div class="number">9009</div></a></td></tr></tbody></table></div>`;
    const rows = parseGrAuctionRows(html, { fetchedAt: '2026-09-13T08:00:00.000Z' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'gr-fixed-77', listingType: 'fixed-price', currentBidChf: 2500, auctionStatus: 'active' });
    expect(rows[1]).toMatchObject({ id: 'gr-wanted-78', listingType: 'wanted', auctionStatus: 'upcoming' });
    expect(rows.every((row) => validatePlateAuction(row).length === 0)).toBe(true);
  });

  it('reads the public Ticino eCari catalogue and keeps bidder data private', () => {
    const [row] = parseTiAuctionRows(TI_SAMPLE, { fetchedAt: '2026-09-14T08:00:00.000Z' });
    expect(row).toMatchObject({
      id: 'ti-1532', sourceKey: 'TI', normalizedPlate: 'TI13457', currentBidChf: 650,
      bidCount: 3, endsAt: '2026-09-14T18:00:00.000Z', officialAuctionUrl: 'https://www.carieauktion.ti.ch/ecari-auktion/',
    });
    expect(JSON.stringify(row)).not.toContain('offerente privato');
    expect(validatePlateAuction(row)).toEqual([]);
  });

  it('reuses the eCari parser for San Gallo and Svitto', () => {
    const sgRows = parseSgAuctionRows(TI_SAMPLE.replaceAll('TI', 'SG'), { fetchedAt: '2026-09-14T08:00:00.000Z' });
    const szRows = parseSzAuctionRows(TI_SAMPLE.replaceAll('TI', 'SZ'), { fetchedAt: '2026-09-14T08:00:00.000Z' });
    expect(sgRows[0]).toMatchObject({ id: 'sg-1532', sourceKey: 'SG', normalizedPlate: 'SG13457' });
    expect(szRows[0]).toMatchObject({ id: 'sz-1532', sourceKey: 'SZ', normalizedPlate: 'SZ13457' });
    expect(validatePlateAuction(sgRows[0])).toEqual([]);
    expect(validatePlateAuction(szRows[0])).toEqual([]);
  });

  it('uses only a fresh healthy public API relay when SZ blocks CI egress', async () => {
    const previousRelay = process.env.PLATE_AUCTION_ENABLE_API_RELAY;
    process.env.PLATE_AUCTION_ENABLE_API_RELAY = '1';
    const fetcher = vi.fn(async ({ officialAuctionUrl }: { officialAuctionUrl: string }) => {
      if (officialAuctionUrl === SZ_AUCTION_URL) throw new TypeError('fetch failed');
      throw new Error(`unexpected direct fetch: ${officialAuctionUrl}`);
    });
    const apiResponse = JSON.stringify({
      sources: {
        sz: {
          status: 'active',
          rowCount: 1,
          lastSuccessAt: '2026-09-15T08:00:00.000Z',
        },
      },
      auctions: [{
        id: 'sz-42',
        sourceKey: 'SZ',
        normalizedPlate: 'SZ42',
        officialAuctionUrl: 'https://cariegov.sz.ch/ecari-auction/ui/app/init?locale=de_ch',
        sourceFetchedAt: '2026-09-15T08:00:00.000Z',
        lastVerifiedAt: '2026-09-15T08:00:00.000Z',
      }],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(SZ_PUBLIC_API_RELAY_URL);
      return new Response(apiResponse, { status: 200 });
    }) as typeof fetch;

    try {
      const rows = await fetchSzPlateAuctions({
        fetcher,
        now: new Date('2026-09-15T09:00:00.000Z'),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'sz-42',
        sourceKey: 'SZ',
        officialAuctionUrl: SZ_AUCTION_URL,
      });
      expect(fetcher).toHaveBeenCalledWith({
        canton: 'Svitto',
        plateCode: 'SZ',
        officialAuctionUrl: SZ_AUCTION_URL,
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousRelay === undefined) delete process.env.PLATE_AUCTION_ENABLE_API_RELAY;
      else process.env.PLATE_AUCTION_ENABLE_API_RELAY = previousRelay;
    }
  });

  it('parses the configurable card platforms for Sciaffusa and Turgovia', () => {
    const shRows = parseShAuctionRows(CARD_SAMPLE.replaceAll('TG', 'SH'), { fetchedAt: '2026-09-14T08:00:00.000Z' });
    const tgRows = parseTgAuctionRows(CARD_SAMPLE, { fetchedAt: '2026-09-14T08:00:00.000Z' });
    expect(shRows[0]).toMatchObject({ id: 'sh-109715', sourceKey: 'SH', normalizedPlate: 'SH13926', endsAt: '2026-09-23T17:00:00.000Z' });
    expect(tgRows[0]).toMatchObject({ id: 'tg-109715', sourceKey: 'TG', normalizedPlate: 'TG13926', endsAt: '2026-09-23T17:00:00.000Z' });
    expect(validatePlateAuction(shRows[0])).toEqual([]);
    expect(validatePlateAuction(tgRows[0])).toEqual([]);
  });

  it('reuses the eCari contract for all newly verified public catalogues', () => {
    for (const sourceKey of ['ar', 'bl', 'fr', 'nw', 'ow', 'so']) {
      const [row] = parseExpandedEcari(sourceKey, EXPANDED_ECARI_SAMPLE, { fetchedAt: '2026-09-15T08:00:00.000Z' });
      expect(row, sourceKey).toMatchObject({
        id: `${sourceKey}-1768`,
        sourceKey: sourceKey.toUpperCase(),
        plateNumber: '691',
        currentBidChf: 950,
        officialDetailUrl: expect.stringContaining('/ui/app/details/app?id=1768'),
      });
      expect(JSON.stringify(row)).not.toContain('private bidder omitted');
      expect(validatePlateAuction(row), sourceKey).toEqual([]);
    }
  });

  it('reuses the card contract for AG, BE and VD after the portal migrations', () => {
    for (const sourceKey of ['ag', 'be', 'vd']) {
      const [row] = parseExpandedCard(sourceKey, EXPANDED_CARD_SAMPLE.replaceAll('AG', sourceKey.toUpperCase()), { fetchedAt: '2026-09-15T08:00:00.000Z' });
      expect(row, sourceKey).toMatchObject({
        id: `${sourceKey}-1768`,
        sourceKey: sourceKey.toUpperCase(),
        normalizedPlate: `${sourceKey.toUpperCase()}691`,
        currentBidChf: 950,
        officialDetailUrl: 'https://www.' + (sourceKey === 'vd' ? 'encheres-vd.ch' : sourceKey === 'ag' ? 'auktion-ag.ch' : 'auktion-be.ch') + '/de/auction/1768',
      });
      expect(validatePlateAuction(row), sourceKey).toEqual([]);
    }
  });

  it('parses the five newly covered official fixed-price catalogues without auction fields', () => {
    const options = {
      officialUrl: 'https://example.test/official',
      officialDetailUrl: 'https://example.test/source.pdf',
      fetchedAt: '2026-09-15T08:00:00.000Z',
    };
    const ai = parseAiFixedPricePdfText('Fr. 2000 2674 3854 Fr. 1200 5367 | 6394 Fr. 300 10310', options);
    const aiMotorcycle = parseAiFixedPricePdfText('Fr. 200 153 204 249', { ...options, vehicleType: 'motorcycle' });
    const bs = parseBsFixedPricePdfText('BS 186 4,000.00 Nein Siehe Hinweis 1 BS 213 4,000.00 Ja', options);
    const gl = parseGlFixedPriceJson({ data: [{ id: 1523, number: 3681, price: 800, available: 1, deleted: 0, registered: 0, platetype: 'car_long_plate' }] }, options);
    const lu = parseLuFixedPricePdfText({ pages: [
      'Wunschkontrollschilder Motorwagen; an Lager\nHochformat\nFr 1’000.- Fr 800.- Fr 800.- Fr 600.-\n21 694 30 129 58 139 65 032',
      'Wunschkontrollschilder Motorrad; an Lager\nFr 200.- Fr 150.- Fr 150.-\n4 157 7 389 9 723',
    ] }, options);
    const ur = parseUrFixedPricePdfText("UR 2296 50 x 11 cm 1'000.--SFr. UR 3086 50 x 11 cm 700.--SFr.", options);
    for (const [sourceKey, rows] of [['AI', ai], ['BS', bs], ['GL', gl], ['LU', lu], ['UR', ur]] as const) {
      expect(rows.length, sourceKey).toBeGreaterThan(0);
      expect(rows.every((row) => row.sourceKey === sourceKey && row.listingType === 'fixed-price')).toBe(true);
      expect(rows.every((row) => row.bidCount === undefined && row.currentBidChf === undefined)).toBe(true);
      expect(rows.every((row) => validatePlateAuction(row).length === 0)).toBe(true);
    }
    expect(lu.find((row) => row.vehicleType === 'motorcycle')).toMatchObject({ startingPriceChf: 200 });
    expect(aiMotorcycle[0]).toMatchObject({ id: 'ai-motorcycle-153', vehicleType: 'motorcycle', startingPriceChf: 200 });
    expect(ur.find((row) => row.plateNumber === '3086')).toMatchObject({ startingPriceChf: 700 });
  });
});
