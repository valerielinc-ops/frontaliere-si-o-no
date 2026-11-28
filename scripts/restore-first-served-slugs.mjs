#!/usr/bin/env node
/**
 * One-shot, review-gated restoration of the first served slug per locale.
 *
 * A dry run derives every change from two versioned sources: the exact job
 * detail URL in url-first-seen and that job's locale-aware slug history. Apply
 * requires a fixed GSC allowlist and its hashed Search Console receipt, so a
 * later crawler or ledger refresh cannot silently widen the approved backfill.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { cleanPreviousSlugsPerLocale } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { hasUsableJobId } from './lib/job-match-key.mjs';
import {
  indexServedSlugCandidateClaims,
  servedSlugSliceWriter,
} from './regenerate-slugs-by-locale.mjs';
import { jobDetailPathsFor, normalizeServedPath } from './lib/published-slug-stability.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
// The allowlist is deliberately checked in only after the GSC export has been
// reviewed. A generated plan or a caller-selected ledger is evidence of a
// possible change, never authority to rewrite an indexed URL. The number of
// approved slots is not a constant of this script: the receipt proves it
// (`selection.count`, measured from the Search Console export), and the
// allowlist must carry exactly that many entries.
const GSC_ALLOWLIST_FILE = 'gsc-first-served-slug-allowlist.json';
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
    throw new Error('--align-unserved is dry-run-only here; apply FU-007 with regenerate-slugs-by-locale.mjs --align-unserved-only');
  }
  return {
    apply,
    dryRun,
    alignUnserved,
    slicesDir: path.resolve(optionValue(args, '--slices-dir') || DEFAULT_SLICES_DIR),
    ledger: optionValue(args, '--ledger'),
    planOut: optionValue(args, '--plan-out'),
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

function canonicalPathFromUrl(url) {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'frontaliereticino.ch') {
    throw new Error(`allowlist URL is not a canonical frontaliereticino.ch URL: ${url}`);
  }
  return normalizeServedPath(parsed.pathname);
}

export function readCanonicalGscAllowlist(root = ROOT) {
  const allowlistPath = path.join(root, 'data', 'gsc-first-served-slug-allowlist.json');
  if (!fs.existsSync(allowlistPath)) {
    throw new Error(`--apply requires the versioned GSC allowlist at ${allowlistPath}`);
  }
  const source = readJson(allowlistPath);
  if (source?.schema !== 1 || !Array.isArray(source.entries) || typeof source.receiptSha256 !== 'string') {
    throw new Error('GSC allowlist must have schema=1, receiptSha256, and an entries array');
  }
  const receipt = readCanonicalGscReceipt(source.receiptSha256, root);
  if (source.entries.length < 1 || source.entries.length !== receipt.selectionCount) {
    throw new Error(`GSC allowlist must contain exactly the ${receipt.selectionCount} entries proven by the receipt`);
  }
  const bySlot = new Map();
  for (const entry of source.entries) {
    const slice = String(entry?.slice || '');
    const jobId = String(entry?.jobId || '');
    const locale = String(entry?.locale || '');
    const previousSlug = String(entry?.previousSlug || '');
    const nextSlug = String(entry?.nextSlug || '');
    const url = String(entry?.url || '');
    if (!slice || !jobId || !LOCALES.includes(locale) || !previousSlug || !nextSlug || !url) {
      throw new Error('each GSC allowlist entry requires slice, jobId, locale, previousSlug, nextSlug, and url');
    }
    const gscRow = receipt.rowsByUrl.get(canonicalPathFromUrl(url));
    if (!gscRow || !Number.isFinite(gscRow.impressions) || gscRow.impressions <= 0) {
      throw new Error(`GSC receipt has no positive-impression row for ${url}`);
    }
    const key = `${slice}\u0000${jobId}\u0000${locale}`;
    if (bySlot.has(key)) throw new Error(`duplicate GSC allowlist slot: ${key}`);
    bySlot.set(key, { slice, jobId, locale, previousSlug, nextSlug, url });
  }
  return bySlot;
}

function readCanonicalGscReceipt(expectedSha256, root = ROOT) {
  const receiptPath = path.join(root, 'data', 'gsc-first-served-slug-receipt.json');
  if (!fs.existsSync(receiptPath)) {
    throw new Error(`--apply requires the versioned GSC receipt at ${receiptPath}`);
  }
  const raw = fs.readFileSync(receiptPath);
  const actualSha256 = createHash('sha256').update(raw).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('GSC receipt digest does not match the canonical allowlist');
  }
  const receipt = JSON.parse(raw.toString('utf8'));
  if (
    receipt?.schema !== 1
    || receipt.provider !== 'google-search-console'
    || typeof receipt.property !== 'string'
    || !/^https:\/\/frontaliereticino\.ch\/?$/.test(receipt.property)
    || !/^\d{4}-\d{2}-\d{2}T/.test(String(receipt.exportedAt || ''))
    || !Array.isArray(receipt.rows)
    || !Number.isInteger(receipt.selection?.count)
    || receipt.selection.count < 1
  ) {
    throw new Error('GSC receipt must identify the canonical property, export time, and page rows');
  }
  const rowsByUrl = new Map();
  for (const row of receipt.rows) {
    const url = canonicalPathFromUrl(row?.url);
    const impressions = Number(row?.impressions);
    if (!url || !Number.isFinite(impressions) || impressions < 0 || rowsByUrl.has(url)) {
      throw new Error('GSC receipt contains an invalid or duplicate page row');
    }
    rowsByUrl.set(url, { impressions });
  }
  return { rowsByUrl, selectionCount: receipt.selection.count };
}

function assertGscAllowlistIdentity(entry, change, job) {
  if (
    entry.slice !== change.slice
    || entry.jobId !== change.jobId
    || entry.locale !== change.locale
    || entry.previousSlug !== change.previousSlug
    || entry.nextSlug !== change.nextSlug
  ) {
    throw new Error(`GSC allowlist identity changed for ${change.slice}:${change.jobId}:${change.locale}`);
  }
  const servedPath = canonicalPathFromUrl(entry.url);
  const expectedPaths = jobDetailPathsFor(change.locale, change.nextSlug, job);
  if (!expectedPaths.includes(servedPath)) {
    throw new Error(`GSC allowlist URL does not identify ${change.locale}:${change.nextSlug} for ${change.jobId}`);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.apply && options.ledger) {
    throw new Error('--apply always uses the canonical served-URL ledger');
  }
  if (options.apply && process.env.URL_FIRST_SEEN_PATH_OVERRIDE) {
    throw new Error('--apply rejects URL_FIRST_SEEN_PATH_OVERRIDE; unset it to use the canonical served-URL ledger');
  }
  if (options.ledger) {
    process.env.URL_FIRST_SEEN_PATH_OVERRIDE = path.resolve(options.ledger);
  }
  if (options.apply && options.slicesDir !== DEFAULT_SLICES_DIR) {
    throw new Error('--apply is restricted to the canonical data/jobs/by-crawler directory');
  }
  // Dry runs read the allowlist when it is checked in, so they show exactly
  // the slots apply would write; before it exists they show every candidate.
  const gscAllowlistBySlot = options.apply
    || (!options.alignUnserved && fs.existsSync(path.join(ROOT, 'data', GSC_ALLOWLIST_FILE)))
    ? readCanonicalGscAllowlist()
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
        // Only approved slots may be touched: the writer mutates the job as it
        // selects, so an unapproved candidate must never reach it.
        if (gscAllowlistBySlot && !gscAllowlistBySlot.has(`${file}\u0000${job.id}\u0000${locale}`)) {
          skipped.set('not-in-gsc-allowlist', (skipped.get('not-in-gsc-allowlist') || 0) + 1);
          continue;
        }
        const result = servedSlugSliceWriter(job, locale, {
          usedSlugs: usedSlugs.get(locale),
          candidateClaims: candidateClaims.get(locale),
          allowFirstServedRestore: !options.alignUnserved,
          requireCurrentServed: !options.alignUnserved,
          source: 'restore-first-served-slugs/FU-005',
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
        if (gscAllowlistBySlot) {
          assertGscAllowlistIdentity(
            gscAllowlistBySlot.get(`${file}\u0000${job.id}\u0000${locale}`),
            change,
            job,
          );
        }
        changes.push(change);
      }
      if (jobChanged) cleanPreviousSlugsPerLocale(job);
    }
    if (sliceChanged) changedSlices.set(slicePath, sliceData);
  }

  const plan = stablePlan(changes);
  if (gscAllowlistBySlot && plan.changes.length !== gscAllowlistBySlot.size) {
    throw new Error(`GSC allowlist no longer resolves exactly (${plan.changes.length}/${gscAllowlistBySlot.size} entries)`);
  }
  if (options.planOut) writeJson(path.resolve(options.planOut), plan);
  const expected = gscAllowlistBySlot ? gscAllowlistBySlot.size : null;
  const countMatches = expected === null ? null : plan.changes.length === expected;

  if (options.apply) {
    if (!countMatches) {
      throw new Error(`GSC restoration count changed: expected ${expected}, measured ${plan.changes.length}`);
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
    expected,
    countMatches,
    changedSlices: changedSlices.size,
    skipped: skippedSummary,
    planOut: options.planOut ? path.resolve(options.planOut) : null,
  }, null, 2));
  if (countMatches === false) process.exitCode = 2;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`[restore-first-served-slugs] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
