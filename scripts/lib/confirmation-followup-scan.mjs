import {
  decideConfirmationFollowup,
  confirmationAttemptsUsed,
} from '../../functions/src/lib/confirmationFollowup.js';
import { hasConfirmationProof } from '../../services/subscriberConsent.mjs';

const STATUS_QUERY_BATCH_SIZE = 30;

function caseVariants(value) {
  const lower = String(value).toLowerCase();
  const variants = [];
  for (let mask = 0; mask < (1 << lower.length); mask += 1) {
    variants.push([...lower].map((character, index) => (
      mask & (1 << index) ? character.toUpperCase() : character
    )).join(''));
  }
  return variants;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function countStatus(collection, values) {
  const counts = await Promise.all(chunks(values, STATUS_QUERY_BATCH_SIZE).map(async (batch) => {
    const snapshot = await collection.where('status', 'in', batch).count().get();
    return Number(snapshot.data()?.count) || 0;
  }));
  return counts.reduce((total, count) => total + count, 0);
}

/**
 * Read only the case-insensitive pending cohort; aggregation counts preserve
 * the all-collection denominator and the terminal expired bucket.
 */
export async function loadConfirmationFollowupCandidates(collection) {
  const pendingValues = caseVariants('pending');
  const expiredValues = caseVariants('expired');
  const [pendingSnapshots, totalSnapshot, expiredDocuments] = await Promise.all([
    Promise.all(chunks(pendingValues, STATUS_QUERY_BATCH_SIZE).map((batch) => (
      collection.where('status', 'in', batch).get()
    ))),
    collection.count().get(),
    countStatus(collection, expiredValues),
  ]);

  const docsById = new Map();
  for (const snapshot of pendingSnapshots) {
    for (const doc of snapshot.docs || []) docsById.set(doc.id, doc);
  }
  return {
    docs: [...docsById.values()],
    totalDocuments: Number(totalSnapshot.data()?.count) || 0,
    alreadyExpiredDocuments: expiredDocuments,
  };
}

/** Pure plan over pending candidates plus an aggregate all-document census. */
export function planConfirmationFollowups(docs, {
  now,
  epochMs,
  totalDocuments = docs.length,
  alreadyExpiredDocuments = 0,
}) {
  const expire = [];
  const send = [];
  const skippedByReason = new Map();
  let neverAskedBacklog = 0;

  for (const doc of docs) {
    const decision = decideConfirmationFollowup(doc.data, { now, epochMs });
    if (decision.action === 'expire') {
      expire.push({ ...doc, decision });
    } else if (decision.action === 'send') {
      send.push({ ...doc, decision });
    } else {
      skippedByReason.set(decision.reason, (skippedByReason.get(decision.reason) || 0) + 1);
      if (
        decision.reason === 'backlog'
        && confirmationAttemptsUsed(doc.data) === 0
        && !hasConfirmationProof(doc.data)
      ) {
        neverAskedBacklog += 1;
      }
    }
  }

  const total = Math.max(docs.length, Number(totalDocuments) || 0);
  const omitted = Math.max(0, total - docs.length);
  const expiredDocuments = Math.min(omitted, Math.max(0, Number(alreadyExpiredDocuments) || 0));
  const notPendingDocuments = omitted - expiredDocuments;
  if (expiredDocuments > 0) skippedByReason.set(
    'already-expired',
    (skippedByReason.get('already-expired') || 0) + expiredDocuments,
  );
  if (notPendingDocuments > 0) skippedByReason.set(
    'not-pending',
    (skippedByReason.get('not-pending') || 0) + notPendingDocuments,
  );

  return {
    total,
    expire,
    send,
    neverAskedBacklog,
    skipped: Object.fromEntries([...skippedByReason.entries()].sort((a, b) => b[1] - a[1])),
  };
}
