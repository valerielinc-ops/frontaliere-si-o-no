#!/usr/bin/env node
/**
 * Backfill the base job-alert relationship for existing registrations.
 *
 * The site registration relationship is now product-wide: every valid
 * newsletter_subscribers document not excluded by lifecycle/suppression state
 * gets the canonical backfill-newsletter alert. Newsletter/lead channels start
 * with the broad alert that progressively learns from visits, searches and
 * clicked jobs; job-board channels keep the job/search context captured at
 * registration.
 *
 * Safety:
 *   - default mode is a read-only report;
 *   - --write applies the exact same idempotent handler used by the live
 *     Firestore trigger;
 *   - no consent checkbox/DOI proof is consulted for the base relationship;
 *   - explicit unsubscribe, hard address suppression, stop-all and the
 *     newsletter lifecycle exclusions remain exclusion gates.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *     node scripts/backfill-jobalerts-from-newsletter.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *     node scripts/backfill-jobalerts-from-newsletter.mjs --write
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { handleNewsletterSubscriberCreated } from '../functions/src/jobAlertBackfillTrigger.js';
import {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  getSignalTier,
  shouldSkipSubscriber,
  consentNamesJobAlerts,
  hasAffirmativeJobAlertConsent,
  buildAlertPayload,
  resolveSignalTier,
} from './lib/jobalert-backfill-core.mjs';

export {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  getSignalTier,
  shouldSkipSubscriber,
  consentNamesJobAlerts,
  hasAffirmativeJobAlertConsent,
  buildAlertPayload,
  resolveSignalTier,
};

let _db = null;
async function getFirestoreAdmin() {
  if (_db) return _db;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    initializeApp({ credential: cert(cred), projectId: cred.project_id });
  }
  _db = getFirestore();
  return _db;
}

function incrementReason(counts, reason) {
  if (counts[reason] === undefined) counts[reason] = 0;
  counts[reason] += 1;
}

/**
 * Run the historical migration. The optional dependency injection keeps the
 * decision/reporting path testable without contacting production Firestore.
 * @param {{db?: any, write?: boolean, log?: (...args: any[]) => void}} options
 */
export async function runBackfill({
  db: injectedDb = null,
  write = process.argv.includes('--write'),
  log = (...args) => console.log(...args),
} = {}) {
  const db = injectedDb || await getFirestoreAdmin();
  log(write
    ? '🛠️  Querying all newsletter_subscribers (write mode — idempotent backfill)'
    : '🔎 Querying all newsletter_subscribers (report only — pass --write to apply)');
  const snap = await db.collection('newsletter_subscribers').get();
  log('   Found ' + snap.size + ' subscribers');

  const counts = {
    eligible: 0,
    written: 0,
    wouldWrite: 0,
    failed: 0,
    'invalid-email': 0,
    suppressed: 0,
    capped: 0,
  };
  const consent = { namesJobAlerts: 0, affirmative: 0, noConsentTextAtAll: 0 };
  const byChannel = {};

  for (const doc of snap.docs) {
    if (doc.id === '_meta_') continue;
    const data = doc.data() || {};
    // The document id is the canonical address key. Prefer it over a legacy
    // display-formatted email field such as Name <person@example.com>.
    const email = normalizeEmail(doc.id || data.email);
    const channel = data.source_channel || 'unknown';
    byChannel[channel] = byChannel[channel] || { eligible: 0, skipped: 0, written: 0 };

    if (!data.consent_text) consent.noConsentTextAtAll += 1;
    if (consentNamesJobAlerts(data.consent_text)) consent.namesJobAlerts += 1;
    if (hasAffirmativeJobAlertConsent(data)) consent.affirmative += 1;

    // Tier 3 is read lazily. A flat field is enough to classify the initial
    // alert, while a no-signal registration may have browsing data in the
    // separate private/personalization document.
    let personalization = null;
    if (getSignalTier(data) === 'none' && email.includes('@')) {
      const personalizationSnap = await db
        .collection('newsletter_subscribers')
        .doc(email)
        .collection('private')
        .doc('personalization')
        .get();
      if (personalizationSnap.exists) personalization = personalizationSnap.data() || null;
    }

    const subscriberData = { ...data, email };
    const skipReason = shouldSkipSubscriber(email, subscriberData, personalization);
    if (skipReason) {
      incrementReason(counts, skipReason);
      byChannel[channel].skipped += 1;
      continue;
    }

    const alertPayload = buildAlertPayload(email, subscriberData, null, personalization);
    counts.eligible += 1;
    byChannel[channel].eligible += 1;

    if (!write) {
      counts.wouldWrite += 1;
      log('   would apply ' + ALERT_ID + ' (' + alertPayload.backfilled_from + ', channel ' + channel + ')');
      continue;
    }

    try {
      // This is intentionally the live handler, not a second write
      // implementation. It enforces the active-alert cap, preserves an alert
      // explicitly disabled by the user, merges personalization patches and
      // keeps the write idempotent on re-runs.
      const result = await handleNewsletterSubscriberCreated(email, subscriberData, {
        db,
        personalization,
      });
      if (result.created) {
        counts.written += 1;
        byChannel[channel].written += 1;
      } else {
        incrementReason(counts, result.reason || 'not-applied');
        byChannel[channel].skipped += 1;
      }
    } catch (error) {
      counts.failed += 1;
      byChannel[channel].skipped += 1;
      log('   ⚠️  Backfill failed for one subscriber (' + (error?.message || error) + ')');
    }
  }

  log('');
  log(' ✅ Eligible (registration + suppression): ' + counts.eligible);
  log(write
    ? ' ✍️  Applied idempotent alerts: ' + counts.written
    : ' 🧪 Would apply alerts: ' + counts.wouldWrite);
  log(' ⏭️  Skipped (suppressed): ' + (counts.suppressed || 0));
  log(' ⏭️  Skipped (capped): ' + (counts.capped || 0));
  log(' ❌ Failed: ' + counts.failed);
  log('');
  log(' Historical consent telemetry (not a live gate):');
  log('   records naming job alerts: ' + consent.namesJobAlerts);
  log('   records with former affirmative proof: ' + consent.affirmative);
  log('   records without consent_text: ' + consent.noConsentTextAtAll);
  log('');
  log(' By source_channel (eligible/skipped/written):');
  for (const [channel, c] of Object.entries(byChannel).sort((a, b) => b[1].eligible - a[1].eligible)) {
    log('   ' + channel.padEnd(24) + ' ' + String(c.eligible).padStart(5) + ' / ' + String(c.skipped).padStart(5) + ' / ' + c.written);
  }

  return { counts, consent, byChannel };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Backfill failed:', err);
      process.exit(1);
    });
}
