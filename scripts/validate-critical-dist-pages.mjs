#!/usr/bin/env node
/**
 * Guardrail for deploy builds: fail before artifact upload when critical
 * static SEO pages were not emitted into dist/.
 */
import { existsSync } from 'node:fs';
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
];

const missing = requiredPages.filter((rel) => !existsSync(path.join(distDir, rel)));

if (missing.length > 0) {
  console.error('[validate-critical-dist-pages] FAIL: critical dist pages are missing:');
  for (const rel of missing) console.error(`  - dist/${rel}`);
  console.error(
    '\nThese pages are emitted by post-build SEO/static plugins. Do not upload a Pages artifact until the root cause is fixed.',
  );
  process.exit(1);
}

console.log(`[validate-critical-dist-pages] PASS: ${requiredPages.length} critical dist files present`);
