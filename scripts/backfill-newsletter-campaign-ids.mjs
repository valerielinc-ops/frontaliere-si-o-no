#!/usr/bin/env node
/**
 * backfill-newsletter-campaign-ids.mjs
 *
 * Backfill historical Firestore newsletter docs whose `campaign_id` was
 * corrupted by two prior webhook bugs:
 *   - Mailgun events stored the raw Message-ID (e.g.
 *     `20260503073515.2917922a4c8e980c@frontaliereticino.ch`) instead of
 *     `weekly_2026-05-03`.
 *   - Resend events stored the literal string `"unknown"` (we observed
 *     595/597 such docs at audit time).
 *
 * The CORRECT format is `^weekly_\d{4}-\d{2}-\d{2}$` where the date is the
 * Monday of the send week.
 *
 * Algorithm
 * ─────────
 *  1. Load `newsletter_subscribers/_meta_/campaign_logs/*`, sort by `sentAt`,
 *     compute each campaign's canonical campaignId = `weekly_${monday(sentAt)}`.
 *     Build campaign windows: each campaign covers [sentAt - 24h, sentAt + 7d].
 *  2. Stream `collectionGroup('campaign_deliveries')` and
 *     `collectionGroup('events')`. For each doc whose `campaign_id` does NOT
 *     match `^weekly_\d{4}-\d{2}-\d{2}$`:
 *       a. Find the doc's effective timestamp:
 *            deliveries → `sent_at`
 *            events     → earliest of `timestamp` / `occurred_at`
 *          If none → mark 'unmappable'.
 *       b. Find the campaign window containing this timestamp.
 *          If none → 'unmappable'. If multiple → pick the closest by |Δt|.
 *       c. Propose update: { campaign_id, _backfilled_at, _backfill_old_campaign_id }.
 *  3. Default mode (`--dry-run`, the default with no flag): print stats +
 *     a histogram + first 10 sample updates. Writes nothing.
 *  4. `--apply`: write updates with batched writes (max 400 ops per batch,
 *     committed sequentially). Print progress every 100 docs.
 *
 * Safety guards (enforced even with --apply; non-zero exit if tripped)
 * ───────────────────────────────────────────────────────────────────
 *   - campaign_logs has fewer than 3 entries (insufficient anchors)
 *   - More than 25% of docs are unmappable (something else is wrong)
 *   - The estimate of writes exceeds 5000 (sanity check)
 *
 * Usage
 * ─────
 *   node scripts/backfill-newsletter-campaign-ids.mjs               # dry run, both
 *   node scripts/backfill-newsletter-campaign-ids.mjs --dry-run     # explicit
 *   node scripts/backfill-newsletter-campaign-ids.mjs --collection deliveries
 *   node scripts/backfill-newsletter-campaign-ids.mjs --collection events
 *   node scripts/backfill-newsletter-campaign-ids.mjs --limit 500
 *   node scripts/backfill-newsletter-campaign-ids.mjs --apply       # writes!
 *
 * Initialization
 * ──────────────
 *   Uses Firebase Admin SDK with the service account at
 *   `mcp-gsc-main/service_account_credentials.json` (relative to repo root).
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Constants ─────────────────────────────────────────────────────────

const VALID_CID_RE = /^weekly_\d{4}-\d{2}-\d{2}$/;
const MS_PER_HOUR = 3600 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const WINDOW_BEFORE_MS = 24 * MS_PER_HOUR;   // sentAt - 24h
const WINDOW_AFTER_MS = 7 * MS_PER_DAY;      // sentAt + 7d

const BATCH_SIZE = 400;            // Firestore hard cap is 500; leave headroom
const PROGRESS_EVERY = 100;        // print every N writes

// Safety guards
const MIN_CAMPAIGN_LOGS = 3;
const MAX_UNMAPPABLE_FRACTION = 0.25;
const MAX_TOTAL_WRITES = 5000;

// ── CLI parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const apply = args.includes('--apply');
// `--dry-run` is the default; the flag is accepted for explicitness but
// `apply === false` is the operative signal.
const collectionArg = getArg('--collection', 'both'); // deliveries|events|both
const limit = parseInt(getArg('--limit', '0'), 10) || 0;

if (!['deliveries', 'events', 'both'].includes(collectionArg)) {
  console.error(`ERROR: --collection must be one of: deliveries, events, both (got "${collectionArg}")`);
  process.exit(2);
}

// ── Init Firebase Admin ───────────────────────────────────────────────

const sa = JSON.parse(
  readFileSync(
    new URL('../mcp-gsc-main/service_account_credentials.json', import.meta.url),
  ),
);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Return the Monday (UTC) of the ISO week containing `date`.
 * Mondays are when the cron fires; an email may land Monday morning UTC,
 * occasionally Sunday late UTC — both should resolve to the same Monday.
 *
 * Strategy: take the local-day-of-week (UTC), shift back to Monday, zero the
 * time. JavaScript's getUTCDay() returns 0=Sun..6=Sat; we want 0=Mon..6=Sun.
 *
 * @param {Date} date
 * @returns {Date} Monday 00:00:00 UTC of the same ISO week
 */
