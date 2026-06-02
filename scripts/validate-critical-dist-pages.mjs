#!/usr/bin/env node
/**
 * Guardrail for deploy builds: fail before artifact upload when critical
 * static SEO pages were not emitted into dist/.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');

const requiredPages = [
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
