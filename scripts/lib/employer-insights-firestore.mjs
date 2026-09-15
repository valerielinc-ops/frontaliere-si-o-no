/**
 * Firestore storage contract for employer-insights snapshots.
 *
 * A company report can contain hundreds of ads. Firestore rejects a document
 * above 1 MiB, so the company root stores metadata and every ad lives in a
 * window-specific subcollection. The public function reassembles the same JSON
 * shape for the token-gated report.
 */

import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { commitInChunks } from './firestore-batch.mjs';
import {
  EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION,
  employerInsightsWindowAdsSubcollection,
  isEmployerInsightsWindowAdsSubcollection,
} from '../../functions/src/lib/employerInsightsStorage.js';

export const EMPLOYER_INSIGHTS_COLLECTION = 'employer_insights';
export {
  EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION,
  employerInsightsWindowAdsSubcollection,
};

function stableAdIdentity(ad) {
  return String(ad?.jobId || ad?.slug || ad?.path || ad?.title || '').trim();
}

/** Stable Firestore id: independent from array ordering and safe for all slugs. */
export function employerInsightsAdId(ad) {
  const identity = stableAdIdentity(ad);
  if (!identity) throw new Error('employer insight ad has no stable identity');
  return `ad_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

/**
 * Data written to the company root; potentially large ad arrays are removed
 * from both the primary window and every additional window.
 */
export function employerInsightsRootData(document, updatedAt = FieldValue.serverTimestamp()) {
  const { ads: _ads, additionalWindows: rawAdditionalWindows, ...root } = document || {};
  const ads = Array.isArray(document?.ads) ? document.ads : [];
  const additionalWindows = {};
  for (const [windowKey, summary] of Object.entries(rawAdditionalWindows || {})) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      additionalWindows[windowKey] = summary;
      continue;
    }
    const { ads: _windowAds, ...windowSummary } = summary;
    const windowAds = Array.isArray(summary.ads) ? summary.ads : null;
    if (windowAds) {
      windowSummary.adsStorage = {
        type: 'subcollection',
        collection: employerInsightsWindowAdsSubcollection(windowKey),
        count: windowAds.length,
      };
    }
    additionalWindows[windowKey] = windowSummary;
  }
  return {
    ...root,
    ...(Object.keys(additionalWindows).length ? { additionalWindows } : {}),
    adsStorage: {
      type: 'subcollection',
      collection: EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION,
      count: ads.length,
    },
    updatedAt,
  };
}

function adEntries(document) {
  const ads = Array.isArray(document?.ads) ? document.ads : [];
  return ads.map((ad) => ({ id: employerInsightsAdId(ad), data: ad }));
}

function additionalWindowAds(document) {
  const result = new Map();
  for (const [windowKey, summary] of Object.entries(document?.additionalWindows || {})) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    const collectionName = employerInsightsWindowAdsSubcollection(windowKey);
    if (result.has(collectionName)) {
      throw new Error(`duplicate employer insights window shard: ${collectionName}`);
    }
    result.set(collectionName, new Map(adEntries(summary).map(({ id, data }) => [id, data])));
  }
  return result;
}

function asDataMap(snapshot) {
  const result = new Map();
  for (const doc of snapshot?.docs || []) result.set(doc.id, doc.data() || {});
  return result;
}

async function readShardCollections(doc, collectionNames, ads, windowAds) {
  for (const collectionName of collectionNames) {
    const adCollection = doc.ref?.collection?.(collectionName);
    if (!adCollection) continue;
    const adSnapshot = await adCollection.get();
    const adMap = asDataMap(adSnapshot);
    if (adMap.size === 0) continue;
    if (collectionName === EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION) {
      ads.set(doc.id, adMap);
      continue;
    }
    if (!windowAds.has(doc.id)) windowAds.set(doc.id, new Map());
    windowAds.get(doc.id).set(collectionName, adMap);
  }
}

/**
 * Read roots and ad shards. Older snapshots have no subcollection and remain
 * valid; this is also the complete rollback baseline for a migration run.
 * `discoverOrphans` is reserved for rollback, where an unreferenced window
 * shard must be found even if its root pointer was never committed.
 */
export async function readEmployerInsightsSnapshot(db, { discoverOrphans = false, orphanCompanyDocuments = [] } = {}) {
  const collection = db.collection(EMPLOYER_INSIGHTS_COLLECTION);
  const rootSnapshot = await collection.get();
  const roots = new Map();
  const ads = new Map();
  const windowAds = new Map();

  for (const doc of rootSnapshot.docs || []) {
    const root = doc.data() || {};
    roots.set(doc.id, root);
    const collectionNames = new Set([EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION]);
    for (const summary of Object.values(root.additionalWindows || {})) {
      const storedCollection = summary?.adsStorage?.collection;
      if (summary?.adsStorage?.type === 'subcollection' && isEmployerInsightsWindowAdsSubcollection(storedCollection)) {
        collectionNames.add(storedCollection);
      }
    }
    // A failed write can leave window shards behind before its root pointer is
    // committed. Enumerate the safe, known shard names so rollback can remove
    // those orphans even when the old root has no window metadata yet.
    if (discoverOrphans && typeof doc.ref?.listCollections === 'function') {
      const subcollections = await doc.ref.listCollections();
      for (const subcollection of subcollections || []) {
        if (subcollection.id === EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION
          || isEmployerInsightsWindowAdsSubcollection(subcollection.id)) {
          collectionNames.add(subcollection.id);
        }
      }
    }
    await readShardCollections(doc, collectionNames, ads, windowAds);
  }

  // A failed write can also leave shards for a new company before its root is
  // created. Firestore cannot discover that parent through rootSnapshot, so
  // rollback supplies the validated company documents whose refs were tried.
  if (discoverOrphans) {
    for (const document of orphanCompanyDocuments || []) {
      const companyKey = String(document?.companyKey || '').trim();
      if (!companyKey || roots.has(companyKey)) continue;
      const collectionNames = new Set([EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION]);
      for (const collectionName of additionalWindowAds(document).keys()) collectionNames.add(collectionName);
      await readShardCollections({ id: companyKey, ref: collection.doc(companyKey) }, collectionNames, ads, windowAds);
    }
  }

  return { roots, ads, windowAds };
}

function writeOperationItems(collection, documents, existing) {
  const items = [];
  for (const document of documents) {
    const companyKey = String(document.companyKey || '').trim();
    if (!companyKey) throw new Error('employer insight document has no companyKey');
    const rootRef = collection.doc(companyKey);
    const adRef = rootRef.collection(EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION);
    const desiredAds = new Map(adEntries(document).map(({ id, data }) => [id, data]));
    const currentAds = existing.ads.get(companyKey) || new Map();
    const desiredWindowAds = additionalWindowAds(document);
    const currentWindowAds = existing.windowAds?.get(companyKey) || new Map();

    // Shards are written before the root pointer, so a reader never sees a new
    // root announcing ads that do not exist yet.
    for (const [id, data] of desiredAds) {
      items.push({ operation: 'set-ad', ref: adRef.doc(id), data });
    }
    for (const id of currentAds.keys()) {
      if (!desiredAds.has(id)) items.push({ operation: 'delete-ad', ref: adRef.doc(id) });
    }
    for (const [collectionName, desired] of desiredWindowAds) {
      const windowAdRef = rootRef.collection(collectionName);
      const current = currentWindowAds.get(collectionName) || new Map();
      for (const [id, data] of desired) {
        items.push({ operation: 'set-ad', ref: windowAdRef.doc(id), data });
      }
      for (const id of current.keys()) {
        if (!desired.has(id)) items.push({ operation: 'delete-ad', ref: windowAdRef.doc(id) });
      }
    }
    for (const [collectionName, current] of currentWindowAds) {
      if (desiredWindowAds.has(collectionName)) continue;
      const windowAdRef = rootRef.collection(collectionName);
      for (const id of current.keys()) items.push({ operation: 'delete-ad', ref: windowAdRef.doc(id) });
    }
    items.push({
      operation: 'set-root',
      ref: rootRef,
      data: employerInsightsRootData(document),
    });
  }
  return items;
}

function withAttemptedItems(error, attemptedItems) {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, 'attemptedItems', {
        value: attemptedItems,
        configurable: true,
        enumerable: false,
      });
      return error;
    } catch {
      // Fall through for frozen/non-extensible provider errors.
    }
  }
  const wrapped = new Error(String(error), { cause: error });
  Object.defineProperty(wrapped, 'attemptedItems', {
    value: attemptedItems,
    configurable: true,
    enumerable: false,
  });
  return wrapped;
}

async function applyOperationItems(db, items) {
  try {
    return await commitInChunks(db, items, (batch, item) => {
      if (item.operation === 'delete-ad' || item.operation === 'delete-root') batch.delete(item.ref);
      else batch.set(item.ref, item.data);
    }, { chunkSize: 400, maxBatchOps: 400 });
  } catch (error) {
    throw withAttemptedItems(error, items.length);
  }
}

/** Write a validated set of roots + shards and return its document count. */
export async function writeEmployerInsightsDocuments(db, documents, { before } = {}) {
  const existing = before || await readEmployerInsightsSnapshot(db);
  const items = writeOperationItems(db.collection(EMPLOYER_INSIGHTS_COLLECTION), documents, existing);
  await applyOperationItems(db, items);
  return { documentsWritten: documents.length, operationsCommitted: items.length };
}

/**
 * Restore both root documents and subcollections after a failed refresh. The
 * operation list is one-op-per-item, so the shared batch helper also reports
 * precise progress if the rollback itself encounters an outage.
 */
export async function restoreEmployerInsightsSnapshot(db, before, { expectedDocuments = [] } = {}) {
  const after = await readEmployerInsightsSnapshot(db, {
    discoverOrphans: true,
    orphanCompanyDocuments: expectedDocuments,
  });
  const collection = db.collection(EMPLOYER_INSIGHTS_COLLECTION);
  const items = [];

  // Remove every shard that did not exist in the baseline before restoring
  // roots. A root delete does not cascade to Firestore subcollections.
  for (const [companyKey, currentAds] of after.ads) {
    const previousAds = before.ads.get(companyKey) || new Map();
    const adRef = collection.doc(companyKey).collection(EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION);
    for (const id of currentAds.keys()) {
      if (!previousAds.has(id)) items.push({ operation: 'delete-ad', ref: adRef.doc(id) });
    }
  }

  for (const [companyKey, previousAds] of before.ads) {
    const adRef = collection.doc(companyKey).collection(EMPLOYER_INSIGHTS_ADS_SUBCOLLECTION);
    for (const [id, data] of previousAds) items.push({ operation: 'set-ad', ref: adRef.doc(id), data });
  }

  for (const [companyKey, currentWindows] of after.windowAds || []) {
    const previousWindows = before.windowAds?.get(companyKey) || new Map();
    for (const [collectionName, currentAds] of currentWindows) {
      const previousAds = previousWindows.get(collectionName) || new Map();
      const adRef = collection.doc(companyKey).collection(collectionName);
      for (const id of currentAds.keys()) {
        if (!previousAds.has(id)) items.push({ operation: 'delete-ad', ref: adRef.doc(id) });
      }
    }
  }

  for (const [companyKey, previousWindows] of before.windowAds || []) {
    for (const [collectionName, previousAds] of previousWindows) {
      const adRef = collection.doc(companyKey).collection(collectionName);
      for (const [id, data] of previousAds) items.push({ operation: 'set-ad', ref: adRef.doc(id), data });
    }
  }

  for (const companyKey of after.roots.keys()) {
    if (!before.roots.has(companyKey)) {
      items.push({
        operation: 'delete-root',
        ref: collection.doc(companyKey),
      });
    }
  }
  for (const [companyKey, data] of before.roots) {
    items.push({
      operation: 'set-root',
      ref: collection.doc(companyKey),
      data,
    });
  }

  const committed = await applyOperationItems(db, items);
  return { attempted: items.length, committed };
}
