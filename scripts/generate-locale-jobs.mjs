#!/usr/bin/env node
/**
 * Generate locale-specific job files from data/jobs.json.
 *
 * Produces public/data/jobs-{it,en,de,fr}.json, each containing only the
 * fields relevant for that locale. The *ByLocale multi-locale objects are
 * replaced by their single-locale counterparts, reducing browser transfer
 * size by ~35–42% compared to loading the monolithic jobs.json.
 *
 * Usage:
 *   node scripts/generate-locale-jobs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_DIR = path.resolve(ROOT, 'public', 'data');

const LOCALES = ['it', 'en', 'de', 'fr'];

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/**
 * Build a locale-specific job entry.
 * The *ByLocale objects are stripped; flat fields are pre-populated with the
 * locale-appropriate value so existing `job.titleByLocale?.[locale] ?? job.title`
 * fallback patterns in the frontend still resolve correctly (via `job.title`).
 */
function buildLocaleJob(job, locale) {
  const { titleByLocale, descriptionByLocale, requirementsByLocale, slugByLocale, ...rest } = job;
  return {
    ...rest,
    title: (titleByLocale && titleByLocale[locale]) || job.title || '',
    description: (descriptionByLocale && descriptionByLocale[locale]) || job.description || '',
    requirements:
      (requirementsByLocale && requirementsByLocale[locale]) || job.requirements || [],
    slug: (slugByLocale && slugByLocale[locale]) || job.slug || '',
  };
}

function main() {
  if (!fs.existsSync(DATA_JOBS)) {
    console.error(`❌ Source file not found: ${DATA_JOBS}`);
    process.exit(1);
  }

  let jobs;
  try {
    jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  } catch (err) {
    console.error(`❌ Failed to parse ${DATA_JOBS}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(jobs)) {
    console.error(`❌ Expected a JSON array in ${DATA_JOBS}`);
    process.exit(1);
  }

  for (const locale of LOCALES) {
    const localeJobs = jobs.map((job) => buildLocaleJob(job, locale));
    const outputPath = path.resolve(PUBLIC_DATA_DIR, `jobs-${locale}.json`);
    writeJson(outputPath, localeJobs);
    console.log(`✅  Generated jobs-${locale}.json (${localeJobs.length} jobs)`);
  }
}

main();
