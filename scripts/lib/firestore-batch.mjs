/**
 * firestore-batch.mjs
 *
 * Firestore caps a single WriteBatch at 500 operations. A `db.batch()` that
 * accumulates one op per record and commits once therefore THROWS as soon as
 * the source collection exceeds 500 docs — and when that throw is swallowed as
 * "non-fatal" (the common pattern for best-effort writebacks) it silently writes
 * NOTHING that run. `commitInChunks()` splits the work into ≤FIRESTORE_BATCH_SIZE
 * batches so writes scale with inventory instead of breaking at the cap.
 *
 * Single source of truth for the chunked-batch idiom — import it instead of
 * re-implementing the `for (i += BATCH_SIZE) { db.batch() … commit() }` loop so
 * the 500-op guard cannot drift between funnel-critical sync scripts.
 */

// Firestore hard cap is 500 ops/batch; leave headroom (matches the BATCH_SIZE=400
// convention in backfill-newsletter-campaign-ids.mjs / dev/backfill-onetap-orphan-subscribers.mjs).
export const FIRESTORE_BATCH_SIZE = 400;

/**
 * Apply `items` to Firestore in chunks that respect the per-batch op cap.
 *
 * `applyFn` must add AT MOST ONE operation per item to the supplied batch
 * (callers that skip some items should pre-filter, so the slice length stays a
 * safe upper bound on ops-per-batch).
 *
 * @template T
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {T[]} items
 * @param {(batch: import('firebase-admin').firestore.WriteBatch, item: T) => void} applyFn
 * @param {{ chunkSize?: number }} [opts]
 * @returns {Promise<number>} total items committed
 */
export async function commitInChunks(db, items, applyFn, { chunkSize = FIRESTORE_BATCH_SIZE } = {}) {
  let processed = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    const batch = db.batch();
    for (const item of slice) applyFn(batch, item);
    await batch.commit();
    processed += slice.length;
  }
  return processed;
}
