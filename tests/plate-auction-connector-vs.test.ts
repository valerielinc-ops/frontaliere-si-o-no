import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseVsAuctionRows,
  extractTabSection,
  VS_CANTON,
  VS_PLATE_CODE,
  VS_AUCTION_URL,
} from '../scripts/plate-auctions/connectors/vs.mjs';
import { validatePlateAuction } from '../services/plateAuctions/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(__dirname, 'fixtures/vs-ecari-auction-sample.html'), 'utf-8');
const multiTabHtml = readFileSync(join(__dirname, 'fixtures/vs-ecari-auction-multi-tab-sample.html'), 'utf-8');

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

/**
 * Coverage for the tab2/tab4 fix (#6801, follow-up of #6775): these tabs
 * were wrongly declared as requiring authentication. Re-verified against
 * the live site as public and empty ("Plaques indisponibles"), not blocked.
 */
describe('VS plate-auction connector — multi-tab coverage', () => {
  it('extractTabSection isolates tabContent1 without leaking sibling tabs', () => {
    const section = extractTabSection(multiTabHtml, 'tabContent1');
    expect(section).toContain('openDetails(929)');
    expect(section).not.toContain('tabContent2');
  });

  it('extractTabSection isolates tabContent2 without leaking tabContent1 rows', () => {
    const section = extractTabSection(multiTabHtml, 'tabContent2');
    expect(section).toContain('Plaques indisponibles');
    expect(section).not.toContain('openDetails(929)');
  });

  it('returns "" for a tab id absent from the page (e.g. a trimmed fixture)', () => {
    expect(extractTabSection(fixtureHtml, 'tabContent1')).toBe('');
  });

  it('parses tabContent1 rows from the multi-tab page with default active status', () => {
    const section = extractTabSection(multiTabHtml, 'tabContent1');
    const auctions = parseVsAuctionRows(section, { fetchedAt: '2026-08-31T12:00:00.000Z' });
    expect(auctions).toHaveLength(1);
    expect(auctions[0]).toMatchObject({ id: 'vs-929', auctionStatus: 'active' });
  });

  it('yields zero rows (not an error) for the currently-empty tab2/tab4 panels', () => {
    const fetchedAt = '2026-08-31T12:00:00.000Z';
    const tab2 = parseVsAuctionRows(extractTabSection(multiTabHtml, 'tabContent2'), {
      fetchedAt,
      auctionStatus: 'upcoming',
      idPrefix: 'vs-future',
    });
    const tab4 = parseVsAuctionRows(extractTabSection(multiTabHtml, 'tabContent4'), {
      fetchedAt,
      auctionStatus: 'upcoming',
      idPrefix: 'vs-wanted',
    });
    expect(tab2).toEqual([]);
    expect(tab4).toEqual([]);
  });

  it('applies auctionStatus/idPrefix overrides when a tab does carry rows', () => {
    const section = extractTabSection(multiTabHtml, 'tabContent1');
    const [auction] = parseVsAuctionRows(section, {
      fetchedAt: '2026-08-31T12:00:00.000Z',
      auctionStatus: 'upcoming',
      idPrefix: 'vs-future',
    });
    expect(auction).toMatchObject({ id: 'vs-future-929', auctionStatus: 'upcoming' });
    expect(validatePlateAuction(auction)).toEqual([]);
  });
});
