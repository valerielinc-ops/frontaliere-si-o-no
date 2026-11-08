import { DRIP_GAP_DAYS } from '../../services/newsletter/onboardingDrip.mjs';

export const ONBOARDING_DRIP_QUERY_PAGE_SIZE = 500;

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

function fieldQuery(collection, field, operator, value) {
  return collection.where(field, operator, value).orderBy(field, 'asc');
}

/**
 * Read only persisted drip progress that is due, plus signups fresh enough to
 * enroll. `drip_last_step` is the durable progress cursor: each successful
 * send advances it, so completed and not-yet-due subscribers are not scanned.
 */
export async function loadOnboardingDripCandidates(db, {
  now = new Date(),
  enrollWindowDays = 4,
  pageSize = ONBOARDING_DRIP_QUERY_PAGE_SIZE,
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new TypeError('onboarding drip pageSize must be a positive safe integer');
  }

  const collection = db.collection('newsletter_subscribers');
  const queries = [];
  for (let lastStep = 0; lastStep < DRIP_GAP_DAYS.length - 1; lastStep++) {
    const dueAt = new Date(now.getTime() - DRIP_GAP_DAYS[lastStep + 1] * 86400000);
    queries.push(fieldQuery(
      collection.where('drip_last_step', '==', lastStep),
      'drip_started_at',
      '<=',
      dueAt,
    ));
  }

  const enrolledAtOrAfter = new Date(now.getTime() - enrollWindowDays * 86400000);
  for (const field of ['confirmed_at', 'confirmedAt']) {
    queries.push(fieldQuery(collection, field, '>=', enrolledAtOrAfter)
      .where(field, '<=', now));
    // Older writers persisted ISO timestamps. Keep the same compatibility as
    // resolveDueStep(), which accepts both Firestore Timestamp and date string.
    queries.push(fieldQuery(collection, field, '>=', enrolledAtOrAfter.toISOString())
      .where(field, '<=', now.toISOString()));
  }

  const snapshots = await Promise.all(queries.map((query) => readQueryPages(query, pageSize)));
  const docsById = new Map();
  let reads = 0;
  for (const result of snapshots) {
    reads += result.reads;
    for (const doc of result.docs) {
      const key = doc.ref?.path || doc.id;
      if (key && !docsById.has(key)) docsById.set(key, doc);
    }
  }
  return { docs: [...docsById.values()], reads, queryCount: queries.length };
}
