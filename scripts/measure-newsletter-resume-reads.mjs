#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { loadCampaignVariantTotals, previousCampaignIds, weeklyCampaignId } from './lib/newsletter-ab-data.mjs';
import {
  attachApplicationIntentPersonalization,
  loadJobAlertsForSubscribers,
  loadPooledCampaignVariantTotals,
} from './lib/newsletter-send-inputs.mjs';
import { normalizeEmailAddress } from './lib/parseEmailField.mjs';
import { subscriberFromFirestoreRow } from './lib/subscriberFromFirestoreRow.mjs';
import { countingDb } from './measure-job-email-ranking-reads.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES, isCrossChannelStop } from '../services/emailSuppression.mjs';
import { isNewsletterOptOutBinding } from '../services/newsletterOptOut.mjs';
import { hasSubscriptionBasis } from '../services/subscriberConsent.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RECIPIENTS = 21;
const BASELINE_PRIVATE_PROFILE_CHUNK = 200;

function gitShow(ref, relativePath) {
  return execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: ROOT,
    maxBuffer: 1 << 30,
  }).toString();
}

function extractBaselineFetchAllJobAlerts(source) {
  const match = source.match(/async function fetchAllJobAlerts\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('baseline: fetchAllJobAlerts non trovata');
  const declaration = match[0].replace(
    'async function fetchAllJobAlerts()',
    'async function fetchAllJobAlerts(db)',
  );
  // The baseline function only closes over `db`; keeping its source extraction
  // here makes the comparison follow the requested ref without checking out a
  // second copy of the site.
  // eslint-disable-next-line no-new-func
  return new Function(`${declaration}\nreturn fetchAllJobAlerts;`)();
}

function loadBaseline(baselineRef) {
  const sha = execFileSync('git', ['rev-parse', baselineRef], { cwd: ROOT }).toString().trim();
  const baselineAbData = gitShow(baselineRef, 'scripts/lib/newsletter-ab-data.mjs');
  const headAbData = fs.readFileSync(path.join(ROOT, 'scripts/lib/newsletter-ab-data.mjs'), 'utf8');
  if (baselineAbData !== headAbData) {
    throw new Error('scripts/lib/newsletter-ab-data.mjs differisce fra baseline e HEAD');
  }
  return {
    sha,
    fetchAllJobAlerts: extractBaselineFetchAllJobAlerts(gitShow(baselineRef, 'scripts/send-newsletter.mjs')),
  };
}

function eligibleSubscriber(doc) {
  if (doc.id === '_meta_') return null;
  const row = doc.data() || {};
  const rowForSend = normalizeEmailAddress(row.email) ? row : { ...row, email: doc.id };
  if (!normalizeEmailAddress(rowForSend.email)) return null;
  const status = String(rowForSend.status || '').toLowerCase();
  if (NEWSLETTER_EXCLUDED_STATUSES.has(status)) return null;
  if (isCrossChannelStop(rowForSend)) return null;
  if (isNewsletterOptOutBinding(rowForSend)) return null;
  if (!hasSubscriptionBasis(rowForSend)) return null;
  const subscriber = subscriberFromFirestoreRow(rowForSend);
  return subscriber ? { subscriber, confirmed: status === 'confirmed' } : null;
}

/**
 * The recipient list is deliberately selected before any measured wrapper is
 * installed. It is never printed. The complete eligible projection is kept
 * only to reproduce the old private collection-group join.
 */
async function selectRecipients(db, limit) {
  const snap = await db.collection('newsletter_subscribers').get();
  const allEligible = [];
  const confirmed = [];
  for (const doc of snap.docs || []) {
    const entry = eligibleSubscriber(doc);
    if (!entry) continue;
    allEligible.push(entry.subscriber);
    if (entry.confirmed) confirmed.push(entry.subscriber);
  }
  return { selected: confirmed.slice(0, limit), allEligible };
}

function snapshotExists(snapshot) {
  return typeof snapshot?.exists === 'function' ? snapshot.exists() : snapshot?.exists === true;
}

/** The private join that lived inside baseline fetchSubscribers. */
async function loadBaselineApplicationIntent(db, subscribers) {
  const subscribersByEmail = new Map(subscribers.map((subscriber) => [subscriber.email, subscriber]));
  const personalizationSnap = await db.collectionGroup('private').get();
  const personalizationByEmail = new Map();
  for (const docSnap of personalizationSnap.docs || []) {
    if (docSnap.id !== 'personalization') continue;
    const email = normalizeEmailAddress(docSnap.ref?.parent?.parent?.id);
    const subscriber = email ? subscribersByEmail.get(email) : null;
    if (!subscriber?.userId) continue;
    const personalization = docSnap.data() || {};
    const uid = String(subscriber.userId).trim();
    if (!uid || personalization.applicationIntentAuthUid !== uid) continue;
    if (personalization.applicationIntent) {
      personalizationByEmail.set(email, { uid, applicationIntent: personalization.applicationIntent });
    }
  }

  const uids = [...new Set([...personalizationByEmail.values()].map((entry) => entry.uid))];
  const accountProfiles = new Map();
  for (let offset = 0; offset < uids.length; offset += BASELINE_PRIVATE_PROFILE_CHUNK) {
    const chunk = uids.slice(offset, offset + BASELINE_PRIVATE_PROFILE_CHUNK);
    const snapshots = await db.getAll(...chunk.map((uid) => db.collection('users').doc(uid)));
    snapshots.forEach((snapshot, index) => {
      if (!snapshotExists(snapshot)) return;
      const data = snapshot.data() || {};
      accountProfiles.set(chunk[index], { optedOut: data.applicationIntent?.optedOut === true });
    });
  }

  return {
    recipients: subscribers.length,
    private_candidates: personalizationByEmail.size,
    profile_candidates: uids.length,
    profiles_found: accountProfiles.size,
  };
}

async function withoutLogs(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function timedCount(database, fn) {
  const counted = countingDb(database);
  const started = performance.now();
  const value = await withoutLogs(() => fn(counted.db));
  return {
    value,
    firestore_calls: counted.counts.calls,
    docs_read: counted.counts.docs,
    elapsed_ms: Math.round(performance.now() - started),
  };
}

function cacheDb(database, counts, cache, campaignId) {
  const cachePath = `newsletter_subscribers/_meta_/campaign_ab_winners/${campaignId}`;
  const cacheWrites = { count: 0 };

  const cacheDocument = (reference) => new Proxy(reference, {
    get(target, prop) {
      if (prop === 'get') {
        return async () => {
          counts.calls += 1;
          counts.docs += 1;
          const value = cache.get(cachePath);
          return {
            exists: () => value !== undefined,
            data: () => value,
          };
        };
      }
      if (prop === 'set') {
        return async (payload) => {
          cacheWrites.count += 1;
          cache.set(cachePath, payload);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const cacheCollection = (reference) => new Proxy(reference, {
    get(target, prop) {
      if (prop === 'doc') {
        return (id) => {
          const document = target.doc(id);
          return document.path === cachePath ? cacheDocument(document) : document;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const cacheMeta = (reference) => new Proxy(reference, {
    get(target, prop) {
      if (prop === 'collection') {
        return (name) => name === 'campaign_ab_winners'
          ? cacheCollection(target.collection(name))
          : target.collection(name);
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const cacheSubscribers = (reference) => new Proxy(reference, {
    get(target, prop) {
      if (prop === 'doc') {
        return (id) => id === '_meta_' ? cacheMeta(target.doc(id)) : target.doc(id);
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const wrapped = new Proxy(database, {
    get(target, prop) {
      if (prop === 'collection') {
        return (name) => name === 'newsletter_subscribers'
          ? cacheSubscribers(target.collection(name))
          : target.collection(name);
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, cacheWrites };
}

function numericStats(stats) {
  return Object.fromEntries(Object.entries(stats || {}).filter(([, value]) => typeof value === 'number'));
}

export async function measure({ db, recipients = DEFAULT_RECIPIENTS, baselineRef = 'origin/main', now = new Date() }) {
  const baseline = loadBaseline(baselineRef);
  const selected = await selectRecipients(db, recipients);
  if (selected.selected.length === 0) throw new Error('nessun iscritto confermato trovato');

  const campaignId = weeklyCampaignId(now);
  const lookbackCount = Math.max(1, Number.parseInt(process.env.NEWSLETTER_AB_LOOKBACK || '2', 10) || 2);
  const lookbackIds = previousCampaignIds(campaignId, lookbackCount);

  const baselineAlerts = await timedCount(db, (countedDb) => baseline.fetchAllJobAlerts(countedDb));
  const headAlerts = await timedCount(db, async (countedDb) => (
    loadJobAlertsForSubscribers(countedDb, selected.selected.map((subscriber) => subscriber.email))
  ));

  const baselinePersonalization = await timedCount(db, (countedDb) => (
    loadBaselineApplicationIntent(countedDb, selected.allEligible)
  ));
  const headPersonalization = await timedCount(db, (countedDb) => (
    attachApplicationIntentPersonalization(countedDb, selected.selected)
  ));

  const baselineTotals = await timedCount(db, async (countedDb) => {
    for (const campaign of lookbackIds) await loadCampaignVariantTotals(countedDb, campaign);
    return { campaigns: lookbackIds.length };
  });

  const cache = new Map();
  const headCacheMissCounter = countingDb(db);
  const headCacheMissLayer = cacheDb(headCacheMissCounter.db, headCacheMissCounter.counts, cache, campaignId);
  const cacheMissStarted = performance.now();
  const cacheMiss = await withoutLogs(() => loadPooledCampaignVariantTotals(
    headCacheMissLayer.db,
    campaignId,
    lookbackIds,
    { persist: true },
  ));
  const headCacheMiss = {
    value: cacheMiss,
    firestore_calls: headCacheMissCounter.counts.calls,
    docs_read: headCacheMissCounter.counts.docs,
    firestore_writes: headCacheMissLayer.cacheWrites.count,
    elapsed_ms: Math.round(performance.now() - cacheMissStarted),
  };

  const headCacheHitCounter = countingDb(db);
  const headCacheHitLayer = cacheDb(headCacheHitCounter.db, headCacheHitCounter.counts, cache, campaignId);
  const cacheHitStarted = performance.now();
  const cacheHit = await withoutLogs(() => loadPooledCampaignVariantTotals(
    headCacheHitLayer.db,
    campaignId,
    lookbackIds,
    { persist: true },
  ));
  const headCacheHit = {
    value: cacheHit,
    firestore_calls: headCacheHitCounter.counts.calls,
    docs_read: headCacheHitCounter.counts.docs,
    firestore_writes: headCacheHitLayer.cacheWrites.count,
    elapsed_ms: Math.round(performance.now() - cacheHitStarted),
  };

  return {
    _what: 'Letture Firestore e tempo degli input della ripresa newsletter: baseline contro HEAD. Solo aggregati.',
    _how: 'node scripts/measure-newsletter-resume-reads.mjs --recipients <N> --out <file> --baseline-ref <ref>',
    generated_at: now.toISOString(),
    baseline_ref: baselineRef,
    baseline_sha: baseline.sha,
    selected_recipients: selected.selected.length,
    job_alerts: {
      baseline: {
        function: 'fetchAllJobAlerts (collection group)',
        ...Object.fromEntries(Object.entries(baselineAlerts).filter(([key]) => key !== 'value')),
      },
      head: {
        function: 'loadJobAlertsForSubscribers',
        ...Object.fromEntries(Object.entries(headAlerts).filter(([key]) => key !== 'value')),
        ...numericStats(headAlerts.value?.stats),
      },
    },
    application_intent: {
      baseline: {
        function: 'fetchSubscribers private collection group join',
        ...Object.fromEntries(Object.entries(baselinePersonalization).filter(([key]) => key !== 'value')),
        ...numericStats(baselinePersonalization.value),
      },
      head: {
        function: 'attachApplicationIntentPersonalization',
        ...Object.fromEntries(Object.entries(headPersonalization).filter(([key]) => key !== 'value')),
        ...numericStats(headPersonalization.value?.stats),
      },
    },
    ab_totals: {
      baseline: {
        function: 'loadCampaignVariantTotals per previous campaign',
        ...Object.fromEntries(Object.entries(baselineTotals).filter(([key]) => key !== 'value')),
        ...numericStats(baselineTotals.value),
      },
      head: {
        function: 'loadPooledCampaignVariantTotals',
        first_pass: {
          ...Object.fromEntries(Object.entries(headCacheMiss).filter(([key]) => key !== 'value')),
          source: headCacheMiss.value.source,
          ...numericStats(headCacheMiss.value.stats),
        },
        second_pass: {
          ...Object.fromEntries(Object.entries(headCacheHit).filter(([key]) => key !== 'value')),
          source: headCacheHit.value.source,
          ...numericStats(headCacheHit.value.stats),
        },
      },
    },
    notes: [
      'La lista dei destinatari e la proiezione completa usata dalla baseline sono lette prima e fuori dalla misura; gli indirizzi non vengono stampati.',
      'La scrittura della cache HEAD è intercettata in memoria: nessuna scrittura arriva a Firestore.',
    ],
  };
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function main() {
  const recipients = Number.parseInt(argumentValue('--recipients', String(DEFAULT_RECIPIENTS)), 10);
  if (!Number.isInteger(recipients) || recipients <= 0) throw new Error('--recipients deve essere un intero positivo');
  const baselineRef = argumentValue('--baseline-ref', 'origin/main');
  const out = argumentValue('--out', '');
  const db = await getFirestoreDb();
  const report = await measure({ db, recipients, baselineRef });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (/@/.test(json)) throw new Error('il report contiene un indirizzo email: non lo scrivo');
  if (out) fs.writeFileSync(path.resolve(out), json);
  process.stdout.write(json);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
