import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseVsAuctionRows, VS_CANTON, VS_PLATE_CODE, VS_AUCTION_URL } from '../scripts/plate-auctions/connectors/vs.mjs';
import { validatePlateAuction } from '../services/plateAuctions/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(__dirname, 'fixtures/vs-ecari-auction-sample.html'), 'utf-8');

/**
 * Schema guard for the VS connector (#6358, follow-up of #6355/#6357). The
 * fixture is a trimmed real capture of `https://ecari.vs.ch/ecari-auction/`
 * — see the file header for provenance.
 */
describe('VS plate-auction connector', () => {
  it('parses every "Enchères en cours" row from the sample page', () => {
    const auctions = parseVsAuctionRows(fixtureHtml, { fetchedAt: '2026-08-27T12:00:00.000Z' });
    expect(auctions).toHaveLength(5);
  });

  it('produces PlateAuction-shaped entries with zero validation errors', () => {
    const auctions = parseVsAuctionRows(fixtureHtml, { fetchedAt: '2026-08-27T12:00:00.000Z' });
    for (const auction of auctions) {
      expect(validatePlateAuction(auction), JSON.stringify(auction)).toEqual([]);
    }
  });

  it('extracts plate, bid, increment and closing time correctly for the first row', () => {
    const [first] = parseVsAuctionRows(fixtureHtml, { fetchedAt: '2026-08-27T12:00:00.000Z' });
    expect(first).toMatchObject({
      id: 'vs-929',
      canton: VS_CANTON,
      platePrefix: VS_PLATE_CODE,
      plateNumber: '766',
      normalizedPlate: 'VS766',
      auctionStatus: 'active',
      currentBidChf: 6500,
      minimumIncrementChf: 100,
      bidCount: 7,
      officialAuctionUrl: VS_AUCTION_URL,
    });
    // 2026/09/15 15:00:00 Europe/Zurich (CEST, UTC+2) === 13:00:00Z.
    expect(first.endsAt).toBe('2026-09-15T13:00:00.000Z');
  });

  it('gives each row a distinct rawSnapshotHash', () => {
    const auctions = parseVsAuctionRows(fixtureHtml, { fetchedAt: '2026-08-27T12:00:00.000Z' });
    const hashes = new Set(auctions.map((a) => a.rawSnapshotHash));
    expect(hashes.size).toBe(auctions.length);
  });

  it('returns an empty array when no auction rows are present', () => {
    expect(parseVsAuctionRows('<html><body>no rows</body></html>')).toEqual([]);
  });
});
