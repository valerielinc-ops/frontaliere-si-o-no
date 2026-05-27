#!/usr/bin/env node
/**
 * fetch-job-popularity.mjs — Export job view counts from Firestore to JSON.
 *
 * Reads all documents from the `job_views` collection and writes a
 * { slug: viewCount } map to data/job-popularity.json.
 *
 * Used by the newsletter workflow to rank jobs by actual engagement.
 *
 * Usage:
 *   node scripts/fetch-job-popularity.mjs
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
    const snap = await db.collection('job_views').get();

    const popularity = {};
    let total = 0;
    snap.forEach((doc) => {
      const data = doc.data();
      const views = Number(data.views) || 0;
      if (views > 0) {
        popularity[doc.id] = views;
        total += views;
      }
    });

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(popularity, null, 2) + '\n');
    console.log(`✅ Wrote ${Object.keys(popularity).length} job popularity entries (${total} total views) to ${path.relative(ROOT, OUTPUT_PATH)}`);
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
