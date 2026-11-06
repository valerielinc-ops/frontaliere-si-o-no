#!/usr/bin/env node
// One-time rebaseline for issue #1158: heal bare "St"/"St." addressLocality
// leaked into indexed JobPosting JSON-LD across the checked-in by-crawler slices.
//
// Uses the SAME recovery as the live normalizer (healTruncatedStLocalities in
// scripts/lib/dedicated-crawler-common.mjs) so the committed data matches what
// future crawler runs emit — zero drift. Records with no confidently-recoverable
// signal are LEFT UNTOUCHED and reported as deferred (issue #1158: a wrong city
// is worse than a deferred one).
//
// Scope: only `location`, `addressLocality`, `addressRegion`, `canton` on
// records whose locality is the bare "St"/"St." token. No other fields touched.
//
// Usage:
//   node scripts/rebaseline-truncated-st-locality.mjs           # apply
//   node scripts/rebaseline-truncated-st-locality.mjs --dry-run # report only

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import {
  TRUNCATED_ST_LOCALITY_RE,
  healTruncatedStLocalities,
} from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const BY_CRAWLER_DIR = path.resolve('data/jobs/by-crawler');

const isBare = (j) => TRUNCATED_ST_LOCALITY_RE.test(String(j.addressLocality || j.location || '').trim());

let filesChanged = 0;
let totalHealed = 0;
let totalDeferred = 0;
const deferred = [];
const recoverySummary = {};

const files = listSliceFileNames(BY_CRAWLER_DIR);

for (const file of files) {
  const full = path.join(BY_CRAWLER_DIR, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf-8'));
  } catch {
    continue;
  }
  const jobs = Array.isArray(data) ? data : data.jobs;
  if (!Array.isArray(jobs)) continue;

  const crawler = file.replace(/\.json$/, '');
  const bareBefore = jobs.filter(isBare);
  if (!bareBefore.length) continue;

  const { healed, deferred: deferredCount } = healTruncatedStLocalities(jobs);

  // Record per-crawler recovered cities for the report.
  for (const job of bareBefore) {
    if (!isBare(job)) {
      recoverySummary[crawler] = recoverySummary[crawler] || {};
      recoverySummary[crawler][job.addressLocality] = (recoverySummary[crawler][job.addressLocality] || 0) + 1;
    } else {
      deferred.push({ crawler, slug: job.slug || '', region: job.addressRegion || '', plz: job.postalCode || '' });
    }
  }

  totalHealed += healed;
  totalDeferred += deferredCount;
  if (healed > 0) {
    filesChanged++;
    if (!DRY_RUN) {
      writeJsonAtomic(full, data);
    }
  }
}

console.log(`\n${DRY_RUN ? '[DRY-RUN] ' : ''}St-locality rebaseline (issue #1158)`);
console.log('─'.repeat(60));
for (const [crawler, cities] of Object.entries(recoverySummary)) {
  console.log(`  ${crawler.padEnd(34)} ${JSON.stringify(cities)}`);
}
console.log('─'.repeat(60));
console.log(`Files changed: ${filesChanged}  |  Records healed: ${totalHealed}  |  Deferred: ${totalDeferred}`);
if (deferred.length) {
  console.log('\nDeferred (no recoverable signal — left as bare "St", needs manual review):');
  for (const d of deferred) {
    console.log(`  ${d.crawler.padEnd(28)} reg=${d.region} plz=${d.plz} slug=…${String(d.slug).slice(-40)}`);
  }
}
