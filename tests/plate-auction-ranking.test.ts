import { describe, expect, it } from 'vitest';
import { getRankingWindow, rankPlateAuctions } from '../services/plateAuctions/ranking';
import type { PlateAuction } from '../services/plateAuctions/types';

function auction(overrides: Partial<PlateAuction>): PlateAuction {
  return {
    id: 'zh-1', sourceKey: 'ZH', canton: 'Zurigo', platePrefix: 'ZH', plateNumber: '1', normalizedPlate: 'ZH1',
    auctionStatus: 'active', currentBidChf: 1000, bidCount: 1, officialAuctionUrl: 'https://example.test',
    sourceFetchedAt: '2026-09-14T08:00:00.000Z', lastVerifiedAt: '2026-09-14T08:00:00.000Z', dataConfidence: 'partial', rawSnapshotHash: 'hash',
    ...overrides,
  };
}

describe('plate-auction rankings', () => {
  const now = new Date('2026-09-16T10:00:00.000Z');
  it('builds a Zurich Monday-to-Monday week window', () => {
    expect(getRankingWindow('week', now)).toEqual({ start: '2026-09-13T22:00:00.000Z', end: '2026-09-20T22:00:00.000Z' });
  });

  it('keeps active/current and verified/final rankings separate', () => {
    const rows = [
      auction({ id: 'active-high', currentBidChf: 9000, endsAt: '2026-09-16T17:00:00.000Z' }),
      auction({ id: 'sold-high', auctionStatus: 'sold', currentBidChf: 12000, finalPriceChf: 12000, closedAt: '2026-09-15T17:00:00.000Z', finalPriceVerifiedAt: '2026-09-16T08:00:00.000Z', dataConfidence: 'verified' }),
      auction({ id: 'sold-unverified', auctionStatus: 'sold', finalPriceChf: 20000, closedAt: '2026-09-15T17:00:00.000Z', dataConfidence: 'partial' }),
    ];
    expect(rankPlateAuctions(rows, { mode: 'current', period: 'week', now }).map((row) => row.auction.id)).toEqual(['active-high']);
    expect(rankPlateAuctions(rows, { mode: 'final', period: 'week', now }).map((row) => row.auction.id)).toEqual(['sold-high']);
  });

  it('deduplicates repeated final observations by stable source id', () => {
    const rows = [
      auction({ id: 'sold-1', auctionStatus: 'sold', finalPriceChf: 8000, closedAt: '2026-09-15T17:00:00.000Z', finalPriceVerifiedAt: '2026-09-15T18:00:00.000Z', sourceFetchedAt: '2026-09-15T19:00:00.000Z', dataConfidence: 'verified' }),
      auction({ id: 'sold-1', auctionStatus: 'sold', finalPriceChf: 8000, closedAt: '2026-09-15T17:00:00.000Z', finalPriceVerifiedAt: '2026-09-15T18:00:00.000Z', sourceFetchedAt: '2026-09-16T08:00:00.000Z', dataConfidence: 'verified' }),
    ];
    expect(rankPlateAuctions(rows, { mode: 'final', period: 'week', now }).map((row) => row.auction.sourceFetchedAt)).toEqual(['2026-09-16T08:00:00.000Z']);
  });

  it('does not rank a current record marked as conflicting by quality checks', () => {
    const rows = [
      auction({ id: 'conflict', currentBidChf: 9000, dataConfidence: 'conflicting' }),
      auction({ id: 'usable', currentBidChf: 8000 }),
    ];
    expect(rankPlateAuctions(rows, { mode: 'current', now }).map((row) => row.auction.id)).toEqual(['usable']);
  });
});
