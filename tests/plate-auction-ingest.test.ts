import { describe, expect, it } from 'vitest';
import { collectPlateAuctions } from '../scripts/plate-auctions/ingest.mjs';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const previousRow = {
  id: 'gr-1', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', plateNumber: '1', normalizedPlate: 'GR1',
  listingType: 'auction', auctionStatus: 'active', currentBidChf: 500, endsAt: '2026-09-12T18:00:00.000Z',
  officialAuctionUrl: 'https://eauktion.gr.ch/', sourceFetchedAt: '2026-09-12T12:00:00.000Z', lastVerifiedAt: '2026-09-12T12:00:00.000Z', dataConfidence: 'partial', rawSnapshotHash: 'old',
};

describe('plate-auction ingest resilience', () => {
  it('closes an expired observation without manufacturing a final price', async () => {
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [] },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [previousRow] },
      now: NOW,
    });
    const row = snapshot.auctions.find((auction) => auction.id === 'gr-1');
    expect(row).toMatchObject({ auctionStatus: 'closed', dataConfidence: 'partial', closedAt: previousRow.endsAt });
    expect(row).not.toHaveProperty('finalPriceChf');
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', rowCount: 0, errorCode: 'zero_rows' });
  });

  it('preserves the last good rows when a fetch fails', async () => {
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => { throw new Error('upstream unavailable'); } },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: [previousRow] },
      now: NOW,
    });
    expect(snapshot.auctions).toContainEqual(previousRow);
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', errorCode: 'fetch_failed', rowCount: 1 });
  });

  it('removes a non-expired row missing from a successful non-empty feed', async () => {
    const replacement = {
      ...previousRow,
      id: 'gr-2',
      plateNumber: '2',
      normalizedPlate: 'GR2',
      currentBidChf: 700,
      endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [replacement] },
      previous: {
        generatedAt: '2026-09-12T12:00:00.000Z',
        auctions: [{ ...previousRow, endsAt: '2026-09-14T18:00:00.000Z' }],
      },
      now: NOW,
    });
    expect(snapshot.auctions.map((auction) => auction.id)).toEqual(['gr-2']);
    expect(snapshot.history.map((auction) => auction.id)).toEqual(['gr-1', 'gr-2']);
    expect(snapshot.sources.gr).toMatchObject({ status: 'active', rowCount: 1 });
  });

  it('removes all old rows when a successful non-empty feed replaces the catalogue', async () => {
    const replacement = {
      ...previousRow,
      id: 'gr-2',
      plateNumber: '2',
      normalizedPlate: 'GR2',
      currentBidChf: 700,
      endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [replacement] },
      previous: {
        generatedAt: '2026-09-12T12:00:00.000Z',
        auctions: [{ ...previousRow, id: 'gr-1', endsAt: '2026-09-14T18:00:00.000Z' }],
      },
      now: NOW,
    });
    expect(snapshot.auctions.map((auction) => auction.id)).toEqual(['gr-2']);
    expect(snapshot.history.map((auction) => auction.id)).toEqual(['gr-1', 'gr-2']);
  });

  it('downgrades an incoherent fetched price before publishing the snapshot', async () => {
    const incoherent = {
      ...previousRow,
      id: 'gr-incoherent',
      plateNumber: '3',
      normalizedPlate: 'GR3',
      startingPriceChf: 1000,
      currentBidChf: 500,
      endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    };
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => [incoherent] },
      previous: null,
      now: NOW,
    });
    expect(snapshot.auctions[0]).toMatchObject({ id: 'gr-incoherent', dataConfidence: 'conflicting' });
  });
});
