#!/usr/bin/env node
/**
 * fetch-job-popularity.mjs — Export job view counts from Firestore to JSON.
 *
 * Writes a { slug: viewCount } map to data/job-popularity.json, used by the
 * newsletter workflow to rank jobs by actual engagement.
 *
 * ── WHY THIS IS INCREMENTAL ───────────────────────────────────────────────
 * The workflow header still says this scans "~2.9k docs". It did, in April.
 * `job_views` held 66.107 documents on 2026-08-24, and the daily cron was
 * reading every one of them to move a handful of counters — ~66k reads a day,
 * a fifth of what the send-company-alerts scan was costing and for the same
 * reason: the filter lived in the client, not in the query.
 *
 * A view bumps `lastViewed` on the same write that bumps `views`, so the docs
 * that changed since the last successful scan are exactly the docs worth
 * re-reading. Everything else is already in the committed JSON, which the
 * workflow checks out.
 *
 * The full scan still happens — on the first run, whenever the previous
 * snapshot or its metadata is missing or unreadable, when the metadata is
 * older than FULL_SCAN_MAX_AGE_MS, and on `--full`. That weekly floor is what
 * bounds the one thing the incremental path cannot see: a document DELETED
 * from job_views stays in the map until the next full scan. Nothing deletes
 * from job_views today; the floor is there so that staying true is not a
 * precondition for correctness.
 *
 * Reads are also projected (`.select`) down to the two fields used, which is
 * what the egress line on the bill responds to — Firestore charges the read
 * either way, but it does not have to ship the whole document.
 *
 * Usage:
 *   node scripts/fetch-job-popularity.mjs           # incremental when possible
 *   node scripts/fetch-job-popularity.mjs --full    # force the full scan
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS for Firebase Admin SDK.
 * Graceful fallback: writes empty object if Firestore is unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data', 'job-popularity.json');
const META_PATH = path.join(ROOT, 'data', 'job-popularity.meta.json');

/**
 * How stale the metadata may get before the next run re-reads everything.
 * Also the worst-case lifetime of a deleted doc inside the snapshot.
 */
const FULL_SCAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-read a little before the last scan started. Firestore timestamps are
 * server-side and a write can land while the previous scan is streaming, so
 * an exact cutoff can drop that write on the floor. An hour of overlap costs
 * a few extra reads and closes the race.
 */
const OVERLAP_MS = 60 * 60 * 1000;

/** @returns {{ map: Record<string, number>, since: Date } | null} */
function readPreviousSnapshot() {
  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
    const scannedAt = Date.parse(meta?.scannedAt || '');
    if (!Number.isFinite(scannedAt)) return null;
    if (Date.now() - scannedAt > FULL_SCAN_MAX_AGE_MS) {
      console.log(`   ⏲️  Snapshot metadata is older than ${FULL_SCAN_MAX_AGE_MS / 86400000}d — full scan.`);
      return null;
    }
    const map = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    return { map, since: new Date(scannedAt - OVERLAP_MS) };
  } catch {
    return null;
  }
}

async function main() {
  // Firebase Admin SDK — dynamic import
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    console.warn('⚠️  firebase-admin not installed — writing empty popularity data');
    writeFallback();
    return;
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath || !fs.existsSync(credPath)) {
    console.warn('⚠️  GOOGLE_APPLICATION_CREDENTIALS not set — writing empty popularity data');
    writeFallback();
    return;
  }

  try {
    // Initialize Firebase Admin if not already initialized
    if (!admin.default.apps?.length) {
      admin.default.initializeApp({
        credential: admin.default.credential.cert(
          JSON.parse(fs.readFileSync(credPath, 'utf-8')),
        ),
      });
    }

    const db = admin.default.firestore();
    const forceFull = process.argv.includes('--full');
    const previous = forceFull ? null : readPreviousSnapshot();
    const scanStartedAt = new Date();

    // `.select()` keeps the read count identical and the payload small.
    let query = db.collection('job_views').select('views');
    if (previous) query = query.where('lastViewed', '>=', previous.since);

    const snap = await query.get();

    const popularity = previous ? { ...previous.map } : {};
    for (const doc of snap.docs) {
      const views = Number(doc.get('views')) || 0;
      if (views > 0) popularity[doc.id] = views;
      else delete popularity[doc.id];
    }
    const total = Object.values(popularity).reduce((a, b) => a + b, 0);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(popularity, null, 2) + '\n');
    fs.writeFileSync(META_PATH, JSON.stringify({
      scannedAt: scanStartedAt.toISOString(),
      mode: previous ? 'incremental' : 'full',
      docsRead: snap.size,
      entries: Object.keys(popularity).length,
    }, null, 2) + '\n');
    const mode = previous
      ? `incremental (${snap.size} docs read since ${previous.since.toISOString()})`
      : `full scan (${snap.size} docs read)`;
    console.log(`✅ Wrote ${Object.keys(popularity).length} job popularity entries (${total} total views) to ${path.relative(ROOT, OUTPUT_PATH)} — ${mode}`);
  } catch (err) {
    console.error(`❌ Firestore read failed: ${err.message}`);
    writeFallback();
  }
}

function writeFallback() {
  fs.writeFileSync(OUTPUT_PATH, '{}\n');
  console.log(`📄 Wrote empty popularity fallback to ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeFallback();
});
