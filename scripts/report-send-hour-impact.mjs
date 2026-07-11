#!/usr/bin/env node

/**
 * report-send-hour-impact.mjs — READ-ONLY validation report for feature #3798
 * (per-user scheduled-send time personalization).
 *
 * Answers the goal: "does sending each subscriber's newsletter at their
 * personal preferred hour actually improve engagement, compared to the old
 * one-timestamp-for-everyone send?" Groups `campaign_deliveries` docs by
 * `send_time_source` (`personal` | `global` | absent — see below) and
 * compares open rate / click rate per group.
 *
 * `send_time_source` values (written by scripts/send-newsletter.mjs at send
 * time, see scripts/lib/send-schedule.mjs `resolveEffectivePreferredHour`):
 *   - 'personal' — this subscriber's own preferred_send_hour_utc was used
 *     (>= PREFERRED_SEND_MIN_EVENTS qualifying open/click events).
 *   - 'global'   — no personal signal yet; the site-wide aggregate hour
 *     (newsletter_subscribers/_meta_.global_preferred_send_hour_utc) was used.
 *   - absent/null — pre-feature send, or PER_USER_SEND_TIME=off, or neither a
 *     personal nor a global hour was available (immediate send, no
 *     scheduledAt at all). Reported as "immediate/pre-feature".
 *
 * Open/click detection mirrors scripts/lib/newsletter-ab-data.mjs (the
 * subject-line A/B report's loader): the canonical send-path delivery doc
 * (`campaign_deliveries/{campaignId}__{email}`, see
 * functions/src/lib/deliveryDocId.js) only gets `opened_at`/`clicked_at`
 * merged onto it directly for Resend (its webhook writes to the SAME doc id).
 * The other 4 webhook-tracked providers (Mailjet, Mailgun, Mailtrap,
 * Maileroo — Cloudflare has no engagement webhook at all) write their own
 * delivery doc with a DIFFERENT id, so relying on `opened_at`/`clicked_at` on
 * the canonical doc alone would silently under-count opens/clicks for those
 * 4 providers and skew the personal-vs-immediate comparison. This report
 * cross-checks against the `events` subcollection (open/click events, every
 * provider writes these) and ORs the two signals — same approach as the A/B
 * report, so this and that report can't disagree about what counts as "opened".
 *
 * Read-only: no Firestore writes, no emails sent. Exit code is always 0 (a
 * report, not a CI gate) — Firestore/index errors are logged and degrade the
 * output, they never fail the process.
 *
 * Usage:
 *   node scripts/report-send-hour-impact.mjs                    # last 30 days
 *   node scripts/report-send-hour-impact.mjs --days 60
 *   node scripts/report-send-hour-impact.mjs --since 2026-07-01  # pre/post split
 *   node scripts/report-send-hour-impact.mjs --json
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (Firebase SA), GCLOUD_PROJECT (optional).
 */

const SMALL_SAMPLE_THRESHOLD = 100;
const BATCH_PAGE_SIZE = 200;
const SUBCOLLECTION_CONCURRENCY = 20;

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const DAYS = Number(argValue('--days')) || 30;
const SINCE_RAW = argValue('--since');
let SINCE_DATE = null;
if (SINCE_RAW) {
  const parsed = new Date(`${SINCE_RAW}T00:00:00.000Z`);
  if (!Number.isNaN(parsed.getTime())) SINCE_DATE = parsed;
  else console.warn(`⚠️  --since "${SINCE_RAW}" is not a valid YYYY-MM-DD date — ignoring the pre/post split.`);
}

/** Thrown when a collectionGroup query needs a Firestore index that doesn't exist. */
class MissingIndexError extends Error {
  constructor(group, field, original) {
    super(`Missing Firestore collectionGroup index for "${group}.${field}"`);
    this.name = 'MissingIndexError';
    this.group = group;
    this.field = field;
    this.original = original;
  }
}

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { admin: a, db: a.firestore() };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Mirrors functions/src/lib/deliveryDocId.js buildDeliveryDocId (kept in sync by hand — read-only report, no import to avoid a functions/ → scripts/ runtime dependency). */
function buildCanonicalDeliveryDocId(campaignId, email) {
  return `${campaignId}__${normalizeEmail(email)}`.replace(/[^a-z0-9@._-]+/gi, '-');
}

