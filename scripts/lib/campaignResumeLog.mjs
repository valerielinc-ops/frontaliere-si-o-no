/**
 * campaignResumeLog.mjs — "who has this campaign already reached?", shared by
 * every sender that resumes a partially delivered campaign.
 *
 * WHY IT IS ONE MODULE (AGENTS.md #6, issue #5415 §3.6)
 * ────────────────────────────────────────────────────
 * The weekly newsletter and the daily brief each grew their own copy of the
 * same three lines — read `newsletter_subscribers/_meta_/campaign_sends/{id}`,
 * union an array of addresses into it, filter the pool by it — and each copy
 * carried the same two defects:
 *
 *   1. ONE ARRAY IN ONE DOCUMENT. Firestore caps a document at 1 MiB, about 25k
 *      addresses. Neither channel is there yet; neither should discover the
 *      ceiling by hitting it mid-send, and the newsletter's log accumulates a
 *      whole week of daily resume runs.
 *   2. MARKED AT THE END OF THE RUN. A crash halfway through left the entire
 *      run unrecorded, so the retry re-sent to everyone already served. The
 *      window is the length of a send — the newsletter's is thousands of
 *      emails at one per second.
 *
 * Fixing that twice, in two files, is how the second copy quietly stops
 * matching the first. So: chunked sibling documents (`{id}`, `{id}--2`, …),
 * collected by one document-id range read, and an incremental flush the caller
 * drives from its own per-send hook.
 *
 * FIELD NAME IS THE CALLER'S. The two channels wrote different keys —
 * `emails` for the brief, `sentEmails` for the newsletter — into live campaign
 * documents. Unifying the name would orphan whatever is in flight when this
 * ships, for no benefit: the shape is the contract, not the spelling.
 */

const DEFAULT_CHUNK_MAX = 4000;

/** Sort-safe upper bound for a document-id prefix range. */
const ID_RANGE_END = '';

const metaCampaignSends = (db) =>
  db.collection('newsletter_subscribers').doc('_meta_').collection('campaign_sends');

/**
 * Where the next append belongs, given the chunks already on disk — so a rerun
 * continues the last chunk instead of reopening a full one.
 *
 * @param {number[]} chunkSizes addresses per chunk, in document-id order
 * @param {number} [chunkMax]
 * @returns {{ index: number, count: number }} 1-based chunk index and its size
 */
export function resumeChunkState(chunkSizes, chunkMax = DEFAULT_CHUNK_MAX) {
  const index = Math.max(1, chunkSizes.length);
  const count = chunkSizes[index - 1] ?? 0;
  // A last chunk already at capacity means the next append opens a new one.
  return count >= chunkMax ? { index: index + 1, count: 0 } : { index, count };
}

/** Document id for a chunk. The first chunk keeps the bare campaign id. */
export function chunkDocId(campaignId, index) {
  return index <= 1 ? campaignId : `${campaignId}--${index}`;
}

/**
 * Every address this campaign has already reached or must quarantine, across
 * all its chunks. `sent` and `ambiguous` stay separate for accurate reporting;
 * `attempted` is their union for resume filtering.
 *
 * @param {object} db Firestore admin instance
 * @param {{ campaignId: string, field: string, ambiguousField?: string }} opts
 *        `field` is the confirmed-send array key; `ambiguousField`, when set,
 *        is a second array for provider outcomes that must not be retried.
 * @returns {Promise<{ sent: Set<string>, ambiguous: Set<string>, attempted: Set<string>, chunkSizes: number[] }>}
 */
export async function fetchAlreadySent(db, { campaignId, field, ambiguousField = null }) {
  const { FieldPath } = await import('firebase-admin/firestore');
  const snap = await metaCampaignSends(db)
    .where(FieldPath.documentId(), '>=', campaignId)
    .where(FieldPath.documentId(), '<', `${campaignId}${ID_RANGE_END}`)
    .orderBy(FieldPath.documentId())
    .get();

  const sent = new Set();
  const ambiguous = new Set();
  const chunkSizes = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const emails = Array.isArray(data[field]) ? data[field] : [];
    const ambiguousEmails = ambiguousField && Array.isArray(data[ambiguousField])
      ? data[ambiguousField]
      : [];
    chunkSizes.push(new Set([...emails, ...ambiguousEmails]).size);
    for (const email of emails) sent.add(email);
    for (const email of ambiguousEmails) ambiguous.add(email);
  }
  return { sent, ambiguous, attempted: new Set([...sent, ...ambiguous]), chunkSizes };
}

