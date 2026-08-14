#!/usr/bin/env node
/**
 * One-time reconciliation for jobs that share the same persisted `.id`
 * within a single crawler slice but were never collapsed into one record
 * (issue #4603).
 *
 * Root cause: a crawl-time merge legitimately collapses two URL-variant
 * postings of the same requisition into one job (extractStableJobId), but a
 * concurrently-running long-lived job (translate-pending's slug-regen
 * commit) can still hold the pre-collapse snapshot; its 3-way merge in
 * scripts/lib/git-commit-data.sh then resurrected the already-retired
 * variant. That merge bug is fixed separately (mergeArray now respects a
 * remote-side deletion instead of letting a stale local edit resurrect it);
 * this script cleans up duplicate groups that already made it onto disk
 * before that fix.
 *
 * For each `.id` group with >1 record in a slice:
 *   - keep the record with the latest `crawledAt` (freshest crawl wins)
 *   - capture every OTHER record's slug/slugByLocale into the survivor's
 *     previousSlugs so the retired URL still resolves via bridge/redirect
 *   - carry every OTHER record's `needsRetranslation` onto the survivor
 *     (#5645): the flag is monotone and the dropped record is the only place
 *     it may exist, so keeping one side whole would DELETE the mark — the same
 *     resolution this script already refuses for slugs, one field over
 *   - drop the other record(s)
 *
 * Idempotent: a re-run finds no groups. Dry-run by default; --apply writes.
 *
 * Usage:
 *   node scripts/reconcile-duplicate-stable-id-jobs.mjs            # dry-run
 *   node scripts/reconcile-duplicate-stable-id-jobs.mjs --apply    # write
 *   node scripts/reconcile-duplicate-stable-id-jobs.mjs --apply banca-cler.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPreviousSlugForLocale, LOCALES, DEFAULT_PREV_SLUG_CAP } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { carryForwardMarks } from './lib/job-mark-persistence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_FILES = new Set(args.filter((a) => a.endsWith('.json')));

function pickWinner(jobs) {
  return jobs.slice().sort((a, b) => {
    const ta = Date.parse(a.crawledAt || '') || 0;
    const tb = Date.parse(b.crawledAt || '') || 0;
    return tb - ta;
  })[0];
}

function main() {
  const files = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => ONLY_FILES.size === 0 || ONLY_FILES.has(f));

  let totalGroups = 0;
  let totalDropped = 0;
  let marksCarried = 0;
  const report = [];

  for (const file of files) {
    const filePath = path.join(DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const jobs = Array.isArray(data) ? data : (Array.isArray(data?.jobs) ? data.jobs : null);
    if (!jobs || jobs.length === 0) continue;

    const byId = new Map();
    jobs.forEach((job, index) => {
      if (!job?.id) return;
      if (!byId.has(job.id)) byId.set(job.id, []);
      byId.get(job.id).push(index);
    });

    const dropIndexes = new Set();

    for (const [id, indexes] of byId) {
      if (indexes.length < 2) continue;
      totalGroups += 1;
      const group = indexes.map((i) => jobs[i]);
      const winner = pickWinner(group);
      const others = group.filter((j) => j !== winner);

      for (const dropped of others) {
        marksCarried += carryForwardMarks(winner, dropped);
        for (const locale of LOCALES) {
          const slug = dropped.slugByLocale?.[locale];
          if (slug && slug !== winner.slugByLocale?.[locale]) {
            addPreviousSlugForLocale(winner, locale, slug, DEFAULT_PREV_SLUG_CAP, 'reconcile-duplicate-stable-id');
          }
        }
        if (dropped.slug && dropped.slug !== winner.slug) {
          addPreviousSlugForLocale(winner, 'it', dropped.slug, DEFAULT_PREV_SLUG_CAP, 'reconcile-duplicate-stable-id');
        }
      }

      for (const index of indexes) {
        if (jobs[index] !== winner) dropIndexes.add(index);
      }
      totalDropped += others.length;
      report.push(`${file}: id=${id} — kept ${winner.url} (crawledAt=${winner.crawledAt}), dropped ${others.length}`);
    }

    if (dropIndexes.size === 0) continue;

    const survivorJobs = jobs.filter((_, index) => !dropIndexes.has(index));
    console.log(`${file}: ${jobs.length} → ${survivorJobs.length} jobs`);

    if (APPLY) {
      const out = Array.isArray(data) ? survivorJobs : { ...data, jobs: survivorJobs };
      writeJsonAtomic(filePath, out);
    }
  }

  console.log(`\n${APPLY ? 'Applied' : 'Dry-run'}: ${totalGroups} duplicate-id group(s), ${totalDropped} record(s) collapsed, ${marksCarried} needsRetranslation mark(s) carried onto a survivor.`);
  for (const line of report) console.log(`  - ${line}`);
}

main();