function mondayOfWeek(date) {
  const d = new Date(date.getTime());
  const dayUtc = d.getUTCDay();          // 0=Sun..6=Sat
  const offsetToMon = (dayUtc + 6) % 7;  // 0=Mon..6=Sun → days back to Monday
  d.setUTCDate(d.getUTCDate() - offsetToMon);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Format a Date as YYYY-MM-DD (UTC). */
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Coerce various Firestore-ish timestamp shapes to a JS Date or null.
 * Accepts: admin.firestore.Timestamp, Date, ISO string, epoch ms number, null.
 */
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'object' && typeof v.toDate === 'function') {
    try {
      const d = v.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Classify the OLD (corrupted) campaign_id into a histogram bucket.
 * @param {unknown} oldCid
 * @returns {'mailgun-message-id' | 'unknown' | 'empty' | 'other'}
 */
function classifyCorruption(oldCid) {
  if (oldCid == null || oldCid === '') return 'empty';
  if (typeof oldCid !== 'string') return 'other';
  if (oldCid === 'unknown') return 'unknown';
  // Mailgun raw Message-ID looks like `20260503073515.2917922a4c8e980c@frontaliereticino.ch`
  // Heuristic: contains '@' and at least one dot before it.
  if (oldCid.includes('@') && /\d{8,}/.test(oldCid)) return 'mailgun-message-id';
  return 'other';
}

/**
 * @typedef {Object} CampaignWindow
 * @property {string} campaignId   `weekly_YYYY-MM-DD`
 * @property {Date}   sentAt       Anchor timestamp from campaign_logs
 * @property {Date}   windowStart  sentAt - 24h
 * @property {Date}   windowEnd    sentAt + 7d
 * @property {string} subject      Subject (for diagnostics)
 */

/**
 * Load and prepare campaign windows.
 * @returns {Promise<CampaignWindow[]>}
 */
async function loadCampaignWindows() {
  const snap = await db
    .collection('newsletter_subscribers')
    .doc('_meta_')
    .collection('campaign_logs')
    .get();

  /** @type {CampaignWindow[]} */
  const windows = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const sentAt = toDate(data.sentAt);
    if (!sentAt) continue;
    const monday = mondayOfWeek(sentAt);
    const campaignId = `weekly_${isoDate(monday)}`;
    windows.push({
      campaignId,
      sentAt,
      windowStart: new Date(sentAt.getTime() - WINDOW_BEFORE_MS),
      windowEnd: new Date(sentAt.getTime() + WINDOW_AFTER_MS),
      subject: typeof data.subject === 'string' ? data.subject : '',
    });
  }
  windows.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  return windows;
}

/**
 * Pick the campaign window whose [windowStart, windowEnd] contains `ts`.
 * If multiple match (overlapping windows), pick the closest by |Δt| to sentAt.
 *
 * @param {Date} ts
 * @param {CampaignWindow[]} windows
 * @returns {{ window: CampaignWindow, deltaHours: number } | null}
 */
function pickWindow(ts, windows) {
  const t = ts.getTime();
  let best = null;
  let bestDelta = Infinity;
  for (const w of windows) {
    if (t < w.windowStart.getTime() || t > w.windowEnd.getTime()) continue;
    const delta = Math.abs(t - w.sentAt.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = w;
    }
  }
  if (!best) return null;
  return { window: best, deltaHours: bestDelta / MS_PER_HOUR };
}

/**
 * Effective timestamp for a delivery doc. Prefers `sent_at`.
 */
function deliveryTimestamp(data) {
  return toDate(data.sent_at);
}

/**
 * Effective timestamp for an event doc.
 * Prefers earliest of `timestamp` and `occurred_at` (ISO string).
 */
function eventTimestamp(data) {
  const a = toDate(data.timestamp);
  const b = toDate(data.occurred_at);
  if (a && b) return a.getTime() <= b.getTime() ? a : b;
  return a || b;
}

// ── Scan one collection group ─────────────────────────────────────────

/**
 * @typedef {Object} ProposedUpdate
 * @property {string} path        Full Firestore doc path
 * @property {string} oldCid      Old (corrupted) campaign_id (string-coerced)
 * @property {string} newCid      Proposed new campaign_id (`weekly_YYYY-MM-DD`)
 * @property {number} deltaHours  |ts - sentAt| in hours
 * @property {string} kind        'delivery' | 'event'
 * @property {string} corruptionBucket
 * @property {admin.firestore.DocumentReference} ref
 */

/**
 * @typedef {Object} ScanResult
 * @property {number} scanned
 * @property {number} validAlready          // already conforming, skipped
 * @property {number} unmappable
 * @property {Record<string, number>} histogram
 * @property {ProposedUpdate[]} updates
 */

/**
 * @param {'deliveries' | 'events'} kind
 * @param {CampaignWindow[]} windows
 * @returns {Promise<ScanResult>}
 */
async function scanCollectionGroup(kind, windows) {
  const cgName = kind === 'deliveries' ? 'campaign_deliveries' : 'events';
  let q = db.collectionGroup(cgName);
  if (limit > 0) q = q.limit(limit);

  const snap = await q.get();

  const result = {
    scanned: 0,
    validAlready: 0,
    unmappable: 0,
    histogram: {
      'mailgun-message-id': 0,
      'unknown': 0,
      'empty': 0,
      'other': 0,
    },
    updates: [],
  };

  for (const doc of snap.docs) {
    result.scanned += 1;
    const data = doc.data() || {};
    const oldCidRaw = data.campaign_id;
    const oldCidStr = oldCidRaw == null ? '' : String(oldCidRaw);

    if (typeof oldCidRaw === 'string' && VALID_CID_RE.test(oldCidRaw)) {
      result.validAlready += 1;
      continue;
    }

    const bucket = classifyCorruption(oldCidRaw);
    result.histogram[bucket] = (result.histogram[bucket] || 0) + 1;

    const ts = kind === 'deliveries' ? deliveryTimestamp(data) : eventTimestamp(data);
    if (!ts) {
      result.unmappable += 1;
      continue;
    }

    const match = pickWindow(ts, windows);
    if (!match) {
      result.unmappable += 1;
      continue;
    }

    result.updates.push({
      path: doc.ref.path,
      oldCid: oldCidStr,
      newCid: match.window.campaignId,
      deltaHours: Number(match.deltaHours.toFixed(2)),
      kind: kind === 'deliveries' ? 'delivery' : 'event',
      corruptionBucket: bucket,
      ref: doc.ref,
    });
  }

  return result;
}

// ── Apply updates with batched writes ─────────────────────────────────

/**
 * @param {ProposedUpdate[]} updates
 * @returns {Promise<number>} number of docs written
 */
async function applyUpdates(updates) {
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const slice = updates.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const u of slice) {
      batch.update(u.ref, {
        campaign_id: u.newCid,
        _backfilled_at: FieldValue.serverTimestamp(),
        _backfill_old_campaign_id: u.oldCid,
      });
    }
    await batch.commit();
    written += slice.length;
    // Progress every PROGRESS_EVERY (best-effort: print on batch boundaries
    // that cross a PROGRESS_EVERY threshold).
    if (
      Math.floor((written - slice.length) / PROGRESS_EVERY) !==
      Math.floor(written / PROGRESS_EVERY)
    ) {
      console.log(`  ...wrote ${written}/${updates.length}`);
    }
  }
  return written;
}

