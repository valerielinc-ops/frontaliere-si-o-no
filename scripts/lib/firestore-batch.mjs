/**
 * firestore-batch.mjs
 *
 * Firestore caps a single WriteBatch at 500 operations AND at ~10MiB of
 * serialized request payload. A `db.batch()` that accumulates one op per
 * record and commits once therefore THROWS as soon as the source collection
 * exceeds 500 docs, or as soon as accumulated doc size crosses the payload
 * cap (variable-size docs, e.g. one carrying an email HTML body, can blow
 * this well under 500 ops — incident 2026-07-07: 400 job-alert-retry docs
 * each holding a full rendered email tripped "Request payload size exceeds
 * the limit: 11534336 bytes" on a mass-failure run) — and when that throw is
 * swallowed as "non-fatal" (the common pattern for best-effort writebacks) it
 * silently writes NOTHING that run. `commitInChunks()` splits the work into
 * ≤FIRESTORE_BATCH_SIZE batches AND flushes early once accumulated payload
 * size nears the byte cap, so writes scale with inventory instead of
 * breaking at either cap.
 *
 * Single source of truth for the chunked-batch idiom — import it instead of
 * re-implementing the `for (i += BATCH_SIZE) { db.batch() … commit() }` loop so
 * the op/byte guards cannot drift between funnel-critical sync scripts.
 */

// Firestore hard cap is 500 ops/batch; leave headroom (matches the BATCH_SIZE=400
// convention in backfill-newsletter-campaign-ids.mjs / dev/backfill-onetap-orphan-subscribers.mjs).
export const FIRESTORE_BATCH_SIZE = 400;

// Firestore's real request-payload cap sits around 10-11MiB (observed error:
// "exceeds the limit: 11534336 bytes" = 11MiB). Flush a batch once its
// estimated serialized size crosses this safety margin, well below the real
// cap to leave headroom for protobuf/field overhead the raw JSON-byte
// estimate below doesn't capture.
export const FIRESTORE_BATCH_MAX_BYTES = 8 * 1024 * 1024;

function estimateBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * Apply `items` to Firestore in chunks that respect both the per-batch op
 * cap and a per-batch payload-size cap.
 *
 * `applyFn` must add AT MOST ONE operation per item to the supplied batch
 * (callers that skip some items should pre-filter, so the slice length stays a
 * safe upper bound on ops-per-batch).
 *
 * @template T
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {T[]} items
 * @param {(batch: import('firebase-admin').firestore.WriteBatch, item: T) => void} applyFn
 * @param {{ chunkSize?: number, maxBatchBytes?: number }} [opts]
 * @returns {Promise<number>} total items committed
 */
export async function commitInChunks(
  db,
  items,
  applyFn,
  { chunkSize = FIRESTORE_BATCH_SIZE, maxBatchBytes = FIRESTORE_BATCH_MAX_BYTES } = {},
) {
  let processed = 0;
  let batch = db.batch();
  let opsInBatch = 0;
  let bytesInBatch = 0;

  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    processed += opsInBatch;
    batch = db.batch();
    opsInBatch = 0;
    bytesInBatch = 0;
  };

  for (const item of items) {
    let itemBytes = 0;
    const meteredBatch = {
      set: (ref, data, setOpts) => {
        itemBytes += estimateBytes(data);
        return batch.set(ref, data, setOpts);
      },
      update: (ref, data) => {
        itemBytes += estimateBytes(data);
        return batch.update(ref, data);
      },
      delete: (ref) => batch.delete(ref),
    };
    applyFn(meteredBatch, item);
    opsInBatch += 1;
    bytesInBatch += itemBytes;

    if (opsInBatch >= chunkSize || bytesInBatch >= maxBatchBytes) {
      await flush();
    }
  }
  await flush();
  return processed;
}
