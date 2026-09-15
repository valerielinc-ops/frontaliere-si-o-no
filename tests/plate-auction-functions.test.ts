import { describe, expect, it } from 'vitest';
import { chunkPlateAuctionWrites, PLATE_AUCTION_BATCH_SIZE } from '../functions/src/plateAuctionBatch.js';
import { PLATE_AUCTION_COLLECTION, PLATE_AUCTION_SOURCE_COLLECTION, refreshPlateAuctions } from '../functions/src/plateAuctions.js';

const GR_PARTIAL_FEED = `
  <div id="tabContent1"><table><tbody><tr class="L">
    <td><a onclick="openDetails(2230)"><div class="number">12219</div></a></td>
    <td class="amount">500</td><td class="amount">50</td><td class="amount">900</td>
    <td class="closingTime">2026/09/14 20:00:00</td><td>4</td>
  </tr></tbody></table></div>`;

function fakeFirestore(previousRows: Record<string, unknown>[]) {
  const deletes: string[] = [];
  const sourceSets: Array<{ id: string; value: Record<string, unknown> }> = [];
  const writes: Array<{ collection: string; id: string; value: Record<string, unknown> }> = [];
  const rowDocs = previousRows.map((row) => ({ id: String(row.id), data: () => row }));
  const collection = (name: string) => ({
    doc(id: string) {
      return {
        collection: name,
        id,
        async set(value: Record<string, unknown>) {
          if (name === PLATE_AUCTION_SOURCE_COLLECTION) sourceSets.push({ id, value });
        },
      };
    },
    where(field: string, _operator: string, value: unknown) {
      return { limit: () => ({ get: async () => ({ docs: rowDocs.filter((doc) => doc.data()[field] === value) }) }) };
    },
    limit() {
      return { get: async () => ({ docs: [] }) };
    },
  });
  return {
    db: {
      collection,
      batch() {
        return {
          set(ref: { collection: string; id: string }, value: Record<string, unknown>) {
            writes.push({ collection: ref.collection, id: ref.id, value });
          },
          delete(ref: { collection: string; id: string }) {
            if (ref.collection === PLATE_AUCTION_COLLECTION) deletes.push(ref.id);
          },
          async commit() {},
        };
      },
    },
    deletes,
    sourceSets,
    writes,
  };
}

describe('plate-auction Firestore batching', () => {
  it('keeps every commit below Firestore’s 500-write limit', () => {
    const writes = Array.from({ length: 1001 }, (_, index) => ({ id: index }));
    const chunks = chunkPlateAuctionWrites(writes);
    expect(PLATE_AUCTION_BATCH_SIZE).toBeLessThan(500);
    expect(chunks.map((chunk) => chunk.length)).toEqual([400, 400, 201]);
    expect(chunks.flat()).toEqual(writes);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(400);
  });

  it('rejects an invalid batch size instead of risking an oversized commit', () => {
    expect(() => chunkPlateAuctionWrites([], 501)).toThrow(RangeError);
    expect(() => chunkPlateAuctionWrites([], 0)).toThrow(RangeError);
  });

  it('keeps a live row when the Cloud Function sees a partial non-empty feed', async () => {
    const firestore = fakeFirestore([{
      id: 'gr-old', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR1',
      auctionStatus: 'active', currentBidChf: 400, endsAt: '2026-09-14T18:00:00.000Z',
      sourceFetchedAt: '2026-09-12T12:00:00.000Z', lastVerifiedAt: '2026-09-12T12:00:00.000Z',
      dataConfidence: 'partial', firstSeenAt: '2026-09-12T12:00:00.000Z',
    }]);
    const result = await refreshPlateAuctions({
      db: firestore.db as never,
      fetcher: async (url) => url.includes('eauktion.gr.ch') ? GR_PARTIAL_FEED : '',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });
    expect(firestore.deletes).not.toContain('gr-old');
    expect(firestore.sourceSets.find((entry) => entry.id === 'gr')).toMatchObject({
      value: { status: 'degraded', errorCode: 'source_disappeared' },
    });
    expect(firestore.sourceSets.find((entry) => entry.id === 'ti')).toMatchObject({
      value: { status: 'degraded', rowCount: 0, errorCode: 'zero_rows' },
    });
    expect(result.summaries.gr).toMatchObject({ status: 'degraded', errorCode: 'source_disappeared' });
    expect(result.summaries.ti).toMatchObject({ status: 'degraded', rowCount: 0 });
    const agMetadata = firestore.sourceSets.find((entry) => entry.id === 'ag')?.value;
    expect(agMetadata).toMatchObject({
      officialUrl: 'https://www.auktion-ag.ch',
      parserVersion: '1.1.0',
    });
    expect(agMetadata?.availableFields).not.toContain('startingPriceChf');
  });

  it('closes expired rows even when the upstream feed returns zero rows', async () => {
    const firestore = fakeFirestore([{
      id: 'gr-expired', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR2',
      auctionStatus: 'active', currentBidChf: 1200, endsAt: '2026-09-13T11:00:00.000Z',
      sourceFetchedAt: '2026-09-13T10:00:00.000Z', lastVerifiedAt: '2026-09-13T10:00:00.000Z',
      dataConfidence: 'partial',
    }]);
    const result = await refreshPlateAuctions({
      db: firestore.db as never,
      fetcher: async () => '',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });
    expect(result.summaries.gr).toMatchObject({ status: 'degraded', rowCount: 0, closedExpired: 1 });
    expect(firestore.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: PLATE_AUCTION_COLLECTION, id: 'gr-expired', value: expect.objectContaining({ auctionStatus: 'closed', closedAt: '2026-09-13T11:00:00.000Z' }) }),
      expect.objectContaining({ collection: 'plate_auctions_history', id: expect.stringContaining('gr-expired-'), value: expect.objectContaining({ auctionStatus: 'closed' }) }),
    ]));
  });
});
