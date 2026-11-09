import { DECAYABLE_STATUSES, TERMINAL_STATUSES } from './suppressionDecay.mjs';

export const SUPPRESSION_DECAY_QUERY_PAGE_SIZE = 500;

function docsFrom(snapshot) {
  if (Array.isArray(snapshot?.docs)) return snapshot.docs;
  const docs = [];
  snapshot?.forEach?.((doc) => docs.push(doc));
  return docs;
}

function aggregateCount(snapshot) {
  const count = Number(snapshot?.data?.()?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Firestore suppression-decay count aggregation returned an invalid count');
  }
  return count;
}

async function readPages(query, pageSize, orderByField) {
  const docs = [];
  let reads = 0;
  let page = query.orderBy(orderByField).limit(pageSize);
  while (page) {
    const snapshot = await page.get();
    const batch = docsFrom(snapshot);
    reads += Math.max(1, Number(snapshot?.size ?? batch.length));
    docs.push(...batch);
    if (batch.length < pageSize) break;
    page = page.startAfter(batch.at(-1)).limit(pageSize);
  }
  return { docs, reads };
}

/**
 * Read the status buckets that can affect decay and the persisted re-probe
 * cohort. Non-suppressed rows are counted with aggregations, so reports keep
 * exact totals without transferring every subscriber document.
 */
export async function loadSuppressionDecayScan(db, collectionName, {
  includeCohorts = false,
  pageSize = SUPPRESSION_DECAY_QUERY_PAGE_SIZE,
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new TypeError('suppression-decay pageSize must be a positive safe integer');
  }

  const collection = db.collection(collectionName);
  const [totalSnapshot, terminalSnapshot, metaSnapshot] = await Promise.all([
    collection.count().get(),
    collection.where('status', 'in', [...TERMINAL_STATUSES]).count().get(),
    collection.doc('_meta_').get(),
  ]);
  const totalDocuments = Math.max(0, aggregateCount(totalSnapshot) - (metaSnapshot?.exists ? 1 : 0));
  const terminalStatuses = aggregateCount(terminalSnapshot);

  const [decayable, cohorts] = await Promise.all([
    readPages(collection.where('status', 'in', [...DECAYABLE_STATUSES]), pageSize, 'status'),
    includeCohorts
      ? readPages(collection.where('reprobe_batch', '>=', ''), pageSize, 'reprobe_batch')
      : Promise.resolve({ docs: [], reads: 0 }),
  ]);

  const cohortsByBatch = new Map();
  for (const doc of cohorts.docs) {
    const data = doc.data() || {};
    const batch = typeof data.reprobe_batch === 'string' ? data.reprobe_batch : null;
    if (!batch) continue;
    if (!cohortsByBatch.has(batch)) cohortsByBatch.set(batch, []);
    cohortsByBatch.get(batch).push(data);
  }

  return {
    decayableDocs: decayable.docs,
    cohorts: cohortsByBatch,
    totalDocuments,
    terminalStatuses,
    estimatedReads: Math.max(1, Math.ceil(aggregateCount(totalSnapshot) / 1000))
      + Math.max(1, Math.ceil(terminalStatuses / 1000))
      + 1
      + decayable.reads
      + cohorts.reads,
    queryCount: 3 + (includeCohorts ? 1 : 0),
  };
}
