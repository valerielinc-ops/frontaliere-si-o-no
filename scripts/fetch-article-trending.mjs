#!/usr/bin/env node
/**
 * fetch-article-trending.mjs — Export article view counts from Firestore to JSON.
 *
 * Reads all documents from `article_views` collection (1 daily scan via cron)
 * and writes a top-N trending snapshot to public/article-trending.json.
 *
 * Replaces the per-visitor client-side `getDocs(collection('article_views'))`
 * in components/community/BlogArticles.tsx, which was scanning ~1377 docs
 * on every cache-miss visit (~500k–5M reads/wk estimated).
 *
 * Trending logic mirrors the old client logic (BlogArticles.tsx:97-110):
 *   - views within 7d  → full weight
 *   - views within 30d AND views > 5 → half weight (round)
 *   - sort desc, keep top 50 (client filters to top 12 + validIds intersection)
 *
 * Usage:
 *   node scripts/fetch-article-trending.mjs
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS for Firebase Admin SDK.
 * Graceful fallback: writes empty array if Firestore is unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'public', 'article-trending.json');

const TOP_N = 50;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function main() {
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    console.warn('⚠️  firebase-admin not installed — writing empty trending data');
    writeFallback();
    return;
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath || !fs.existsSync(credPath)) {
    console.warn('⚠️  GOOGLE_APPLICATION_CREDENTIALS not set — writing empty trending data');
    writeFallback();
    return;
  }

  try {
    if (!admin.default.apps?.length) {
      admin.default.initializeApp({
        credential: admin.default.credential.cert(
          JSON.parse(fs.readFileSync(credPath, 'utf-8')),
        ),
      });
    }

    const db = admin.default.firestore();
    const snap = await db.collection('article_views').get();

    const now = Date.now();
    const entries = [];

    snap.forEach((doc) => {
      const data = doc.data();
      const lastViewedRaw = data.lastViewed;
      const lastViewed = lastViewedRaw?.toMillis?.()
        ?? (lastViewedRaw?._seconds ? lastViewedRaw._seconds * 1000 : 0)
        ?? (lastViewedRaw instanceof Date ? lastViewedRaw.getTime() : 0);
      const views = Number(data.views) || 0;
      const age = now - lastViewed;

      if (age < SEVEN_DAYS_MS) {
        entries.push({ id: doc.id, views, lastViewed });
      } else if (age < THIRTY_DAYS_MS && views > 5) {
        entries.push({ id: doc.id, views: Math.round(views * 0.5), lastViewed });
      }
    });

    entries.sort((a, b) => b.views - a.views);
    const top = entries.slice(0, TOP_N);

    const payload = {
      generatedAt: new Date().toISOString(),
      totalScanned: snap.size,
      eligible: entries.length,
      entries: top,
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n');
    console.log(
      `✅ Wrote top ${top.length} trending articles (of ${entries.length} eligible, ${snap.size} scanned) to ${path.relative(ROOT, OUTPUT_PATH)}`,
    );
  } catch (err) {
    console.error(`❌ Firestore read failed: ${err.message}`);
    writeFallback();
  }
}

function writeFallback() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), totalScanned: 0, eligible: 0, entries: [] };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`📄 Wrote empty trending fallback to ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeFallback();
});
