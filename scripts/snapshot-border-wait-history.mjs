#!/usr/bin/env node
/**
 * Snapshot border-wait history from Firestore → data/border-wait-history/.
 *
 * Runs daily at 23:30 CET (see .github/workflows/update-border-wait-history.yml).
 *
 * Reads two Firestore collections (schema confirmed in the F8 design probe):
 *   1. trafficCurrent/{slug}                  — latest overwrite state for each crossing
 *   2. trafficHistory/{slug}/snapshots/{id}   — append-only history, docId = ms timestamp
 *
 * Writes:
 *   - data/border-wait-current.json            — last-known value per crossing
 *   - data/border-wait-history/{YYYY-MM-DD}.json — 24-hour × per-crossing aggregate for today
 *
 * Uses GOOGLE_APPLICATION_CREDENTIALS for Firebase auth (same secret as
 * traffic-scheduler.yml) and prunes history files older than 90 days to
 * keep the repo lean.
 */

import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HISTORY_DIR = path.join(REPO_ROOT, 'data', 'border-wait-history');
const CURRENT_PATH = path.join(REPO_ROOT, 'data', 'border-wait-current.json');

function ensureDirs() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function initFirebase() {
  if (admin.apps.length > 0) return admin;
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  return admin;
}

function toEpochMs(docId) {
  const n = Number(docId);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Aggregate a list of snapshots for a single crossing into 24 hour buckets.
 * Each bucket: { min, avg, max, samples }.
 */
function aggregateByHour(snapshots) {
  /** @type {Array<number[]>} */
  const hours = Array.from({ length: 24 }, () => []);
  for (const s of snapshots) {
    const hour = typeof s.hour === 'number'
      ? s.hour
      : new Date(s._epochMs).getUTCHours();
    if (hour < 0 || hour > 23) continue;
    if (typeof s.waitTimeMinutes !== 'number') continue;
    hours[hour].push(s.waitTimeMinutes);
  }
  return hours.map((samples) => {
    if (samples.length === 0) return null;
    const sum = samples.reduce((a, b) => a + b, 0);
    return {
      min: Math.min(...samples),
      avg: Math.round(sum / samples.length),
      max: Math.max(...samples),
      samples: samples.length,
    };
  });
}

async function fetchTrafficCurrent(db) {
  const snap = await db.collection('trafficCurrent').get();
  /** @type {Record<string, any>} */
  const perCrossing = {};
  let latestUpdate = null;
  snap.forEach((doc) => {
    const data = doc.data();
    const lu = data.lastUpdate?.toDate ? data.lastUpdate.toDate().toISOString() : null;
    perCrossing[doc.id] = {
      waitTimeMinutes: typeof data.waitTimeMinutes === 'number' ? data.waitTimeMinutes : null,
      approachMinutes: data.approachMinutes ?? null,
      totalCrossingMinutes: data.totalCrossingMinutes ?? null,
      status: data.status ?? null,
      source: data.source ?? 'tomtom',
      lastUpdate: lu,
    };
    if (lu && (!latestUpdate || lu > latestUpdate)) latestUpdate = lu;
  });
  return { updatedAt: latestUpdate, perCrossing };
}

async function fetchTrafficHistoryForDay(db, slug, dayKey) {
  const startOfDay = new Date(`${dayKey}T00:00:00.000Z`).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  const snap = await db
    .collection('trafficHistory')
    .doc(slug)
    .collection('snapshots')
    .where(admin.firestore.FieldPath.documentId(), '>=', String(startOfDay))
    .where(admin.firestore.FieldPath.documentId(), '<', String(endOfDay))
    .get();
  /** @type {Array<any>} */
  const rows = [];
  snap.forEach((doc) => {
    const data = doc.data();
    const epochMs = toEpochMs(doc.id);
    if (epochMs === null) return;
    rows.push({ ...data, _epochMs: epochMs });
  });
  return rows;
}

function pruneOldHistory(days = 90) {
  if (!fs.existsSync(HISTORY_DIR)) return;
  const now = Date.now();
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const fileDate = new Date(m[1]).getTime();
    if (Number.isNaN(fileDate)) continue;
    if (now - fileDate > days * 24 * 60 * 60 * 1000) {
      try {
        fs.unlinkSync(path.join(HISTORY_DIR, f));
        console.log(`[prune] removed ${f}`);
      } catch (err) {
        console.warn(`[prune] failed to remove ${f}: ${err.message}`);
      }
    }
  }
}

async function main() {
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!creds || !fs.existsSync(creds)) {
    console.error('❌ GOOGLE_APPLICATION_CREDENTIALS is not set or file does not exist');
    process.exit(1);
  }
  ensureDirs();
  initFirebase();
  const db = admin.firestore();

  const today = new Date().toISOString().slice(0, 10);
  console.log(`🚦 Snapshotting border-wait history for ${today}…`);

  // 1. Current snapshot
  const current = await fetchTrafficCurrent(db);
  fs.writeFileSync(CURRENT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  console.log(`✅ Wrote ${CURRENT_PATH} (${Object.keys(current.perCrossing).length} crossings)`);

  // 2. Daily history aggregate
  const slugs = Object.keys(current.perCrossing);
  /** @type {Record<string, any>} */
  const perCrossing = {};
  for (const slug of slugs) {
    try {
      const rows = await fetchTrafficHistoryForDay(db, slug, today);
      perCrossing[slug] = aggregateByHour(rows);
    } catch (err) {
      console.warn(`[history] ${slug}: ${err.message}`);
      perCrossing[slug] = Array(24).fill(null);
    }
  }
  const dayFile = path.join(HISTORY_DIR, `${today}.json`);
  fs.writeFileSync(
    dayFile,
    JSON.stringify({ date: today, perCrossing }, null, 2) + '\n',
    'utf-8',
  );
  console.log(`✅ Wrote ${dayFile} (${slugs.length} crossings × 24 hour buckets)`);

  pruneOldHistory(90);

  console.log('✅ Snapshot done');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ snapshot-border-wait-history failed:', err);
  process.exit(1);
});
