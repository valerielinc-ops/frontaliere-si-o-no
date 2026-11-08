import {
  APPLICATION_INTENTS_COLLECTION,
  APPLICATION_INTENT_REMINDER_DELAY_MS,
  APPLICATION_INTENT_REMINDER_WRITE_SKEW_MS,
  APPLICATION_INTENT_RETENTION_DAYS,
} from '../../functions/src/applicationIntentConstants.js';

export const APPLICATION_INTENT_REMINDER_QUERY_PAGE_SIZE = 500;

const DUE_FIELDS = Object.freeze(['reminder.dueAt', 'reminder_due_at', 'dueAt']);

function snapshotDocs(snapshot) {
  if (Array.isArray(snapshot?.docs)) return snapshot.docs;
  const docs = [];
  snapshot?.forEach?.((doc) => docs.push(doc));
  return docs;
}

function queryReadCount(snapshot, docs) {
  const count = Number(snapshot?.size ?? docs.length);
  return Math.max(1, Number.isFinite(count) && count >= 0 ? count : docs.length);
}

async function readQueryPages(query, pageSize) {
  const docs = [];
  let reads = 0;
  let page = query.limit(pageSize);
  while (page) {
    const snapshot = await page.get();
    const batch = snapshotDocs(snapshot);
    reads += queryReadCount(snapshot, batch);
    docs.push(...batch);
    if (batch.length < pageSize) break;
    page = page.startAfter(batch.at(-1)).limit(pageSize);
  }
  return { docs, reads };
}

function queryForDueRange(collection, field, oldestDueAt, now) {
  return collection
    .where(field, '>=', oldestDueAt)
    .where(field, '<=', now)
    .orderBy(field, 'asc');
}

/**
 * Read only reminder intents whose persisted due time could be eligible now.
 * The 90-day retention window and the sender's 48-hour consistency check give
 * a safe lower bound; old, future, and unrelated intent records stay out of the
 * result. Timestamp, ISO-string, and millisecond values are queried separately
 * because legacy writers persisted all three shapes.
 */
export async function loadApplicationIntentReminderCandidates(db, {
  now = new Date(),
  pageSize = APPLICATION_INTENT_REMINDER_QUERY_PAGE_SIZE,
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new TypeError('application-intent reminder pageSize must be a positive safe integer');
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('application-intent reminder now must be a valid date');

  const oldestDueDate = new Date(
    nowMs - APPLICATION_INTENT_RETENTION_DAYS * 86400000
      + APPLICATION_INTENT_REMINDER_DELAY_MS
      - APPLICATION_INTENT_REMINDER_WRITE_SKEW_MS,
  );
  const collectionGroup = db.collectionGroup(APPLICATION_INTENTS_COLLECTION);
  const ranges = [
    [oldestDueDate, nowDate],
    [oldestDueDate.toISOString(), nowDate.toISOString()],
    [oldestDueDate.getTime(), nowMs],
  ];
  const queries = DUE_FIELDS.flatMap((field) => ranges.map(([lower, upper]) => (
    queryForDueRange(collectionGroup, field, lower, upper)
  )));
  const pages = await Promise.all(queries.map((query) => readQueryPages(query, pageSize)));
  const docsByPath = new Map();
  let reads = 0;
  for (const result of pages) {
    reads += result.reads;
    for (const doc of result.docs) {
      const key = doc.ref?.path || doc.id;
      if (key && !docsByPath.has(key)) docsByPath.set(key, doc);
    }
  }
  return { docs: [...docsByPath.values()], reads, queryCount: queries.length };
}
