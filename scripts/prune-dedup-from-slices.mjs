#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * scripts/prune-dedup-from-slices.mjs
 *
 * Phase 2 of cross-crawler deduplication.
 *
 * Run AFTER:
 *   1. assemble-jobs-dataset.mjs  (creates data/jobs.json from all slices)
 *   2. cleanup-jobs.mjs           (removes cross-crawler title+company duplicates
 *                                  from data/jobs.json — monolithic mode)
 *
 * This script propagates those removals back to the per-crawler slice files so
 * the duplicates are permanently eliminated and not re-detected on every deploy.
 *
 * Logic:
 *   - Reads data/jobs.json → builds sets of kept URL identities, slugs and IDs
 *   - For each slice in data/jobs/by-crawler/, considers jobs absent from all
 *     kept sets, but removes only records with positive cross-crawler dedup
 *     evidence; assembly-only omissions remain fail-closed in the slice
 *   - Hands every route of a pruned row (current per-locale slugs and
 *     previousSlugsByLocale) to the surviving active copy, so an indexed URL
 *     of a still-online vacancy redirects to it instead of falling to the
 *     "unverified job reference" stub; when the survivor cannot be named or
 *     cannot take the history, the pruned row is archived as an expired
 *     soft landing in its own crawler's archive instead
 *   - Reports which jobs were pruned and from which slices
 *   - Writes back only modified slices
 *
 * Safe to run multiple times (idempotent). Does nothing if no duplicates remain.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { readJsonFile } from './lib/read-large-json.mjs';
import { hasUsableJobId } from './lib/job-match-key.mjs';
import { assembleUrlKey } from './lib/job-url-key.mjs';
import {
  createCrossCrawlerDedupSurvivorResolver,
  isProvenCrossCrawlerDedupRemoval,
  loadCrossCrawlerDedupProofFile,
} from './lib/crawler-slice-integrity.mjs';
import { archiveRemovedJobsToSlice, transferSlugHistory } from './lib/expired-jobs-archive.mjs';
import { isLegacyRouteCapRefusal } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readSlice(slicePath) {
  try {
    const slice = readJsonFile(slicePath);
    return slice && Array.isArray(slice.jobs) ? slice : null;
  } catch {
    return null;
  }
}

/** Identity of a row inside ONE slice file, stable across the two passes. */
function sliceRowKey(job) {
  return JSON.stringify([
    String(job?.url ?? '').trim(),
    String(job?.id ?? '').trim(),
    String(job?.slug ?? '').trim(),
  ]);
}

/**
 * Build the membership keys emitted by the assembled dataset.
 *
 * URL identity is checked before slug/id because assembly can repair a slug
 * while retaining the same posting. Without the URL key, that ordinary slug
 * repair is misclassified as a cross-crawler duplicate and the slice writer's
 * shrink guard correctly rejects the destructive write.
 */
export function buildAssembledMembership(assembled) {
  const keptUrls = new Set();
  const keptSlugs = new Set();
  const keptIds = new Set();
  for (const job of assembled) {
    const url = assembleUrlKey(job?.url);
    if (url) keptUrls.add(url);
    if (job?.slug) keptSlugs.add(String(job.slug).trim());
    if (hasUsableJobId(job)) keptIds.add(String(job.id).trim());
  }
  return { keptUrls, keptSlugs, keptIds };
}

export function isJobInAssembledDataset(job, membership) {
  const url = assembleUrlKey(job?.url);
  if (url && membership.keptUrls.has(url)) return true;
  const slug = String(job?.slug || '').trim();
  if (slug && membership.keptSlugs.has(slug)) return true;
  const id = String(job?.id ?? '').trim();
  return Boolean(id && membership.keptIds.has(id));
}

export function filterSliceJobs(original, assembled) {
  const membership = buildAssembledMembership(assembled);
  return original.filter((job) => isJobInAssembledDataset(job, membership));
}

/** Keys under which an assembled survivor is found again in its source slice. */
function survivorSliceKey(job) {
  const url = assembleUrlKey(job?.url);
  if (url) return `url:${url}`;
  return hasUsableJobId(job) ? `id:${String(job.id).trim()}` : null;
}

