import { describe, expect, it } from 'vitest';
import { chunkPlateAuctionWrites, PLATE_AUCTION_BATCH_SIZE } from '../functions/src/plateAuctionBatch.js';

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
});
