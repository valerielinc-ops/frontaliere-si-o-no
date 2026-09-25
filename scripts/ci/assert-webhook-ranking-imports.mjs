#!/usr/bin/env node

/**
 * Guard the ranking import boundary used by all newsletter webhooks.
 *
 * Webhook adapters persist clicks through the store.  The parser itself is a
 * browser-safe link helper, so the store imports it directly from the leaf
 * module instead of reaching it through the Node-backed ranking module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WEBHOOK_CORES = [
  'newsletterMailerooWebhookCore.js',
  'newsletterMailgunWebhookCore.js',
  'newsletterMailjetWebhookCore.js',
  'newsletterMailtrapWebhookCore.js',
  'newsletterResendWebhookCore.js',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const failures = [];
for (const filename of WEBHOOK_CORES) {
  const source = read(path.join('functions', 'src', filename));
  if (!source.includes("from './lib/jobEmailRankingStore.js'")) {
    failures.push(`${filename}: missing direct store import`);
  }
  if (source.includes('parseJobRankingClick') || source.includes("./lib/jobEmailRanking.js")) {
    failures.push(`${filename}: bypasses the store ranking boundary`);
  }
  try {
    await import(pathToFileURL(path.join(ROOT, 'functions', 'src', filename)).href);
  } catch (error) {
    failures.push(`${filename}: functions runtime import failed: ${error?.message || error}`);
  }
}

const store = read(path.join('functions', 'src', 'lib', 'jobEmailRankingStore.js'));
if (!store.includes("import { parseJobRankingClick } from './jobEmailRankingLinks.js';")) {
  failures.push('jobEmailRankingStore.js: parser is not imported directly from link helpers');
}
const rankingImport = store.match(/import \{[^}]*\} from '\.\/jobEmailRanking\.js';/s);
if (rankingImport?.[0].includes('parseJobRankingClick')) {
  failures.push('jobEmailRankingStore.js: parser still arrives through jobEmailRanking.js');
}

const ranking = read(path.join('functions', 'src', 'lib', 'jobEmailRanking.js'));
if (/export\s*\{[^}]*\bMAX_SAFE_SCORE\b/s.test(ranking)) {
  failures.push('jobEmailRanking.js: MAX_SAFE_SCORE is re-exported');
}
if (/export\s*\{[^}]*\b(?:appendJobRankingParams|parseJobRankingClick)\b/s.test(ranking)) {
  failures.push('jobEmailRanking.js: browser link helpers are re-exported');
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('webhook ranking imports: 5 core -> store, store -> link helpers; no ranking re-export path');
}