// ── Reporting ─────────────────────────────────────────────────────────

function printScanReport(label, r) {
  const total = r.scanned;
  const corrupted = total - r.validAlready;
  console.log(`\n[${label}] scanned=${total}  validAlready=${r.validAlready}  corrupted=${corrupted}`);
  console.log(`  histogram of corrupted:`);
  for (const [bucket, count] of Object.entries(r.histogram)) {
    if (count > 0) console.log(`    ${bucket.padEnd(22)} ${count}`);
  }
  console.log(`  remappable=${r.updates.length}  unmappable=${r.unmappable}`);
}

function printSampleUpdates(allUpdates) {
  if (allUpdates.length === 0) {
    console.log('\nNo proposed updates.');
    return;
  }
  console.log(`\nFirst ${Math.min(10, allUpdates.length)} sample proposed updates:`);
  for (const u of allUpdates.slice(0, 10)) {
    const oldShort = u.oldCid.length > 60 ? u.oldCid.slice(0, 57) + '...' : u.oldCid;
    console.log(`  ${u.path}`);
    console.log(`    "${oldShort}" -> ${u.newCid}  (Δ=${u.deltaHours}h, ${u.kind}, ${u.corruptionBucket})`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('backfill-newsletter-campaign-ids');
  console.log('mode:', apply ? 'APPLY (writes!)' : 'dry-run');
  console.log('collection:', collectionArg);
  if (limit > 0) console.log('limit per collection group:', limit);
  console.log('');

  // 1. Build windows
  const windows = await loadCampaignWindows();
  console.log(`Loaded ${windows.length} campaign_logs entries.`);
  if (windows.length > 0) {
    const first = windows[0];
    const last = windows[windows.length - 1];
    console.log(`  earliest: ${first.campaignId}  (sentAt=${first.sentAt.toISOString()})`);
    console.log(`  latest:   ${last.campaignId}  (sentAt=${last.sentAt.toISOString()})`);
  }

  // 2. Scan
  /** @type {ScanResult|null} */
  let deliveriesResult = null;
  /** @type {ScanResult|null} */
  let eventsResult = null;

  if (collectionArg === 'deliveries' || collectionArg === 'both') {
    deliveriesResult = await scanCollectionGroup('deliveries', windows);
    printScanReport('campaign_deliveries', deliveriesResult);
  }
  if (collectionArg === 'events' || collectionArg === 'both') {
    eventsResult = await scanCollectionGroup('events', windows);
    printScanReport('events', eventsResult);
  }

  const allUpdates = [
    ...(deliveriesResult ? deliveriesResult.updates : []),
    ...(eventsResult ? eventsResult.updates : []),
  ];
  const totalScanned =
    (deliveriesResult ? deliveriesResult.scanned : 0) +
    (eventsResult ? eventsResult.scanned : 0);
  const totalUnmappable =
    (deliveriesResult ? deliveriesResult.unmappable : 0) +
    (eventsResult ? eventsResult.unmappable : 0);
  const totalCorrupted =
    (deliveriesResult ? deliveriesResult.scanned - deliveriesResult.validAlready : 0) +
    (eventsResult ? eventsResult.scanned - eventsResult.validAlready : 0);

  console.log('\n── Totals ──────────────────────────────────────');
  console.log(`scanned=${totalScanned}  corrupted=${totalCorrupted}  remappable=${allUpdates.length}  unmappable=${totalUnmappable}`);

  printSampleUpdates(allUpdates);

  // 3. Safety guards (always evaluated; relevant for --apply, informational for dry-run)
  /** @type {string[]} */
  const tripped = [];
  if (windows.length < MIN_CAMPAIGN_LOGS) {
    tripped.push(`campaign_logs has ${windows.length} entries (< ${MIN_CAMPAIGN_LOGS}); insufficient anchors`);
  }
  // unmappable fraction is computed against corrupted docs (validAlready
  // docs aren't candidates for remapping in either direction)
  const unmappableDenominator = totalCorrupted;
  const unmappableFraction = unmappableDenominator > 0
    ? totalUnmappable / unmappableDenominator
    : 0;
  if (unmappableFraction > MAX_UNMAPPABLE_FRACTION) {
    tripped.push(
      `unmappable fraction ${(unmappableFraction * 100).toFixed(1)}% > ${(MAX_UNMAPPABLE_FRACTION * 100).toFixed(0)}% (something else is wrong)`,
    );
  }
  if (allUpdates.length > MAX_TOTAL_WRITES) {
    tripped.push(`estimated writes ${allUpdates.length} > ${MAX_TOTAL_WRITES} (sanity cap)`);
  }

  console.log('\n── Safety guards ───────────────────────────────');
  console.log(`  campaign_logs >= ${MIN_CAMPAIGN_LOGS}        ${windows.length >= MIN_CAMPAIGN_LOGS ? 'OK' : 'FAIL'}  (have ${windows.length})`);
  console.log(`  unmappable <= ${(MAX_UNMAPPABLE_FRACTION * 100).toFixed(0)}%        ${unmappableFraction <= MAX_UNMAPPABLE_FRACTION ? 'OK' : 'FAIL'}  (${(unmappableFraction * 100).toFixed(1)}%)`);
  console.log(`  writes <= ${MAX_TOTAL_WRITES}             ${allUpdates.length <= MAX_TOTAL_WRITES ? 'OK' : 'FAIL'}  (${allUpdates.length})`);

  if (apply) {
    if (tripped.length > 0) {
      console.error('\nABORT --apply: safety guards tripped:');
      for (const t of tripped) console.error(`  - ${t}`);
      process.exit(3);
    }
    if (allUpdates.length === 0) {
      console.log('\nNothing to apply. Exiting.');
      return;
    }
    console.log(`\nApplying ${allUpdates.length} updates in batches of ${BATCH_SIZE}...`);
    const written = await applyUpdates(allUpdates);
    console.log(`Done. Wrote ${written} docs.`);
  } else {
    console.log(`\nDry run only — no writes performed. Re-run with --apply to commit.`);
    if (tripped.length > 0) {
      console.log('Note: --apply would be REJECTED by safety guards:');
      for (const t of tripped) console.log(`  - ${t}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
