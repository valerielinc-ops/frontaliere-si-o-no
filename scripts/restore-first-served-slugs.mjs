#!/usr/bin/env node
/**
 * One-shot, review-gated restoration of the first served slug per locale.
 *
 * A dry run derives every change from two versioned sources: the exact job
 * detail URL in url-first-seen and that job's locale-aware slug history. Apply
 * requires the exact dry-run plan plus the expected item count, so a later
 * crawler or ledger refresh cannot silently widen the approved backfill.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import { cleanPreviousSlugsPerLocale } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { hasUsableJobId } from './lib/job-match-key.mjs';
import {
  indexServedSlugCandidateClaims,
  servedSlugSliceWriter,
} from './regenerate-slugs-by-locale.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(args) {
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run') || !apply;
  const alignUnserved = args.includes('--align-unserved');
  if (apply && args.includes('--dry-run')) throw new Error('choose either --dry-run or --apply');
  if (apply && alignUnserved) {
    throw new Error('--align-unserved is measured here and applied by regenerate-slugs-by-locale.mjs');
  }
  const expectedCount = Number(optionValue(args, '--expected-count') || 40);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error('--expected-count must be a non-negative integer');
  }
  return {
    apply,
    dryRun,
    alignUnserved,
    expectedCount,
    slicesDir: path.resolve(optionValue(args, '--slices-dir') || DEFAULT_SLICES_DIR),
    ledger: optionValue(args, '--ledger'),
    planOut: optionValue(args, '--plan-out'),
    approvedPlan: optionValue(args, '--approved-plan'),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stablePlan(changes) {
  return {
    schema: 1,
    changes: [...changes].sort((left, right) => (
      left.slice.localeCompare(right.slice)
      || left.jobId.localeCompare(right.jobId)
      || left.locale.localeCompare(right.locale)
    )),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.ledger) {
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = path.resolve(options.ledger);
  }
  if (options.apply && options.slicesDir !== DEFAULT_SLICES_DIR) {
    throw new Error('--apply is restricted to the canonical data/jobs/by-crawler directory');
  }
  if (options.apply && !options.approvedPlan) {
    throw new Error('--apply requires --approved-plan from a reviewed dry run');
  }

  const approved = options.approvedPlan
    ? stablePlan(readJson(path.resolve(options.approvedPlan)).changes || [])
    : null;
  const approvedBySlot = approved
    ? new Map(approved.changes.map((entry) => [
        `${entry.slice}\u0000${entry.jobId}\u0000${entry.locale}`,
        entry,
      ]))
    : null;

  const files = listSliceFileNames(options.slicesDir).sort();
  if (files.length === 0) {
    throw new Error(`no crawler slices found in ${options.slicesDir}`);
  }
  const usedSlugs = new Map(LOCALES.map((locale) => [locale, new Map()]));
  const candidateClaims = new Map(LOCALES.map((locale) => [locale, new Map()]));
  for (const file of files) {
    const jobs = readJson(path.join(options.slicesDir, file))?.jobs || [];
    for (const job of jobs) {
      if (!hasUsableJobId(job)) continue;
      indexServedSlugCandidateClaims(job, candidateClaims);
      for (const locale of LOCALES) {
        const activeSlug = String(
          job.slugByLocale?.[locale] || (locale === 'it' ? job.slug : '') || '',
        ).trim();
        if (activeSlug && !usedSlugs.get(locale).has(activeSlug)) {
          usedSlugs.get(locale).set(activeSlug, job.id);
        }
      }
    }
  }

  const changes = [];
  const changedSlices = new Map();
  const skipped = new Map();
  for (const file of files) {
    const slicePath = path.join(options.slicesDir, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    let sliceChanged = false;
    for (const job of jobs) {
      let jobChanged = false;
      for (const locale of LOCALES) {
        const approvedEntry = approvedBySlot?.get(`${file}\u0000${job.id}\u0000${locale}`);
        if (approvedBySlot && !approvedEntry) continue;
        const result = servedSlugSliceWriter(job, locale, {
          usedSlugs: usedSlugs.get(locale),
          candidateClaims: candidateClaims.get(locale),
          allowFirstServedRestore: !options.alignUnserved,
          requireCurrentServed: !options.alignUnserved,
        });
        if (!result.changed) {
          skipped.set(result.reason, (skipped.get(result.reason) || 0) + 1);
          continue;
        }
        jobChanged = true;
        sliceChanged = true;
        const change = {
          slice: file,
          jobId: result.jobId,
          locale: result.locale,
          previousSlug: result.previousSlug,
          nextSlug: result.nextSlug,
          firstServedAt: result.firstServedAt,
          candidateOrigin: result.candidateOrigin,
        };
        if (approvedEntry && JSON.stringify(change) !== JSON.stringify(approvedEntry)) {
          throw new Error(`approved source evidence changed for ${file}:${job.id}:${locale}`);
        }
        changes.push(change);
      }
      if (jobChanged) cleanPreviousSlugsPerLocale(job);
    }
    if (sliceChanged) changedSlices.set(slicePath, sliceData);
  }

  const plan = stablePlan(changes);
  if (approved && JSON.stringify(approved) !== JSON.stringify(plan)) {
    throw new Error(`approved plan no longer resolves exactly (${plan.changes.length}/${approved.changes.length} entries)`);
  }
  if (options.planOut) writeJson(path.resolve(options.planOut), plan);
  const countMatches = plan.changes.length === options.expectedCount;

  if (options.apply) {
    if (!countMatches) {
      throw new Error(`approved restoration count changed: expected ${options.expectedCount}, measured ${plan.changes.length}`);
    }
    for (const [slicePath, sliceData] of changedSlices) writeJson(slicePath, sliceData);
  }

  const skippedSummary = Object.fromEntries([...skipped].sort(([a], [b]) => a.localeCompare(b)));
  console.log(JSON.stringify({
    mode: options.apply
      ? 'apply-first-served'
      : options.alignUnserved
        ? 'dry-run-align-unserved'
        : 'dry-run-first-served',
    selected: plan.changes.length,
    expected: options.expectedCount,
    countMatches,
    changedSlices: changedSlices.size,
    skipped: skippedSummary,
    planOut: options.planOut ? path.resolve(options.planOut) : null,
  }, null, 2));
  if (!countMatches) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[restore-first-served-slugs] ${error?.message || error}`);
  process.exitCode = 1;
});
