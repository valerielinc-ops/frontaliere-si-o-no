import { describe, expect, it } from 'vitest';
import { parseGrAuctionRows } from '../scripts/plate-auctions/connectors/gr.mjs';
import { parseZhAuctions } from '../scripts/plate-auctions/connectors/zh.mjs';
import { validatePlateAuction } from '../services/plateAuctions/types';

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

describe('expanded plate-auction connectors', () => {
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
});