// ── Data loading: canonical delivery docs (denominator + send_time_source) ──

async function loadDeliveriesCollectionGroup(db, cutoffDate) {
  try {
    const snap = await db.collectionGroup('campaign_deliveries').where('sent_at', '>=', cutoffDate).get();
    return snap.docs;
  } catch (e) {
    if (String(e?.message || '').includes('index')) throw new MissingIndexError('campaign_deliveries', 'sent_at', e);
    throw e;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Fallback for when the collectionGroup index isn't available: page through
 * newsletter_subscribers/* and read each one's campaign_deliveries
 * subcollection directly (batched: subscribers paginated BATCH_PAGE_SIZE at a
 * time, each page's subcollection reads run with bounded concurrency).
 */
async function loadDeliveriesPerSubscriber(db, cutoffDate) {
  const docs = [];
  let lastDoc = null;
  for (;;) {
    let q = db.collection('newsletter_subscribers').orderBy('__name__').limit(BATCH_PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const page = await q.get();
    if (page.empty) break;

    const subscriberRefs = page.docs.filter((d) => d.id !== '_meta_').map((d) => d.ref);
    const subSnaps = await mapWithConcurrency(subscriberRefs, SUBCOLLECTION_CONCURRENCY, (ref) =>
      ref.collection('campaign_deliveries').where('sent_at', '>=', cutoffDate).get(),
    );
    for (const snap of subSnaps) docs.push(...snap.docs);

    lastDoc = page.docs[page.docs.length - 1];
    if (page.docs.length < BATCH_PAGE_SIZE) break;
  }
  return docs;
}

async function loadDeliveries(db, cutoffDate) {
  try {
    return { docs: await loadDeliveriesCollectionGroup(db, cutoffDate), usedFallback: false };
  } catch (e) {
    if (e instanceof MissingIndexError) {
      console.warn(`⚠️  ${e.message} — falling back to per-subscriber subcollection reads (slower).`);
      console.warn(`   To speed this up, create the index via the link in the original error:\n   ${e.original?.message || ''}`);
      return { docs: await loadDeliveriesPerSubscriber(db, cutoffDate), usedFallback: true };
    }
    throw e;
  }
}

// ── Data loading: open/click events (numerator, cross-provider) ─────────────

async function loadEventsCollectionGroup(db, cutoffDate) {
  try {
    const snap = await db.collectionGroup('events').where('timestamp', '>=', cutoffDate).get();
    return snap.docs;
  } catch (e) {
    if (String(e?.message || '').includes('index')) throw new MissingIndexError('events', 'timestamp', e);
    throw e;
  }
}

async function loadEventsPerSubscriber(db, cutoffDate) {
  const docs = [];
  let lastDoc = null;
  for (;;) {
    let q = db.collection('newsletter_subscribers').orderBy('__name__').limit(BATCH_PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const page = await q.get();
    if (page.empty) break;

    const subscriberRefs = page.docs.filter((d) => d.id !== '_meta_').map((d) => d.ref);
    const subSnaps = await mapWithConcurrency(subscriberRefs, SUBCOLLECTION_CONCURRENCY, (ref) =>
      ref.collection('events').where('timestamp', '>=', cutoffDate).get(),
    );
    for (const snap of subSnaps) docs.push(...snap.docs);

    lastDoc = page.docs[page.docs.length - 1];
    if (page.docs.length < BATCH_PAGE_SIZE) break;
  }
  return docs;
}

async function loadEvents(db, cutoffDate) {
  try {
    return await loadEventsCollectionGroup(db, cutoffDate);
  } catch (e) {
    if (e instanceof MissingIndexError) {
      console.warn(`⚠️  ${e.message} — falling back to per-subscriber subcollection reads (slower).`);
      return await loadEventsPerSubscriber(db, cutoffDate);
    }
    throw e;
  }
}

// ── Aggregation ──────────────────────────────────────────────────────────

const IMMEDIATE_LABEL = 'immediate/pre-feature';
const GROUP_ORDER = ['personal', 'global', IMMEDIATE_LABEL];

function emptyCell() {
  return { deliveries: 0, opens: 0, clicks: 0 };
}

function newSegment() {
  const cells = {};
  for (const g of GROUP_ORDER) cells[g] = emptyCell();
  return cells;
}

const pct = (n, d) => (d > 0 ? (100 * n) / d : 0);

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} deliveryDocs
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} eventDocs
 * @param {Date|null} sinceDate - when set, returns { before, after } segments; else { combined }
 */
function aggregate(deliveryDocs, eventDocs, sinceDate) {
  // Only newsletter events carry campaign_id (job_alert_subscribers events use
  // alert_id instead) — collectionGroup('events') pulls from BOTH collections
  // since they share the subcollection name, so filter to newsletter ones.
  const openedKeys = new Set();
  const clickedKeys = new Set();
  for (const doc of eventDocs) {
    const d = doc.data();
    if (!d || !d.campaign_id) continue; // drops job-alert events (no campaign_id)
    if (d.event_type !== 'open' && d.event_type !== 'click') continue;
    const email = normalizeEmail(d.email || doc.ref.parent?.parent?.id || '');
    const key = `${d.campaign_id}::${email}`;
    const msgKey = d.message_id ? `msg::${String(d.message_id)}` : null;
    if (d.event_type === 'open') {
      if (email) openedKeys.add(key);
      if (msgKey) openedKeys.add(msgKey);
    } else {
      if (email) clickedKeys.add(key);
      if (msgKey) clickedKeys.add(msgKey);
    }
  }

  const segments = sinceDate ? { before: newSegment(), after: newSegment() } : { combined: newSegment() };
  let droppedNonCanonical = 0;

  for (const doc of deliveryDocs) {
    const d = doc.data();
    if (!d || !d.sent_at) continue; // only count real sends, not webhook-only stub docs
    const email = normalizeEmail(d.email || doc.ref.parent?.parent?.id || '');
    if (!email) continue;
    const campaignId = d.campaign_id || 'unknown';
    // Keep ONLY the canonical send-path doc (same filter as the A/B report) —
    // non-Resend webhooks write a second doc with a different id; counting
    // both would double-count deliveries.
    if (doc.id !== buildCanonicalDeliveryDocId(campaignId, email)) { droppedNonCanonical++; continue; }

    const groupKey = (d.send_time_source === 'personal' || d.send_time_source === 'global')
      ? d.send_time_source
      : IMMEDIATE_LABEL;

    const sentAt = typeof d.sent_at?.toDate === 'function' ? d.sent_at.toDate() : new Date(d.sent_at);
    const segmentKey = sinceDate ? (sentAt < sinceDate ? 'before' : 'after') : 'combined';
    const cell = segments[segmentKey][groupKey];

    cell.deliveries++;

    const key = `${campaignId}::${email}`;
    const msgKey = d.message_id ? `msg::${String(d.message_id)}` : null;
    const opened = !!d.opened_at || openedKeys.has(key) || (msgKey && openedKeys.has(msgKey));
    const clicked = !!d.clicked_at || clickedKeys.has(key) || (msgKey && clickedKeys.has(msgKey));
    if (opened) cell.opens++;
    if (clicked) cell.clicks++;
  }

  return { segments, droppedNonCanonical };
}

// ── Reporting ────────────────────────────────────────────────────────────

function formatSegmentTable(title, cells) {
  const lines = [];
  lines.push(title);
  lines.push('  group                    deliveries    opens  open-rate    clicks  click-rate');
  lines.push('  ------------------------ ----------  -------  ---------  --------  ----------');
  for (const g of GROUP_ORDER) {
    const c = cells[g];
    const openRate = pct(c.opens, c.deliveries);
    const clickRate = pct(c.clicks, c.deliveries);
    const smallNote = c.deliveries > 0 && c.deliveries < SMALL_SAMPLE_THRESHOLD ? '  (n<100, not significant)' : '';
    lines.push(
      `  ${g.padEnd(24)} ${String(c.deliveries).padStart(10)}  ${String(c.opens).padStart(7)}  ${openRate.toFixed(1).padStart(8)}%  ${String(c.clicks).padStart(8)}  ${clickRate.toFixed(1).padStart(9)}%${smallNote}`,
    );
  }
  return lines.join('\n');
}

function comparisonLine(label, cellA, cellB, nameA, nameB) {
  if (cellA.deliveries === 0 || cellB.deliveries === 0) {
    return `${label}: insufficient data (${nameA}=${cellA.deliveries}, ${nameB}=${cellB.deliveries} deliveries)`;
  }
  const rateA = pct(cellA.opens, cellA.deliveries);
  const rateB = pct(cellB.opens, cellB.deliveries);
  const openDelta = rateA - rateB;
  const clickRateA = pct(cellA.clicks, cellA.deliveries);
  const clickRateB = pct(cellB.clicks, cellB.deliveries);
  const clickDelta = clickRateA - clickRateB;
  const smallSampleFlag = (cellA.deliveries < SMALL_SAMPLE_THRESHOLD || cellB.deliveries < SMALL_SAMPLE_THRESHOLD)
    ? ' [not significant — n<100 in at least one group]'
    : '';
  const sign = (n) => (n >= 0 ? '+' : '');
  return `${label}: open rate ${sign(openDelta)}${openDelta.toFixed(1)}pp (${rateA.toFixed(1)}% vs ${rateB.toFixed(1)}%), click rate ${sign(clickDelta)}${clickDelta.toFixed(1)}pp (${clickRateA.toFixed(1)}% vs ${clickRateB.toFixed(1)}%)${smallSampleFlag}`;
}

function printSegment(name, cells) {
  console.log(`\n${formatSegmentTable(name, cells)}\n`);
  console.log(comparisonLine('  → personal vs immediate', cells.personal, cells[IMMEDIATE_LABEL], 'personal', 'immediate'));
  console.log(comparisonLine('  → global vs immediate  ', cells.global, cells[IMMEDIATE_LABEL], 'global', 'immediate'));
  console.log(comparisonLine('  → personal vs global   ', cells.personal, cells.global, 'personal', 'global'));
}

async function main() {
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const queryFloor = SINCE_DATE && SINCE_DATE < cutoffDate ? SINCE_DATE : cutoffDate;

  if (!JSON_OUT) {
    console.log(`\n📬 Send-hour personalization impact report (feature #3798)`);
    console.log(`   Window: last ${DAYS} day(s) — since ${queryFloor.toISOString()}`);
    if (SINCE_DATE) console.log(`   Pre/post split at: ${SINCE_DATE.toISOString()}`);
    console.log('   Read-only — no Firestore writes, no emails sent.\n');
  }

  const { db } = await initFirebase();

  const [{ docs: deliveryDocs, usedFallback }, eventDocs] = await Promise.all([
    loadDeliveries(db, queryFloor).catch((e) => {
      console.error(`❌ Failed to load campaign_deliveries: ${e?.message || e}`);
      return { docs: [], usedFallback: false };
    }),
    loadEvents(db, queryFloor).catch((e) => {
      console.error(`❌ Failed to load events: ${e?.message || e}`);
      return [];
    }),
  ]);

  if (deliveryDocs.length === 0) {
    console.log('⚠️  No campaign_deliveries found in this window. Nothing to report.');
    if (JSON_OUT) console.log(JSON.stringify({ deliveries: 0 }, null, 2));
    process.exit(0);
  }

  const { segments, droppedNonCanonical } = aggregate(deliveryDocs, eventDocs, SINCE_DATE);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      generatedAt: now.toISOString(),
      windowDays: DAYS,
      since: SINCE_DATE ? SINCE_DATE.toISOString() : null,
      usedFallbackQuery: usedFallback,
      droppedNonCanonicalDocs: droppedNonCanonical,
      segments,
    }, null, 2));
    return;
  }

  if (SINCE_DATE) {
    printSegment(`Before ${SINCE_RAW}`, segments.before);
    printSegment(`On/after ${SINCE_RAW}`, segments.after);
  } else {
    printSegment(`Last ${DAYS} day(s)`, segments.combined);
  }

  console.log(`\n(Fallback per-subscriber query used: ${usedFallback ? 'yes' : 'no'}; ${droppedNonCanonical} non-canonical duplicate delivery doc(s) ignored.)\n`);
}

main().catch((err) => {
  // Report, not a gate: log the failure but never fail the process.
  console.error('❌ Report failed to complete:', err?.message || err);
  process.exit(0);
});
