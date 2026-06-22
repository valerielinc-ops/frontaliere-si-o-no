#!/usr/bin/env node
/**
 * Guardrail for deploy builds: fail before artifact upload when critical
 * static SEO pages were not emitted into dist/.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');

// Shard-aware (per-locale MATRIX build): when BUILD_LOCALE is set, this shard
// emits ONLY its owned locale subtree (the others are pruned / never rendered),
// so the non-owned locales' pages are LEGITIMATELY absent — checking them would
// false-fail every shard. Filter the required list to what this shard owns.
// Ownership: en/de/fr live under their `/en` `/de` `/fr` prefix; everything else
// (root index/404, IT landings, sitemap, /data) is IT-owned. Monolith build
// (BUILD_LOCALE unset or all four) → check everything, unchanged.
const ALL_LOCALES = ['it', 'en', 'de', 'fr'];
const ownedLocales = (process.env.BUILD_LOCALE || '')
  .trim()
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter((l) => ALL_LOCALES.includes(l));
const ownedSet = new Set(ownedLocales.length ? ownedLocales : ALL_LOCALES);
const isFullBuild = ownedSet.size === ALL_LOCALES.length;
const ownerOfRel = (rel) => {
  if (rel === 'en/index.html' || rel.startsWith('en/')) return 'en';
  if (rel.startsWith('de/')) return 'de';
  if (rel.startsWith('fr/')) return 'fr';
  return 'it';
};

const allRequiredPages = [
  'index.html',
  '404.html',
  'en/index.html',
  'de/index.html',
  'fr/index.html',
  'calcola-stipendio/index.html',
  'cerca-lavoro-ticino/index.html',
  'glossario-frontaliere/index.html',
  'guida-frontaliere/index.html',
  'mappa-del-sito/index.html',
  'privacy/index.html',
  'sitemap.xml',
  // Data asset fetched at runtime by jobBoardStatsService → /data/jobs-stats.json.
  // A cache-HIT assemble path can skip copying the public twin (see #1148/#1153);
  // a missing/empty file 404s the /<locale>/statistics/ pages silently on prod.
  'data/jobs-stats.json',
];

const requiredPages = isFullBuild
  ? allRequiredPages
  : allRequiredPages.filter((rel) => ownedSet.has(ownerOfRel(rel)));

if (!isFullBuild) {
  console.log(
    `[validate-critical-dist-pages] shard build (BUILD_LOCALE=${[...ownedSet].join(',')}) — checking ${requiredPages.length} owned critical file(s).`,
  );
}

const missing = [];
const empty = [];
for (const rel of requiredPages) {
  const abs = path.join(distDir, rel);
  if (!existsSync(abs)) {
    missing.push(rel);
  } else if (statSync(abs).size === 0) {
    empty.push(rel);
  }
}

if (missing.length > 0 || empty.length > 0) {
  console.error('[validate-critical-dist-pages] FAIL: critical dist files are missing or empty:');
  for (const rel of missing) console.error(`  - dist/${rel} (missing)`);
  for (const rel of empty) console.error(`  - dist/${rel} (zero-byte)`);
  console.error(
    '\nThese files are emitted by post-build SEO/static plugins or copied from public/. Do not upload a Pages artifact until the root cause is fixed.',
  );
  process.exit(1);
}

console.log(`[validate-critical-dist-pages] PASS: ${requiredPages.length} critical dist files present and non-empty`);
