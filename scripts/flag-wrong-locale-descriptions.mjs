#!/usr/bin/env node
/**
 * Flag jobs whose descriptionByLocale slots contain text in the wrong language
 * with needsRetranslation=true, so the translate-pending pipeline reprocesses
 * them on its next run.
 *
 * This is a one-shot cleanup for the locale-contamination issue where crawlers
 * seeded all locale slots with the raw source description and the translate
 * pipeline failed to detect the contamination (see isIncomplete in
 * relocalize-pending-jobs.mjs for the detection logic).
 *
 * Runs against both the assembled dataset (data/jobs.json) and all per-crawler
 * slices (data/jobs/by-crawler/*.json), so the flag persists after deploy and
 * is carried into the next orchestration cycle.
 *
 * Usage: node scripts/flag-wrong-locale-descriptions.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';
import { normalizeForLengthComparison } from './lib/dedicated-crawler-common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const DETECTION_CONFIDENCE = 0.55;

function hasWrongLocaleDescription(job) {
  const dbl = job.descriptionByLocale || {};
  const baseDesc = String(job.description || '').trim();
  const sourceDesc = baseDesc.toLowerCase();
  const sourceLang = job.sourceLang || 'it';

  for (const locale of LOCALES) {
    const desc = String(dbl[locale] || '').trim();
    if (desc.length < MIN_DESC_CHARS) continue;
    if (locale === sourceLang) continue;

    // Exact match against source
    if (desc.toLowerCase() === sourceDesc) return true;

    // Whitespace-normalized match against source
    const normDesc = normalizeForLengthComparison(desc).toLowerCase();
    const normSource = normalizeForLengthComparison(baseDesc).toLowerCase();
    if (normSource.length >= MIN_DESC_CHARS && normDesc === normSource) return true;

    // Language detection mismatch
    const detected = detectLanguageWithConfidence(desc, locale);
    if (
      detected.confidence >= DETECTION_CONFIDENCE &&
      detected.lang !== locale &&
      LOCALES.includes(detected.lang)
    ) {
      return true;
    }
  }
  return false;
}

function processFile(filePath, label) {
  if (!fs.existsSync(filePath)) return { flagged: 0, total: 0 };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`  ⚠️  ${label}: failed to parse`);
    return { flagged: 0, total: 0 };
  }

  const jobs = Array.isArray(raw) ? raw : raw.jobs;
  if (!Array.isArray(jobs)) return { flagged: 0, total: 0 };

  let flagged = 0;
  for (const job of jobs) {
    if (job.needsRetranslation) continue;
    if (hasWrongLocaleDescription(job)) {
      job.needsRetranslation = true;
      flagged += 1;
    }
  }

  if (flagged > 0) {
    fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    console.log(`  ✅ ${label}: flagged ${flagged}/${jobs.length}`);
  }

  return { flagged, total: jobs.length };
}

function main() {
  console.log('🔍 Flagging jobs with wrong-locale descriptions...\n');

  let totalFlagged = 0;

  // Assembled dataset
  const dataJobsPath = path.join(ROOT, 'data', 'jobs.json');
  const { flagged: dataFlagged } = processFile(dataJobsPath, 'data/jobs.json');
  totalFlagged += dataFlagged;

  // Public mirror
  const publicJobsPath = path.join(ROOT, 'public', 'data', 'jobs.json');
  if (fs.existsSync(publicJobsPath)) {
    const { flagged: publicFlagged } = processFile(publicJobsPath, 'public/data/jobs.json');
    totalFlagged += publicFlagged;
  }

  // Per-crawler slices
  const byCrawlerDir = path.join(ROOT, 'data', 'jobs', 'by-crawler');
  if (fs.existsSync(byCrawlerDir)) {
    const files = fs.readdirSync(byCrawlerDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const { flagged } = processFile(path.join(byCrawlerDir, file), `by-crawler/${file}`);
      totalFlagged += flagged;
    }
  }

  console.log(`\n📊 Total flagged: ${totalFlagged}`);
}

main();
