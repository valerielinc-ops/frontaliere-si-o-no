#!/usr/bin/env node
/**
 * One-shot cleanup: remove previousSlugs entries that are currently active
 * in slugByLocale or job.slug. These are redundant bridge pages that
 * redirect to themselves.
 *
 * Usage: node scripts/cleanup-redundant-previous-slugs.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');

const dryRun = process.argv.includes('--dry-run');

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function cleanJob(job) {
  if (!Array.isArray(job.previousSlugs) || job.previousSlugs.length === 0) {
    return 0;
  }

  const activeSlugSet = new Set();
  if (job.slug) activeSlugSet.add(normalizeSpace(job.slug));
  if (job.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const s of Object.values(job.slugByLocale)) {
      if (s) activeSlugSet.add(normalizeSpace(s));
    }
  }

  const before = job.previousSlugs.length;
  job.previousSlugs = job.previousSlugs.filter(s => !activeSlugSet.has(normalizeSpace(s)));
  return before - job.previousSlugs.length;
}

function main() {
  if (!fs.existsSync(BY_CRAWLER_DIR)) {
    console.log('❌ data/jobs/by-crawler/ not found.');
    process.exit(1);
  }

  const files = fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json'));
  let totalRemoved = 0;
  let totalJobs = 0;
  let filesModified = 0;

  for (const file of files) {
    const filePath = path.join(BY_CRAWLER_DIR, file);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const jobs = Array.isArray(raw) ? raw : [];
    let fileRemoved = 0;

    for (const job of jobs) {
      fileRemoved += cleanJob(job);
    }

    totalJobs += jobs.length;
    totalRemoved += fileRemoved;

    if (fileRemoved > 0) {
      filesModified++;
      if (!dryRun) {
        fs.writeFileSync(filePath, JSON.stringify(jobs, null, 2) + '\n');
      }
      console.log(`  📝 ${file}: removed ${fileRemoved} redundant previousSlugs`);
    }
  }

  // Also clean the main jobs.json
  const mainJobsPath = path.resolve(ROOT, 'data', 'jobs.json');
  if (fs.existsSync(mainJobsPath)) {
    const mainRaw = JSON.parse(fs.readFileSync(mainJobsPath, 'utf-8'));
    const mainJobs = Array.isArray(mainRaw) ? mainRaw : [];
    let mainRemoved = 0;
    for (const job of mainJobs) {
      mainRemoved += cleanJob(job);
    }
    if (mainRemoved > 0) {
      if (!dryRun) {
        fs.writeFileSync(mainJobsPath, JSON.stringify(mainJobs, null, 2) + '\n');
      }
      console.log(`  📝 data/jobs.json: removed ${mainRemoved} redundant previousSlugs`);
      totalRemoved += mainRemoved;
    }
  }

  console.log(`\n📊 Summary${dryRun ? ' (DRY RUN)' : ''}:`);
  console.log(`  Files scanned: ${files.length} slices + jobs.json`);
  console.log(`  Jobs scanned: ${totalJobs}`);
  console.log(`  Redundant previousSlugs removed: ${totalRemoved}`);
  console.log(`  Files modified: ${filesModified}`);
}

main();
