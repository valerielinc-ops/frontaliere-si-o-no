#!/usr/bin/env node
/**
 * Harden Job Slugs — Post-translation slug repair.
 *
 * Runs hardenJobLocaleFields on all per-crawler slice files.
 * Designed to run AFTER translations are complete, so slugs are derived
 * from final translated titles (not intermediate/untranslated ones).
 *
 * Usage:
 *   node scripts/harden-job-slugs.mjs
 *
 * In the combined pipeline (cleanup → translate → harden):
 *   1. cleanup-jobs.mjs with JOBS_SKIP_LOCALE_HARDENING=1 (housekeeping only)
 *   2. relocalize-pending-jobs.mjs (translations)
 *   3. harden-job-slugs.mjs (this script — slug repair on final data)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenJobLocaleFields } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

async function main() {
  const files = fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json')).sort();
  console.log(`🔗 Hardening slugs across ${files.length} per-crawler slices...\n`);

  let totalRepaired = 0;
  let totalJobs = 0;
  let slicesChanged = 0;

  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : (Array.isArray(sliceData) ? sliceData : []);
    if (jobs.length === 0) continue;

    totalJobs += jobs.length;

    // Write jobs to temp file for hardenJobLocaleFields (it operates on file path)
    const tempPath = slicePath + '.harden-tmp.json';
    writeJson(tempPath, jobs);
    try {
      const result = hardenJobLocaleFields({ dataJobsPath: tempPath });
      if (result.changed) {
        totalRepaired += result.repaired;
        slicesChanged++;
        console.log(`  ✅ ${file.replace('.json', '')}: ${result.repaired}/${result.total} jobs repaired`);

        // Write hardened jobs back to slice (preserve envelope)
        const hardened = readJson(tempPath);
        const envelope = (sliceData && typeof sliceData === 'object' && !Array.isArray(sliceData))
          ? { ...sliceData, jobs: hardened, assembledAt: new Date().toISOString() }
          : hardened;
        writeJson(slicePath, envelope);
      }
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  console.log(`\n📊 Slug hardening complete: ${totalRepaired} jobs repaired across ${slicesChanged} slices (${totalJobs} total jobs)`);
}

main().catch(err => {
  console.error('❌ Slug hardening failed:', err?.message || err);
  process.exit(1);
});
