#!/usr/bin/env -S npx -y tsx
/**
 * Write the RSS 2.0 feeds for the two article sections into `public/`.
 *
 * The generation logic itself no longer lives here: it moved into
 * `packages/articles/engine/rssFeeds.mjs` (issue #4974 item 2), because the
 * feeds are derived from the corpus and the corpus has its own repository. The
 * articles repo publishes the same feeds from the same module, and this site
 * pulls them (`scripts/pull-articles-api.mjs`) alongside the sitemaps.
 *
 * This wrapper stays for as long as articles are still CREATED here —
 * `create-article.mjs` runs it after every successful generation so the feed a
 * reader sees is not one publish cycle behind. It goes away with the generator.
 *
 * Runs under tsx (see shebang): it imports the article registries, which are
 * TypeScript modules using extensionless relative specifiers that plain Node
 * ESM does not resolve.
 *
 * Usage:
 *   npx tsx scripts/generate-rss-feeds.mjs          # Generate all feeds
 *   npx tsx scripts/generate-rss-feeds.mjs --check  # Verify feeds exist and are valid
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllRssFeeds, RSS_SECTIONS } from '../packages/articles/engine/rssFeeds.mjs';
import { ARTICLES } from '../packages/articles/content/blog-articles-data.ts';
import { SWISS_ARTICLES } from '../packages/articles/content/swiss-articles-data.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const CHECK_ONLY = process.argv.includes('--check');

/** Every feed file the two sections emit, for --check. */
const ALL_FEEDS = RSS_SECTIONS.flatMap((s) => [
  s.mainFeed,
  ...['it', 'en', 'de', 'fr'].map((l) => s.feedFile(l)),
]);

if (CHECK_ONLY) {
  let bad = 0;
  for (const name of ALL_FEEDS) {
    const file = path.join(PUBLIC_DIR, name);
    if (!fs.existsSync(file)) {
      console.error(`   ❌ ${name} missing`);
      bad++;
      continue;
    }
    const src = fs.readFileSync(file, 'utf-8');
    const items = (src.match(/<item>/g) ?? []).length;
    if (items === 0) {
      console.error(`   ❌ ${name} has no <item> entries`);
      bad++;
      continue;
    }
    console.log(`   ✅ ${name} (${items} items)`);
  }
  if (bad > 0) {
    console.error(`📡 RSS check failed: ${bad} feed(s) missing or empty.`);
    process.exit(1);
  }
  console.log('📡 RSS feeds valid.');
  process.exit(0);
}

console.log('📡 Generating RSS feeds...');

const results = buildAllRssFeeds({
  fs,
  path,
  rootDir: ROOT,
  registries: { frontaliere: ARTICLES, svizzera: SWISS_ARTICLES },
});

let written = 0;
for (const section of results) {
  if (section.articleCount === 0) {
    console.warn(`   ⚠️  No articles found for section '${section.id}' — skipping.`);
    continue;
  }
  console.log(
    `   [${section.id}] Found ${section.articleCount} articles, ${section.slugCount} slug mappings`,
  );
  for (const [filename, xml] of section.feeds) {
    fs.writeFileSync(path.join(PUBLIC_DIR, filename), xml, 'utf-8');
    written++;
    console.log(`   ✅ ${filename} written (${Buffer.byteLength(xml, 'utf-8')} bytes)`);
  }
}

if (written === 0) {
  console.error('📡 No RSS feeds generated — refusing to report success.');
  process.exit(1);
}
console.log(`📡 RSS feeds generated successfully (${written} files).`);
