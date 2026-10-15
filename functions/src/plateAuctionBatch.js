/** Firestore write batching for the plate-auction collector. */

export const PLATE_AUCTION_BATCH_SIZE = 400;

export function chunkPlateAuctionWrites(writes, batchSize = PLATE_AUCTION_BATCH_SIZE) {
  if (!Array.isArray(writes)) throw new TypeError('writes must be an array');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError('batchSize must be an integer between 1 and 500');
  }
  const chunks = [];
  for (let offset = 0; offset < writes.length; offset += batchSize) {
    chunks.push(writes.slice(offset, offset + batchSize));
  }
  return chunks;
}
