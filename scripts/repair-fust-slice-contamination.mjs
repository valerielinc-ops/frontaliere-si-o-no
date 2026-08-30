#!/usr/bin/env node
/**
 * One-shot repair for data/jobs/by-crawler/fust.json cross-contamination
 * (issue #6657, item 1 of 21: coop-ticino+fust / fust+jumbo / fust+interdiscount).
 *
 * #5975 tightened `isFustJob()` (scripts/update-fust-jobs.mjs) to trust the
 * scraped `company` field over the stamped `companyKey`, specifically to keep
 * other Coop Group subsidiaries out of the Fust slice. But the very next
 * write that predicate would have produced — 327 jobs down to the ~58 that
 * are genuinely Fust — never landed: `writeJobsCrawlerSlice()`'s anti-shrink
 * guard (axa-svizzera incident, 2026-07-01) refuses any write that drops
 * >~50% of the prior slice, so it kept the pre-#5975 contaminated 327-job
 * slice on disk indefinitely. Measured on the committed slice: 269/327 jobs
 * have a `company` field naming another Coop Group brand (185 "Coop
 * Genossenschaft", 23 "Jumbo, Division der Coop Genossenschaft", 17 "Coop",
 * 8 "Interdiscount", plus Two Spice/Betty Bossi/CHRIST/BâleHotels/Marché/
 * railCare/Coop Trading) — the same contamination #5975 fixed for future
 * crawls, just never applied to what was already committed.
 *
 * This is the documented escape hatch for exactly this situation
 * (writeJobsCrawlerSlice's own `skipShrinkGuard` docstring, and precedent
 * scripts/update-swatchgroup-jobs.mjs #4866): re-run the crawler's OWN
 * already-correct predicate against the existing slice and persist the
 * result with the guard bypassed for this one write, because the drop is a
 * verified identity correction, not a degraded scrape — nothing here is
 * being invented, only replayed against stale data. Idempotent: re-running
 * after the fix is applied finds nothing left to drop.
 *
 * Usage:
 *   node scripts/repair-fust-slice-contamination.mjs           # apply
 *   node scripts/repair-fust-slice-contamination.mjs --dry-run # report only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFustJob } from './update-fust-jobs.mjs';
import { writeJobsCrawlerSlice } from './assemble-jobs-dataset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICE_PATH = path.join(ROOT, 'data', 'jobs', 'by-crawler', 'fust.json');

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const slice = JSON.parse(fs.readFileSync(SLICE_PATH, 'utf-8'));
  const priorJobs = Array.isArray(slice?.jobs) ? slice.jobs : [];
  if (!priorJobs.length) {
    console.log('fust.json empty or unreadable — nothing to repair.');
    return;
  }

  const kept = priorJobs.filter(isFustJob);
  const dropped = priorJobs.filter((j) => !isFustJob(j));

  const byCompany = new Map();
  for (const job of dropped) {
    const label = job.company || '(missing company)';
    byCompany.set(label, (byCompany.get(label) || 0) + 1);
  }

  console.log(`fust.json: ${priorJobs.length} jobs on disk, ${kept.length} pass isFustJob(), ${dropped.length} do not.`);
  if (dropped.length) {
    console.log('Contaminating company labels:');
    for (const [label, count] of [...byCompany.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(4)}  ${label}`);
    }
  }

  if (dropped.length === 0) {
    console.log('Nothing to drop — slice already matches isFustJob(). No-op.');
    return;
  }

  if (dryRun) {
    console.log('\n--dry-run: not writing.');
    return;
  }

  writeJobsCrawlerSlice('fust', kept, { skipShrinkGuard: true });
  console.log(`\n✅ Wrote data/jobs/by-crawler/fust.json: ${priorJobs.length} → ${kept.length} jobs (dropped ${dropped.length} cross-brand contamination).`);
}

main();
