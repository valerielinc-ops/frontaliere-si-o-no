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
 * Every address this campaign has already reached, across all its chunks.
 *
 * @param {object} db Firestore admin instance
 * @param {{ campaignId: string, field: string }} opts `field` is the array key
 *        this channel writes (`emails` / `sentEmails`) — see the header.
 * @returns {Promise<{ sent: Set<string>, chunkSizes: number[] }>}
 */
export async function fetchAlreadySent(db, { campaignId, field }) {
  const { FieldPath } = await import('firebase-admin/firestore');
  const snap = await metaCampaignSends(db)
    .where(FieldPath.documentId(), '>=', campaignId)
    .where(FieldPath.documentId(), '<', `${campaignId}${ID_RANGE_END}`)
    .orderBy(FieldPath.documentId())
    .get();

  const sent = new Set();
  const chunkSizes = [];
  for (const doc of snap.docs) {
    const emails = doc.data()?.[field] || [];
    chunkSizes.push(emails.length);
    for (const email of emails) sent.add(email);
  }
  return { sent, chunkSizes };
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
  await metaCampaignSends(db).doc(chunkDocId(campaignId, chunkState.index)).set({
    [field]: FieldValue.arrayUnion(...emails),
    updated_at: new Date(),
    ...extraFields,
  }, { merge: true });
  chunkState.count += emails.length;
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
  let written = 0;

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    written += batch.length;
    await markSent(db, opts, batch, chunkState);
  };

  return {
    async record(email) {
      pending.push(email);
      if (pending.length >= flushEvery) await flush();
    },
    flush,
    count: () => written,
  };
}