/**
 * Hand every route of a pruned duplicate to the active copy that survived it.
 *
 * Pruning used to delete the duplicate's slice row and nothing else: its
 * current per-locale slugs and its `previousSlugsByLocale` vanished, so an
 * indexed URL of a vacancy that is STILL online fell through to the
 * "unverified job reference" stub (Denner EN, 0cc1a6b695c). The survivor is
 * the same posting, so the old URLs must resolve to it — previous slugs are
 * served as redirects to the active page, not as an expired soft landing.
 *
 * The transfer runs on a clone and is committed only if it succeeds: a
 * legacy-cap refusal leaves the survivor untouched and the caller archives the
 * pruned row instead, so the route is never lost either way.
 *
 * @returns {boolean} whether the survivor now serves every route of `pruned`
 */
export function inheritPrunedRoutes(survivor, pruned) {
  const candidate = structuredClone(survivor);
  try {
    transferSlugHistory(candidate, pruned, 'prune-dedup-from-slices');
  } catch (error) {
    if (isLegacyRouteCapRefusal(error)) return false;
    throw error;
  }
  for (const key of Object.keys(survivor)) delete survivor[key];
  Object.assign(survivor, candidate);
  return true;
}

export function pruneDedupFromSlices(root = ROOT) {
  const dataJobs = path.join(root, 'data', 'jobs.json');
  const slicesDir = path.join(root, 'data', 'jobs', 'by-crawler');
  const expiredDir = path.join(root, 'data', 'jobs', 'expired', 'by-crawler');
  let assembled = null;
  try {
    assembled = readJsonFile(dataJobs);
    assembled = Array.isArray(assembled) ? assembled : (Array.isArray(assembled?.jobs) ? assembled.jobs : null);
  } catch {
    // Preserve the existing fail-closed behavior when the aggregate is absent,
    // malformed, or not a top-level job array.
    assembled = null;
  }
  if (!Array.isArray(assembled)) {
    console.log('ℹ️  data/jobs.json not found or not an array — nothing to prune. Run assemble-jobs-dataset.mjs first.');
    return { totalPruned: 0, modifiedSlices: 0, inherited: 0, archived: 0 };
  }

  let dedupProof = null;
  try {
    dedupProof = loadCrossCrawlerDedupProofFile({ candidatePath: dataJobs });
    if (dedupProof) {
      console.log(`🔐 Loaded ${dedupProof.entries.length} monolithic dedup proof decision(s)`);
    }
  } catch (error) {
    console.warn(`⚠️  Ignoring unavailable monolithic dedup proof: ${error?.message ?? error}`);
  }

  const membership = buildAssembledMembership(assembled);
  console.log(`📋 Assembled dataset: ${assembled.length} kept jobs`);

  if (!fs.existsSync(slicesDir)) {
    console.log('ℹ️  No slice directory found — nothing to prune.');
    return { totalPruned: 0, modifiedSlices: 0, inherited: 0, archived: 0 };
  }

  const sliceFiles = listSliceFileNames(slicesDir);
  const dedupReferenceJobs = assembled.slice();
  if (dedupProof) dedupReferenceJobs.proof = dedupProof;
  const resolveSurvivor = createCrossCrawlerDedupSurvivorResolver(dedupReferenceJobs);

  // Pass 1 — decide. Every pruned row is paired with the assembled survivor
  // that proves it a duplicate; the slices themselves are not kept in memory.
  const prunedBySlice = new Map();
  const transfersBySurvivorKey = new Map();
  const filesBySurvivorKey = new Map();
  const unresolved = [];
  for (const file of sliceFiles) {
    const slicePath = path.join(slicesDir, file);
    const slice = readSlice(slicePath);
    if (!slice) continue;
    // Index where each row lives so pass 2 re-reads only the slices it writes.
    for (const job of slice.jobs) {
      const key = survivorSliceKey(job);
      if (!key) continue;
      if (!filesBySurvivorKey.has(key)) filesBySurvivorKey.set(key, new Set());
      filesBySurvivorKey.get(key).add(file);
    }

    const absentJobs = slice.jobs.filter((job) => !isJobInAssembledDataset(job, membership));
    const prunedJobs = [];
    let unproven = 0;
    for (const job of absentJobs) {
      if (!isProvenCrossCrawlerDedupRemoval(slicePath, job, dedupReferenceJobs)) {
        unproven += 1;
        continue;
      }
      prunedJobs.push(job);
      const survivor = resolveSurvivor(slicePath, job);
      const key = survivor ? survivorSliceKey(survivor) : null;
      const transfer = { file, job };
      if (!key) {
        unresolved.push(transfer);
        continue;
      }
      if (!transfersBySurvivorKey.has(key)) transfersBySurvivorKey.set(key, []);
      transfersBySurvivorKey.get(key).push(transfer);
    }

    if (unproven > 0) {
      console.warn(
        `⚠️  ${file}: retained ${unproven} absent record(s) without positive `
        + 'cross-crawler dedup proof; assembly-only filtering stays fail-closed',
      );
    }
    if (prunedJobs.length > 0) prunedBySlice.set(file, prunedJobs.map((job) => sliceRowKey(job)));
  }

  // Pass 2 — apply. One write per slice: drop its pruned rows and give its
  // surviving rows the routes of the duplicates they absorbed.
  let totalPruned = 0;
  let modifiedSlices = 0;
  let inherited = 0;
  const delivered = new Set();
  const archiveFallback = [...unresolved];
  const survivorFiles = new Set();
  for (const key of transfersBySurvivorKey.keys()) {
    for (const file of filesBySurvivorKey.get(key) ?? []) survivorFiles.add(file);
  }
  for (const file of sliceFiles) {
    const prunedKeys = prunedBySlice.get(file);
    const slicePath = path.join(slicesDir, file);
    if (!prunedKeys && !survivorFiles.has(file)) continue;
    const slice = readSlice(slicePath);
    if (!slice) continue;

    let changed = false;
    for (const job of slice.jobs) {
      const transfers = transfersBySurvivorKey.get(survivorSliceKey(job));
      if (!transfers) continue;
      for (const transfer of transfers) {
        if (!inheritPrunedRoutes(job, transfer.job)) continue;
        delivered.add(transfer);
        changed = true;
      }
    }

    let kept = slice.jobs;
    if (prunedKeys) {
      const prunedSet = new Set(prunedKeys);
      const prunedJobs = slice.jobs.filter((job) => prunedSet.has(sliceRowKey(job)));
      kept = slice.jobs.filter((job) => !prunedSet.has(sliceRowKey(job)));
      console.log(`🗑️  ${file}: pruned ${prunedJobs.length} proven cross-crawler duplicate(s):`);
      for (const j of prunedJobs.slice(0, 5)) {
        console.log(`   - ${j.id || '?'} "${j.title || '?'}" @ ${j.company || '?'}`);
      }
      if (prunedJobs.length > 5) {
        console.log(`   ... and ${prunedJobs.length - 5} more`);
      }
      totalPruned += prunedJobs.length;
      changed = true;
    }

    if (changed) {
      // The assembled dataset plus the run-bound sidecar is the evidence that
      // these specific records were cross-crawler duplicates. Unproven absent
      // records stay in the slice, so an assembly filter cannot masquerade as
      // a destructive dedup rewrite.
      writeJson(slicePath, { ...slice, jobs: kept }, { dedupReferenceJobs });
      modifiedSlices++;
    }
  }

  // A pruned row whose survivor could not be named, was not found in any
  // slice, or could not take its history under the legacy cap keeps its
  // indexed routes as an expired soft landing in its own crawler's archive.
  for (const transfers of transfersBySurvivorKey.values()) {
    for (const transfer of transfers) {
      if (delivered.has(transfer)) inherited += 1;
      else archiveFallback.push(transfer);
    }
  }
  let archived = 0;
  const fallbackByCrawler = new Map();
  for (const { file, job } of archiveFallback) {
    const crawlerKey = path.basename(file, '.json');
    if (!fallbackByCrawler.has(crawlerKey)) fallbackByCrawler.set(crawlerKey, []);
    fallbackByCrawler.get(crawlerKey).push(job);
  }
  for (const [crawlerKey, jobs] of fallbackByCrawler) {
    archived += archiveRemovedJobsToSlice(jobs, crawlerKey, { dir: expiredDir });
  }

  if (totalPruned === 0) {
    console.log('✅ No cross-crawler duplicates found in slices — all clean.');
  } else {
    console.log(`\n✅ Pruned ${totalPruned} duplicate job(s) across ${modifiedSlices} slice file(s).`);
    console.log(`   ↪ ${inherited} pruned row(s) handed their routes to the surviving active copy; ${archiveFallback.length} archived as expired soft landings (${archived} new archive entr${archived === 1 ? 'y' : 'ies'}).`);
  }
  return { totalPruned, modifiedSlices, inherited, archived };
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  pruneDedupFromSlices();
}
