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

  it('records a vanished fixed-price plate as a sale that can never rank as a final', async () => {
    // A fixed-price catalogue has no "sold" flag: the canton drops the row.
    // 16'976 of 17'260 rows are fixed-price and carry `endsAt` in ZERO cases,
    // so closeExpiredObservation() could never close them and a sold plate
    // left the site with no record at all. This is the release boundary: the
    // price we keep is the last published ASKING price and must never satisfy
    // the finalsVerified predicate that guards the finals ranking.
    const plate = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200 + index,
      currentBidChf: undefined,
      endsAt: undefined,
      lastSeenAt: '2026-09-12T12:00:00.000Z',
      dataConfidence: 'verified',
    });
    // 60 published, 1 sells: band 59 >= 0.95*60, cap 1 <= max(3, 1) — a
    // healthy catalogue losing one row, which is what a sale looks like.
    const previousCatalogue = Array.from({ length: 60 }, (_unused, index) => plate(index));
    const stillListed = previousCatalogue.slice(1);
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => stillListed },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });

    const sold = snapshot.history.find((auction) => auction.id === 'ur-0');
    expect(sold, 'the disappearance must be retained in history').toBeDefined();
    expect(sold).toMatchObject({
      auctionStatus: 'closed',
      disappearedFromCatalogue: true,
      lastAskingPriceChf: 4200,
    });
    expect(sold.closedAt).toBe('2026-09-12T12:00:00.000Z');
    // Sold rows leave the live catalogue.
    expect(snapshot.auctions.map((auction) => auction.id)).not.toContain('ur-0');

    // The boundary, asserted three ways so no single slip can open it.
    expect(sold.finalPriceChf, 'must never carry a final price').toBeUndefined();
    expect(sold.finalPriceVerifiedAt, 'must never carry a verified-final date').toBeUndefined();
    expect(sold.dataConfidence).not.toBe('verified');
    const satisfiesFinalsVerified = ['closed', 'sold', 'unsold'].includes(sold.auctionStatus)
      && sold.dataConfidence === 'verified'
      && typeof sold.finalPriceChf === 'number'
      && typeof sold.finalPriceVerifiedAt === 'string';
    expect(satisfiesFinalsVerified, 'a catalogue removal is not a witnessed final').toBe(false);
    expect(snapshot.counts.finalsVerified).toBe(0);
  });

  it('refuses to call a truncated catalogue a batch of sales', async () => {
    // Same source, same shape of row, but the PDF came back short. Reading
    // this as sales would stamp a fabricated sale date and price on half the
    // catalogue, so the decision must fail closed to preserve-as-live.
    const plate = (index: number) => ({
      ...previousRow,
      id: `ur-${index}`,
      sourceKey: 'UR',
      platePrefix: 'UR',
      plateNumber: String(index),
      normalizedPlate: `UR${index}`,
      listingType: 'fixed-price',
      startingPriceChf: 4200 + index,
      currentBidChf: undefined,
      endsAt: undefined,
      dataConfidence: 'verified',
    });
    const previousCatalogue = Array.from({ length: 60 }, (_unused, index) => plate(index));
    const truncated = previousCatalogue.slice(0, 30);
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['ur'],
      fetchers: { ur: async () => truncated },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: previousCatalogue },
      now: NOW,
    });

    expect(snapshot.history.filter((auction) => auction.disappearedFromCatalogue)).toEqual([]);
    // Every row stays visible instead of being declared sold.
    expect(snapshot.auctions).toHaveLength(60);
    expect(snapshot.sources.ur).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
  });

  it('keeps earlier history instead of letting the live catalogue evict it', async () => {
    // The old line concatenated the whole active catalogue before
    // `.slice(-5000)`, so with 17'260 live rows the window held nothing but
    // current rows and both previousHistory and the disappearance
    // observations were discarded on every run.
    const live = Array.from({ length: 120 }, (_unused, index) => ({
      ...previousRow,
      id: `gr-live-${index}`,
      plateNumber: String(1000 + index),
      normalizedPlate: `GR${1000 + index}`,
      endsAt: '2026-09-20T18:00:00.000Z',
      sourceFetchedAt: NOW.toISOString(),
      lastVerifiedAt: NOW.toISOString(),
    }));
    const olderHistory = [{
      ...previousRow,
      id: 'gr-ancient',
      normalizedPlate: 'GR777',
      auctionStatus: 'closed',
      closedAt: '2026-08-01T12:00:00.000Z',
      dataConfidence: 'partial',
    }];
    const snapshot = await collectPlateAuctions({
      selectedCantons: ['gr'],
      fetchers: { gr: async () => live },
      previous: { generatedAt: '2026-09-12T12:00:00.000Z', auctions: live, history: olderHistory },
      now: NOW,
    });
    expect(snapshot.history.map((auction) => auction.id)).toContain('gr-ancient');
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
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

  it('preserves a non-expired row missing from a degraded non-empty feed', async () => {
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
    expect(snapshot.auctions.map((auction) => auction.id)).toEqual(['gr-2', 'gr-1']);
    // History holds what is no longer live. These rows were PRESERVED as live,
    // so they are a preservation case, not a sale, and must not enter history.
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 2 });
  });

  it('preserves all old live rows when a non-empty feed is flagged as incomplete', async () => {
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
        auctions: [
          { ...previousRow, id: 'gr-1', endsAt: '2026-09-14T18:00:00.000Z' },
          { ...previousRow, id: 'gr-3', plateNumber: '3', normalizedPlate: 'GR3', endsAt: '2026-09-15T18:00:00.000Z' },
        ],
      },
      now: NOW,
    });
    expect(snapshot.auctions.map((auction) => auction.id)).toEqual(['gr-2', 'gr-1', 'gr-3']);
    expect(snapshot.history.filter((auction) => ['active', 'upcoming'].includes(auction.auctionStatus))).toEqual([]);
    expect(snapshot.sources.gr).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared', rowCount: 3 });
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
