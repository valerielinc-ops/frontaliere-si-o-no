#!/usr/bin/env node

/**
 * Repair translations lost by naive merge in March 25, 2026 crawler batch.
 *
 * For each crawler data file, reads the current version and the old version
 * from commit 25027a07, then restores titleByLocale, descriptionByLocale,
 * slugByLocale, and previousSlugs from the old version for jobs that have
 * needsRetranslation: true and lost their translations.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const OLD_COMMIT = '25027a07';
const JOBS_DIR = 'data/jobs/by-crawler';
const SUMMARIES_DIR = 'data/jobs-crawler-summaries/by-crawler';

// Locale fields to restore
const LOCALE_FIELDS = ['titleByLocale', 'descriptionByLocale', 'slugByLocale'];

let totalRepaired = 0;
let totalNotRepairable = 0;
let totalAlreadyOk = 0;
let totalFiles = 0;
let filesChanged = 0;

/**
 * Get old file content from git, returns null if file doesn't exist in old commit.
 */
function getOldFile(relativePath) {
  try {
    const content = execSync(`git show ${OLD_COMMIT}:${relativePath}`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large files
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Check if a job's old data had proper translations (at least one non-IT locale differs from IT).
 */
function hadProperTranslations(oldJob) {
  const t = oldJob.titleByLocale;
  if (!t || !t.it) return false;
  return (t.en && t.en !== t.it) || (t.de && t.de !== t.it) || (t.fr && t.fr !== t.it);
}

/**
 * Build a lookup map from old jobs by slug and by url for matching.
 */
function buildOldJobMap(oldJobs) {
  const bySlug = new Map();
  const byUrl = new Map();
  for (const job of oldJobs) {
    if (job.slug) bySlug.set(job.slug, job);
    if (job.url) byUrl.set(job.url, job);
  }
  return { bySlug, byUrl };
}

/**
 * Find matching old job by slug or url.
 */
function findOldJob(currentJob, oldMap) {
  if (currentJob.slug && oldMap.bySlug.has(currentJob.slug)) {
    return oldMap.bySlug.get(currentJob.slug);
  }
  if (currentJob.url && oldMap.byUrl.has(currentJob.url)) {
    return oldMap.byUrl.get(currentJob.url);
  }
  // Try matching by slugByLocale.it (the IT slug is the primary slug)
  if (currentJob.slugByLocale?.it) {
    return oldMap.bySlug.get(currentJob.slugByLocale.it) || null;
  }
  return null;
}

/**
 * Repair a single job array, returns count of repaired and not-repairable.
 */
function repairJobs(currentJobs, oldMap) {
  let repaired = 0;
  let notRepairable = 0;
  let alreadyOk = 0;

  for (const job of currentJobs) {
    if (!job.needsRetranslation) {
      alreadyOk++;
      continue;
    }

    const oldJob = findOldJob(job, oldMap);
    if (!oldJob || !hadProperTranslations(oldJob)) {
      notRepairable++;
      continue;
    }

    // Restore locale fields from old version
    for (const field of LOCALE_FIELDS) {
      if (oldJob[field]) {
        job[field] = oldJob[field];
      }
    }

    // Restore previousSlugs if present in old version
    if (oldJob.previousSlugs && oldJob.previousSlugs.length > 0) {
      job.previousSlugs = oldJob.previousSlugs;
    }

    // Remove needsRetranslation flag since we restored good translations
    delete job.needsRetranslation;

    repaired++;
  }

  return { repaired, notRepairable, alreadyOk };
}

/**
 * Process main job data files in data/jobs/by-crawler/
 */
function processJobFiles() {
  const files = readdirSync(JOBS_DIR).filter(f => f.endsWith('.json'));
  console.log(`\nProcessing ${files.length} job data files in ${JOBS_DIR}/...\n`);

  for (const file of files) {
    const relativePath = join(JOBS_DIR, file);
    const currentData = JSON.parse(readFileSync(relativePath, 'utf8'));
    const oldData = getOldFile(relativePath);

    if (!oldData) {
      console.log(`  SKIP ${file} — not in old commit (new crawler)`);
      continue;
    }

    totalFiles++;
    const currentJobs = currentData.jobs || [];
    const oldJobs = oldData.jobs || [];

    if (oldJobs.length === 0) {
      console.log(`  SKIP ${file} — no jobs in old version`);
      continue;
    }

    const oldMap = buildOldJobMap(oldJobs);
    const { repaired, notRepairable, alreadyOk } = repairJobs(currentJobs, oldMap);

    totalRepaired += repaired;
    totalNotRepairable += notRepairable;
    totalAlreadyOk += alreadyOk;

    if (repaired > 0) {
      writeFileSync(relativePath, JSON.stringify(currentData, null, 2) + '\n');
      filesChanged++;
      console.log(`  FIXED ${file}: ${repaired} repaired, ${notRepairable} not repairable, ${alreadyOk} already ok`);
    } else if (notRepairable > 0) {
      console.log(`  WARN  ${file}: 0 repaired, ${notRepairable} not repairable`);
    }
  }
}

/**
 * Process summary files in data/jobs-crawler-summaries/by-crawler/
 */
function processSummaryFiles() {
  let summaryRepaired = 0;
  let summaryFilesChanged = 0;

  const files = readdirSync(SUMMARIES_DIR).filter(f => f.endsWith('.json'));
  console.log(`\nProcessing ${files.length} summary files in ${SUMMARIES_DIR}/...\n`);

  const JOB_LIST_KEYS = ['newJobs', 'updatedJobs', 'removedJobs', 'unchangedJobs'];

  for (const file of files) {
    const relativePath = join(SUMMARIES_DIR, file);
    const currentData = JSON.parse(readFileSync(relativePath, 'utf8'));
    const oldData = getOldFile(relativePath);

    if (!oldData) {
      console.log(`  SKIP ${file} — not in old commit`);
      continue;
    }

    // Build old job map from all job lists in the old summary
    const allOldJobs = [];
    for (const key of JOB_LIST_KEYS) {
      if (Array.isArray(oldData[key])) {
        allOldJobs.push(...oldData[key]);
      }
    }

    if (allOldJobs.length === 0) continue;

    const oldMap = buildOldJobMap(allOldJobs);
    let fileRepaired = 0;

    // Repair each job list in the current summary
    for (const key of JOB_LIST_KEYS) {
      if (!Array.isArray(currentData[key])) continue;
      const { repaired } = repairJobs(currentData[key], oldMap);
      fileRepaired += repaired;
    }

    if (fileRepaired > 0) {
      writeFileSync(relativePath, JSON.stringify(currentData, null, 2) + '\n');
      summaryFilesChanged++;
      summaryRepaired += fileRepaired;
      console.log(`  FIXED ${file}: ${fileRepaired} jobs repaired`);
    }
  }

  console.log(`\nSummary files: ${summaryRepaired} jobs repaired across ${summaryFilesChanged} files`);
}

// Main
console.log('=== Translation Repair Script ===');
console.log(`Restoring translations from commit ${OLD_COMMIT}\n`);

processJobFiles();

console.log('\n--- Job Data Summary ---');
console.log(`Files processed: ${totalFiles}`);
console.log(`Files changed: ${filesChanged}`);
console.log(`Jobs repaired: ${totalRepaired}`);
console.log(`Jobs not repairable (new, no old translations): ${totalNotRepairable}`);
console.log(`Jobs already ok (no needsRetranslation flag): ${totalAlreadyOk}`);

processSummaryFiles();

console.log('\n=== Done ===');
