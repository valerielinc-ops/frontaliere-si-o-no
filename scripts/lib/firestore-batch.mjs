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
 * `applyFn` may add ONE OR MORE operations per item, and every operation it
 * adds for a given item lands in the SAME batch — the chunk boundary is only
 * ever evaluated BETWEEN items, never inside one. That is not a convenience:
 * a Firestore batch commits atomically, so "same batch" is the only way a
 * caller can write two related documents (a counter and the event that
 * evidences it) without a window in which a crash leaves one written and the
 * other missing (#5843, item 2).
 *
 * The contract used to read "AT MOST ONE operation per item", and the callers
 * that needed two writes per record obeyed it by making two sequential passes
 * — which is exactly that window, opened on purpose. The callers that could
 * not (scripts/send-company-alerts.mjs, one update per rendered section)
 * already relied on the between-items boundary and restored the op bound by
 * dividing their own `chunkSize`; that arithmetic still holds, unchanged.
 *
 * `chunkSize` therefore still counts ITEMS, exactly as before. What is new is
 * `maxBatchOps`, a second ceiling counted in OPERATIONS so a multi-op applyFn
 * cannot walk past Firestore's per-batch limit just because its items are
 * few. Whichever ceiling is reached first ends the batch, always between two
 * items.
 *
 * The return value counts ITEMS, not operations: callers read it as "how many
 * records did I write", and that must not change meaning the day an applyFn
 * grows a second write.
 *
 * @template T
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {T[]} items
 * @param {(batch: import('firebase-admin').firestore.WriteBatch, item: T) => void} applyFn
 * @param {{ chunkSize?: number, maxBatchOps?: number, maxBatchBytes?: number }} [opts]
 * @returns {Promise<number>} total items committed
 */
export async function commitInChunks(
  db,
  items,
  applyFn,
  {
    chunkSize = FIRESTORE_BATCH_SIZE,
    maxBatchOps = FIRESTORE_BATCH_SIZE,
    maxBatchBytes = FIRESTORE_BATCH_MAX_BYTES,
  } = {},
) {
  let processed = 0;
  let batch = db.batch();
  let itemsInBatch = 0;
  let opsInBatch = 0;
  let bytesInBatch = 0;

  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    processed += itemsInBatch;
    batch = db.batch();
    itemsInBatch = 0;
    opsInBatch = 0;
    bytesInBatch = 0;
  };

  for (const item of items) {
    let itemBytes = 0;
    let itemOps = 0;
    const meteredBatch = {
      set: (ref, data, setOpts) => {
        itemBytes += estimateBytes(data);
        itemOps += 1;
        return batch.set(ref, data, setOpts);
      },
      update: (ref, data) => {
        itemBytes += estimateBytes(data);
        itemOps += 1;
        return batch.update(ref, data);
      },
      delete: (ref) => {
        itemOps += 1;
        return batch.delete(ref);
      },
    };
    applyFn(meteredBatch, item);
    itemsInBatch += 1;
    opsInBatch += itemOps;
    bytesInBatch += itemBytes;

    // Evaluated HERE, after the whole item has been applied and never in the
    // middle of it: this is the line that makes "every write of one item
    // commits together, or none of them does" true.
    if (itemsInBatch >= chunkSize || opsInBatch >= maxBatchOps || bytesInBatch >= maxBatchBytes) {
      await flush();
    }
  }
  await flush();
  return processed;
}
