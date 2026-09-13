import { describe, expect, it } from 'vitest';
import { parsePlateAuctionApiSnapshot, parsePlateAuctionEditorialSnapshot, sanitizePublicPlateAuction } from '../services/plateAuctions/api';

const base = {
  id: 'zh-43423', sourceKey: 'ZH', canton: 'Zurigo', platePrefix: 'ZH', plateNumber: '626', normalizedPlate: 'ZH626',
  auctionStatus: 'active', officialAuctionUrl: 'https://example.test/auction', sourceFetchedAt: '2026-09-13T12:00:00.000Z', lastVerifiedAt: '2026-09-13T12:00:00.000Z', dataConfidence: 'partial', rawSnapshotHash: 'abc123', currentBidChf: 1000,
};

describe('plate-auction public API contract', () => {
  it('drops bidder/winner fields at the public allow-list boundary', () => {
    const result = sanitizePublicPlateAuction({ ...base, bidder: 'private', winnerName: 'private', lastBidder: 'private' });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('bidder');
    expect(result).not.toHaveProperty('winnerName');
    expect(result).not.toHaveProperty('lastBidder');
  });

  it('recomputes counts and accepts a sanitized observation history', () => {
    const snapshot = parsePlateAuctionApiSnapshot({
      schema: 1,
      generatedAt: '2026-09-13T12:00:00.000Z',
      sources: {},
      auctions: [base],
      history: [{ ...base, currentBidChf: 900 }],
    });
    expect(snapshot.counts).toEqual({ active: 1, upcoming: 0, closed: 0, finalsVerified: 0, cantonsWithData: 1 });
    expect(snapshot.history).toHaveLength(1);
  });

  it('counts only closed records with a verified final price', () => {
    const snapshot = parsePlateAuctionApiSnapshot({
      schema: 1,
      generatedAt: '2026-09-13T12:00:00.000Z',
      sources: {},
      auctions: [
        { ...base, id: 'active-with-final-field', finalPriceChf: 5000, dataConfidence: 'verified' },
        { ...base, id: 'sold-verified', auctionStatus: 'sold', finalPriceChf: 5000, finalPriceVerifiedAt: '2026-09-13T12:00:00.000Z', dataConfidence: 'verified' },
      ],
    });
    expect(snapshot.counts.finalsVerified).toBe(1);
  });

  it('accepts the corpus editorial companion through its own allow-list', () => {
    const block = { title: 'Guide', excerpt: 'Summary', paragraphs: ['One paragraph'], bullets: ['One point'] };
    const weekly = { ...block, status: 'ready', highlights: [{ plate: 'GR 7', currentPriceChf: 700, officialUrl: 'https://example.test/auction', bidderName: 'private' }] };
    const editorial = parsePlateAuctionEditorialSnapshot({
      schema: 1,
      generatedAt: '2026-09-13T12:00:00.000Z',
      status: 'ready',
      source: { upstreamGeneratedAt: null, currentRows: 1, historyRows: 0, finalRows: 0, cantons: 1 },
      evergreen: { it: block },
      weekly: { it: weekly },
    });
    expect(editorial?.weekly.it.highlights?.[0]).not.toHaveProperty('bidderName');
    expect(editorial?.weekly.it.highlights?.[0].plate).toBe('GR 7');
  });
});