/**
 * Append addresses to the log, rolling to a new chunk before the current one
 * could grow past `chunkMax`.
 *
 * `chunkState` is mutated: the caller holds it for the whole run so successive
 * flushes keep appending to the same chunk.
 */
export async function markSent(db, { campaignId, field, chunkMax = DEFAULT_CHUNK_MAX, extraFields = {} }, emails, chunkState) {
  if (!emails.length) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  if (chunkState.count + emails.length > chunkMax) {
    chunkState.index += 1;
    chunkState.count = 0;
  }
  // Claim the room in the chunk BEFORE the await: with a concurrent sender two
  // flushes can overlap, and counting only after the write let both see the
  // same pre-write count and overfill the chunk. A failed write over-counts,
  // which only rolls to the next chunk earlier — harmless for the reader,
  // which unions every chunk.
  const index = chunkState.index;
  chunkState.count += emails.length;
  await metaCampaignSends(db).doc(chunkDocId(campaignId, index)).set({
    [field]: FieldValue.arrayUnion(...emails),
    updated_at: new Date(),
    ...extraFields,
  }, { merge: true });
}

/**
 * A buffered writer over `markSent`: the caller pushes one address per
 * successful send and the log is flushed every `flushEvery`, closing the
 * crash window without one write per email.
 *
 * @returns {{ record: (email: string) => Promise<void>, flush: () => Promise<void>, count: () => number }}
 */
export function createResumeWriter(db, opts, chunkState, { flushEvery = 50 } = {}) {
  let pending = [];
  let pendingAmbiguous = [];
  let written = 0;
  let ambiguousWritten = 0;

  const flushOnce = async (batch, ambiguousBatch) => {
    if (batch.length) {
      try {
        await markSent(db, opts, batch, chunkState);
        written += batch.length;
      } catch (error) {
        pending = [...batch, ...pending];
        throw error;
      }
    }

    if (ambiguousBatch.length) {
      if (!opts.ambiguousField) throw new TypeError('ambiguousField is required to record an ambiguous send');
      try {
        await markSent(db, { ...opts, field: opts.ambiguousField }, ambiguousBatch, chunkState);
        ambiguousWritten += ambiguousBatch.length;
      } catch (error) {
        pendingAmbiguous = [...ambiguousBatch, ...pendingAmbiguous];
        throw error;
      }
    }
  };

  // `record` and `recordAmbiguous` are called by concurrent send workers. Keep
  // every flush on one promise chain so no writer observes the mutable
  // `chunkState` halfway through another writer's Firestore append.
  let flushChain = Promise.resolve();
  const flush = () => {
    // Snapshot synchronously: an ambiguous callback must quarantine its own
    // recipient immediately, even when another flush is still queued.
    const batch = pending;
    pending = [];
    const ambiguousBatch = pendingAmbiguous;
    pendingAmbiguous = [];
    if (!batch.length && !ambiguousBatch.length) return flushChain;
    const next = flushChain.then(() => flushOnce(batch, ambiguousBatch));
    // A failed flush must not poison later recovery attempts, but the promise
    // returned to the caller must still reject with the original error.
    flushChain = next.catch(() => {});
    return next;
  };

  return {
    async record(email) {
      pending.push(email);
      if (pending.length + pendingAmbiguous.length >= flushEvery) await flush();
    },
    async recordAmbiguous(email) {
      if (!opts.ambiguousField) throw new TypeError('ambiguousField is required to record an ambiguous send');
      pendingAmbiguous.push(email);
      // Unknown provider outcomes must be durable before the cascade moves on;
      // buffering one could let tomorrow's resume send a possible duplicate.
      await flush();
    },
    flush,
    count: () => written,
    ambiguousCount: () => ambiguousWritten,
  };
}
