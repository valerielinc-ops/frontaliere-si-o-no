#!/usr/bin/env node
/**
 * Dry-run: reproduce the newsletter's featured-article pick using current
 * Firestore state, without sending anything. Useful to verify rotation after
 * rules or selection-logic changes.
 *
 * Usage: node scripts/dryrun-featured-article.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import admin from 'firebase-admin';
import { selectFeaturedArticleId } from '../services/newsletter-article-rotation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SA_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || '/Users/saggesel/Downloads/Lavoro/Sviluppo-IT/frontaliere-ticino-firebase-adminsdk-fbsvc-a0c02a5654.json';

const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

function hasMeta(articleId) {
  const raw = readFileSync(path.resolve(ROOT, 'services/locales/blog-meta-it.ts'), 'utf8');
  return raw.includes(`'blog.article.${articleId}.title'`);
}

const topSnap = await db.collection('article_views').orderBy('views', 'desc').limit(10).get();
const topArticles = topSnap.docs.map((d) => ({
  id: d.id,
  views: d.data().views || 0,
  lastViewed: d.data().lastViewed?.toDate?.() || null,
}));

const metaSnap = await db.collection('newsletter_subscribers').doc('_meta_').get();
const recentlyFeatured = metaSnap.data()?.recently_featured_articles || [];

console.log(`Top articles (${topArticles.length}):`);
topArticles.forEach((a) =>
  console.log(`  ${a.id.padEnd(45)} views=${a.views}  lastViewed=${a.lastViewed?.toISOString().slice(0,10) || 'null'}`),
);
console.log(`\nRecently featured (excluded): ${recentlyFeatured.join(', ') || '(none)'}`);

const pick = selectFeaturedArticleId(topArticles, recentlyFeatured, hasMeta);
const best = topArticles.find((a) => a.id === pick.id);
console.log(`\n→ Would pick: ${pick.id || '(DEFAULT)'} — reason: ${pick.reason}${best ? ` (${best.views} views)` : ''}`);
process.exit(0);
