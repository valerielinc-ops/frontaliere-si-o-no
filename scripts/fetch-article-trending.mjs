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
 *   node scripts/fetch-article-trending.mjs                 # frontaliere → public/article-trending.json
 *   node scripts/fetch-article-trending.mjs --section=svizzera  # → public/article-trending-ch.json
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS for Firebase Admin SDK.
 * Graceful fallback: writes empty array if Firestore is unavailable.
 *
 * Section note: the `article_views` Firestore collection is keyed by article
 * id with NO section discriminator. There is therefore no view-level field to
 * split frontaliere vs svizzera. For --section=svizzera we intersect doc ids
 * against the SWISS_ARTICLES registry so only svizzera articles enter
 * article-trending-ch.json; frontaliere keeps the original (unfiltered) output.
 * When the svizzera registry is empty (no articles yet), the result is an
 * empty trending file — the runtime already tolerates that gracefully.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Section selection (--section=frontaliere|svizzera, default frontaliere) ──
function _sectionArg() {
  let section = 'frontaliere';
  for (const a of process.argv.slice(2)) {
    const m = /^--section=(.+)$/.exec(a);
    if (m) section = m[1];
  }
  if (!['frontaliere', 'svizzera'].includes(section)) {
    console.error(`Invalid --section="${section}". Valid: frontaliere, svizzera`);
    process.exit(1);
  }
  return section;
}
const SECTION = _sectionArg();
const OUTPUT_PATH = path.join(
  ROOT,
  'public',
  SECTION === 'svizzera' ? 'article-trending-ch.json' : 'article-trending.json',
);

/**
 * For svizzera, build the set of valid article ids from swiss-articles-data.ts
 * so Firestore views for frontaliere articles don't leak into the CH file.
 * Returns null for frontaliere (no filtering = byte-identical behavior).
 */
function loadSectionIdFilter() {
  if (SECTION !== 'svizzera') return null;
  try {
    const src = fs.readFileSync(
      path.join(ROOT, 'data', 'swiss-articles-data.ts'),
      'utf-8',
    );
    const ids = new Set([...src.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]));
    return ids;
  } catch (err) {
    console.warn(`⚠️  Could not read swiss-articles-data.ts for id filter: ${err.message}`);
    return new Set();
  }
}
const SECTION_ID_FILTER = loadSectionIdFilter();

const TOP_N = 50;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Additive, best-effort writeback (issue #3174): stamp analytics.views onto
 * any PUBLISHED journalist_articles doc that also appears in this run's
 * `entries`. `article_views` is keyed directly by article id (see file
 * header comment), and journalist articles use that SAME id (Firestore doc
 * id === pipeline article id — see scripts/publish-journalist-article.mjs),
 * so matching needs no slug indirection. Uses the full `entries` list (not
 * just the top-N slice) so a journalist article's view count is captured
 * even when it doesn't make the top 50. Wrapped end-to-end so a Firestore
 * hiccup never affects this script's existing trending-file output/exit code.
 */
async function writeJournalistAnalyticsBack(db, entries) {
  try {
    if (SECTION !== 'frontaliere' || !entries.length) return;
    const viewsById = new Map(entries.map((e) => [e.id, e.views]));
    const snap = await db.collection('journalist_articles').where('status', '==', 'published').get();
    const nowIso = new Date().toISOString();
    let stamped = 0;
    for (const docSnap of snap.docs) {
      if (!viewsById.has(docSnap.id)) continue;
      await docSnap.ref.update({
        'analytics.views': viewsById.get(docSnap.id),
        'analytics.updatedAt': nowIso,
      });
      stamped += 1;
    }
    if (stamped) console.log(`[trending] journalist analytics writeback: stamped ${stamped} doc(s).`);
  } catch (err) {
    console.warn(`[trending] journalist analytics writeback failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
      // svizzera: keep only views for ids present in the SWISS_ARTICLES registry.
      if (SECTION_ID_FILTER && !SECTION_ID_FILTER.has(doc.id)) return;
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

    await writeJournalistAnalyticsBack(db, entries);
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
