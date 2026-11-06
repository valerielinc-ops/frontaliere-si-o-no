import { normalizeEmailAddress } from './parseEmailField.mjs';
import { loadCampaignVariantTotals as loadCampaignVariantTotalsFromFirestore } from './newsletter-ab-data.mjs';

const DEFAULT_ALERT_PER_SUBSCRIBER_MAX = 1000;
const DEFAULT_ALERT_CONCURRENCY = 20;
const DEFAULT_PERSONALIZATION_CHUNK_SIZE = 300;
const CAMPAIGN_AB_CACHE_VERSION = 1;

function normalizedEmails(emails) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(emails) ? emails : []) {
    const email = normalizeEmailAddress(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    unique.push(email);
  }
  return unique;
}

function snapshotExists(snapshot) {
  return typeof snapshot?.exists === 'function' ? snapshot.exists() : snapshot?.exists === true;
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Load active job alerts for the subscribers that will actually be processed.
 *
 * Both paths keep only alerts whose email, normalized as a string with trim and
 * lowercase, matches the subscriber being loaded. The collection-group path is
 * deliberately retained for large audiences: a full Monday send is cheaper there
 * than thousands of individual queries. On resume runs, the audience is small
 * enough that reading each subscriber's known subcollection avoids scanning every
 * active alert in Firestore.
 *
 * @param {FirebaseFirestore.Firestore|null} db
 * @param {string[]} emails
 * @param {{perSubscriberMax?: number, concurrency?: number}} [options]
 * @returns {Promise<{alertsByEmail: Map<string, object[]>, stats: object}>}
 */
export async function loadJobAlertsForSubscribers(db, emails, {
  perSubscriberMax = DEFAULT_ALERT_PER_SUBSCRIBER_MAX,
  concurrency = DEFAULT_ALERT_CONCURRENCY,
} = {}) {
  const requestedEmails = normalizedEmails(emails);
  const alertsByEmail = new Map();
  const stats = {
    recipients: requestedEmails.length,
    collection_group_queries: 0,
    subscriber_queries: 0,
    failed_collection_group_queries: 0,
    failed_subscriber_queries: 0,
    alerts: 0,
    subscribers_with_alerts: 0,
  };

  if (!db) return { alertsByEmail, stats };

  const maxPerSubscriber = positiveInteger(perSubscriberMax, DEFAULT_ALERT_PER_SUBSCRIBER_MAX);
  const requestedSet = new Set(requestedEmails);
  const useCollectionGroup = requestedEmails.length > maxPerSubscriber;

  if (useCollectionGroup) {
    stats.collection_group_queries = 1;
    try {
      const snap = await db.collectionGroup('alerts').where('active', '==', true).get();
      for (const doc of snap.docs || []) {
        const data = doc.data() || {};
        const email = String(data.email || '').trim().toLowerCase();
        if (!email || !requestedSet.has(email)) continue;
        if (!alertsByEmail.has(email)) alertsByEmail.set(email, []);
        alertsByEmail.get(email).push(data);
      }
    } catch (error) {
      stats.failed_collection_group_queries = 1;
      console.warn('⚠️ Load job alerts failed:', error?.message || error);
      return { alertsByEmail: new Map(), stats };
    }
  } else {
    const width = positiveInteger(concurrency, DEFAULT_ALERT_CONCURRENCY);
    let cursor = 0;
    let failed = 0;

    const worker = async () => {
      while (cursor < requestedEmails.length) {
        const email = requestedEmails[cursor++];
        stats.subscriber_queries += 1;
        try {
          const snap = await db.collection('job_alert_subscribers')
            .doc(email)
            .collection('alerts')
            .where('active', '==', true)
            .get();
          const alerts = (snap.docs || [])
            .map((doc) => doc.data() || {})
            .filter((data) => String(data.email || '').trim().toLowerCase() === email);
          if (alerts.length > 0) alertsByEmail.set(email, alerts);
        } catch {
          failed += 1;
        }
      }
    };

    await Promise.all(Array.from({
      length: Math.min(width, requestedEmails.length),
    }, () => worker()));
    stats.failed_subscriber_queries = failed;
    if (failed > 0) {
      console.warn(`⚠️ Load job alerts failed for ${failed} subscriber(s) (per-subscriber queries)`);
    }
  }

  for (const alerts of alertsByEmail.values()) stats.alerts += alerts.length;
  stats.subscribers_with_alerts = alertsByEmail.size;
  const mode = useCollectionGroup ? 'collection-group' : 'per-subscriber';
  console.log(`🔔 Job alerts loaded: ${alertsByEmail.size} subscribers with active alerts (mode: ${mode})`);
  return { alertsByEmail, stats };
}

/**
 * Attach the account-backed application-intent profile to the supplied
 * subscribers. The private projection is read by exact document path rather
 * than by collection group, and every accepted projection is checked again
 * against the current users/{uid} preference before it reaches the matcher.
 *
 * Any read error disables the signal for the whole batch, as the old join did.
 *
 * @param {FirebaseFirestore.Firestore|null} db
 * @param {object[]} subscribers
 * @param {{chunkSize?: number}} [options]
 * @returns {Promise<{subscribers: object[], stats: object}>}
 */
export async function attachApplicationIntentPersonalization(db, subscribers, {
  chunkSize = DEFAULT_PERSONALIZATION_CHUNK_SIZE,
} = {}) {
  const targetSubscribers = Array.isArray(subscribers) ? subscribers : [];
  const stats = {
    subscribers: targetSubscribers.length,
    with_user_id: 0,
    private_reads: 0,
    private_found: 0,
    profile_reads: 0,
    profiles_found: 0,
    opted_out: 0,
    failed_batches: 0,
  };

  // A caller may pass objects reused from a previous attempt. Fail closed for
  // the complete batch, including those pre-existing values.
  for (const subscriber of targetSubscribers) delete subscriber.applicationIntent;

  const candidates = [];
  const subscriberByEmail = new Map();
  for (const subscriber of targetSubscribers) {
    const email = normalizeEmailAddress(subscriber?.email);
    const uid = String(subscriber?.userId || '').trim();
    if (!email || !uid || subscriberByEmail.has(email)) continue;
    subscriberByEmail.set(email, subscriber);
    stats.with_user_id += 1;
    candidates.push({ email, uid, subscriber });
  }

  if (candidates.length === 0) return { subscribers: targetSubscribers, stats };

  try {
    if (!db || typeof db.getAll !== 'function') throw new Error('batched Firestore lookup unavailable');
    const size = positiveInteger(chunkSize, DEFAULT_PERSONALIZATION_CHUNK_SIZE);
    const personalizationByEmail = new Map();

    for (let offset = 0; offset < candidates.length; offset += size) {
      const chunk = candidates.slice(offset, offset + size);
      stats.private_reads += chunk.length;
      const snapshots = await db.getAll(...chunk.map(({ email }) => (
        db.collection('newsletter_subscribers').doc(email).collection('private').doc('personalization')
      )));
      snapshots.forEach((snapshot, index) => {
        if (!snapshotExists(snapshot)) return;
        const candidate = chunk[index];
        const personalization = snapshot.data() || {};
        if (personalization.applicationIntentAuthUid !== candidate.uid) return;
        if (!personalization.applicationIntent) return;
        stats.private_found += 1;
        personalizationByEmail.set(candidate.email, {
          uid: candidate.uid,
          applicationIntent: personalization.applicationIntent,
        });
      });
    }

    const uids = [...new Set([...personalizationByEmail.values()].map((entry) => entry.uid))];
    const accountProfiles = new Map();
    for (let offset = 0; offset < uids.length; offset += size) {
      const chunk = uids.slice(offset, offset + size);
      stats.profile_reads += chunk.length;
      const snapshots = await db.getAll(...chunk.map((uid) => db.collection('users').doc(uid)));
      snapshots.forEach((snapshot, index) => {
        if (!snapshotExists(snapshot)) return;
        const data = snapshot.data() || {};
        const optedOut = data.applicationIntent?.optedOut === true;
        accountProfiles.set(chunk[index], { optedOut });
        stats.profiles_found += 1;
        if (optedOut) stats.opted_out += 1;
      });
    }

    for (const [email, candidate] of personalizationByEmail) {
      const account = accountProfiles.get(candidate.uid);
      if (!account || account.optedOut) continue;
      const subscriber = subscriberByEmail.get(email);
      if (subscriber) subscriber.applicationIntent = candidate.applicationIntent;
    }
  } catch (error) {
    stats.failed_batches = 1;
    for (const subscriber of targetSubscribers) delete subscriber.applicationIntent;
    console.warn('⚠️ Application-intent personalization fetch failed:', error?.message || error);
  }

  return { subscribers: targetSubscribers, stats };
}

function sameIds(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function addCells(target, cells) {
  for (const [provider, variants] of Object.entries(cells || {})) {
    target[provider] ??= {};
    for (const [variant, counts] of Object.entries(variants || {})) {
      target[provider][variant] ??= { sends: 0, opens: 0 };
      target[provider][variant].sends += counts.sends;
      target[provider][variant].opens += counts.opens;
    }
  }
}

/**
 * Read or calculate the pooled A/B cells used for winner resolution.
 *
 * The cache intentionally stores cells, never a winner: every send resolves
 * winners again from the cells. Consequently the prior campaigns are read and
 * summed once for the first run of a weekly campaign, then reused by its resume
 * runs. The caller enables persistence only for the real send mode.
 *
 * @param {FirebaseFirestore.Firestore|null} db
 * @param {string} campaignId
 * @param {string[]} lookbackIds
 * @param {{persist?: boolean, loadCampaignVariantTotals?: typeof loadCampaignVariantTotalsFromFirestore}} [options]
 * @returns {Promise<{pooledCells: object, source: 'cache'|'calculation', stats: object}>}
 */
export async function loadPooledCampaignVariantTotals(db, campaignId, lookbackIds, {
  persist = false,
  loadCampaignVariantTotals = loadCampaignVariantTotalsFromFirestore,
} = {}) {
  const ids = Array.isArray(lookbackIds) ? [...lookbackIds] : [];
  const stats = {
    cache_reads: 0,
    cache_hits: 0,
    cache_misses: 0,
    cache_read_failures: 0,
    campaign_calculations: 0,
    cache_writes: 0,
    cache_write_failures: 0,
  };

  let cacheRef = null;
  if (db) {
    cacheRef = db.collection('newsletter_subscribers')
      .doc('_meta_')
      .collection('campaign_ab_winners')
      .doc(campaignId);
    stats.cache_reads = 1;
    try {
      const snapshot = await cacheRef.get();
      const data = snapshotExists(snapshot) ? snapshot.data() || {} : null;
      if (data && data.version === CAMPAIGN_AB_CACHE_VERSION && sameIds(data.lookback_ids, ids)) {
        stats.cache_hits = 1;
        return { pooledCells: data.pooled_cells || {}, source: 'cache', stats };
      }
    } catch {
      stats.cache_read_failures = 1;
    }
  }

  stats.cache_misses = 1;
  stats.campaign_calculations = 1;
  const pooledCells = {};
  for (const id of ids) {
    const { cells } = await loadCampaignVariantTotals(db, id);
    addCells(pooledCells, cells);
  }

  if (persist && cacheRef) {
    stats.cache_writes = 1;
    try {
      await cacheRef.set({
        campaign_id: campaignId,
        lookback_ids: ids,
        pooled_cells: pooledCells,
        computed_at: new Date(),
        version: CAMPAIGN_AB_CACHE_VERSION,
      });
    } catch (error) {
      stats.cache_write_failures = 1;
      console.warn('⚠️ Newsletter A/B cache write failed:', error?.message || error);
    }
  }

  return { pooledCells, source: 'calculation', stats };
}
