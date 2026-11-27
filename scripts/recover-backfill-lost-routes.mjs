#!/usr/bin/env node
/**
 * One-shot, idempotent, ADD-ONLY recovery of expired-job routes that the history
 * backfill of 2026-11-26 removed from every active and expired record.
 *
 * The manifest (scripts/data/backfill-lost-routes-20261126.json) lists only the
 * routes whose owner is proven: held before the chain (base commit) and at the
 * removal by records declaring ONE `sourceIdentity` that names a single posting,
 * with exactly one expired record of that identity and company still archived.
 * Routes without that proof are not in the manifest.
 *
 * For each target this script adds, through `mergeExpiredRouteEvidence`, the
 * listed routes that NO record (active or expired) serves today. It does not use
 * `createSameIdentityArchiveIndex().absorb`: that one counts a stem as served
 * when the record holds its deterministic alias, while here the stem URL itself
 * is served by nobody. It skips a target that is not found exactly once, and
 * never removes a record or a route. Every file is checked against
 * `assertAdditiveRecovery` and the size ceiling before anything is written.
 *
 * Usage:
 *   node scripts/recover-backfill-lost-routes.mjs             # dry run
 *   node scripts/recover-backfill-lost-routes.mjs --write
 *   node scripts/recover-backfill-lost-routes.mjs --list-files # slices to materialise
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  assertExpiredSliceSize,
  localeRouteKeys,
  mergeExpiredRouteEvidence,
} from './lib/expired-jobs-archive.mjs';
import { readExpiredSliceShards } from './lib/expired-slice-store.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'scripts', 'data', 'backfill-lost-routes-20261126.json');
const ROUTE_FIELDS = new Set(['previousSlugsByLocale', 'previousSlugCantonByLocale']);

function targetRouteKeys(target) {
  return Object.entries(target.routes).flatMap(([locale, slugs]) => slugs.map((slug) => `${locale}:${slug}`));
}

function isTargetRecord(row, target) {
  return row?.slug === target.slug
    && row.sourceIdentity === target.sourceIdentity
    && row.companyKey === target.companyKey;
}

/**
 * Throw unless `after` is `before` plus routes taken from `allowed`: same rows in
 * the same order, no other field touched, route set a superset, no existing
 * route canton changed, and no added route held elsewhere or added twice.
 *
 * @returns {string[]} the added route keys
 */
export function assertAdditiveRecovery(before, after, { allowed, heldKeys }) {
  if (before.length !== after.length) throw new Error(`record count changed: ${before.length} -> ${after.length}`);
  const added = [];
  const seen = new Set();
  before.forEach((oldRow, index) => {
    const newRow = after[index];
    for (const field of new Set([...Object.keys(oldRow), ...Object.keys(newRow)])) {
      if (ROUTE_FIELDS.has(field)) continue;
      if (JSON.stringify(oldRow[field]) !== JSON.stringify(newRow[field])) {
        throw new Error(`field ${field} changed on ${oldRow.slug}`);
      }
    }
    for (const [locale, bySlug] of Object.entries(oldRow.previousSlugCantonByLocale || {})) {
      for (const [slug, canton] of Object.entries(bySlug)) {
        if (newRow.previousSlugCantonByLocale?.[locale]?.[slug] !== canton) {
          throw new Error(`route canton changed on ${oldRow.slug}: ${locale}:${slug}`);
        }
      }
    }
    for (const [locale, slugs] of Object.entries(oldRow.previousSlugsByLocale || {})) {
      const next = new Set(newRow.previousSlugsByLocale?.[locale] || []);
      const missing = slugs.find((slug) => !next.has(slug));
      if (missing !== undefined) throw new Error(`stored route removed on ${oldRow.slug}: ${locale}:${missing}`);
    }
    const oldKeys = localeRouteKeys(oldRow);
    const newKeys = localeRouteKeys(newRow);
    for (const key of oldKeys) {
      if (!newKeys.has(key)) throw new Error(`route lost on ${oldRow.slug}: ${key}`);
    }
    for (const key of newKeys) {
      if (oldKeys.has(key)) continue;
      if (!allowed.has(key)) throw new Error(`unexpected route on ${newRow.slug}: ${key}`);
      if (heldKeys.has(key)) throw new Error(`route already held elsewhere: ${key}`);
      if (seen.has(key)) throw new Error(`route added twice: ${key}`);
      seen.add(key);
      added.push(key);
    }
  });
  return added;
}

/**
 * Add the unheld routes of `targets` to `rows` (one crawler's archive). `rows`
 * is not mutated; `heldKeys` (every route served today) is not mutated either.
 */
export function recoverCrawlerRows(rows, targets, heldKeys) {
  const next = structuredClone(rows);
  const taken = new Set(heldKeys);
  const skipped = [];
  const allowed = new Set();
  for (const target of targets) {
    const keys = targetRouteKeys(target);
    const matches = next.filter((row) => isTargetRecord(row, target));
    const wanted = keys.filter((key) => !taken.has(key));
    for (const key of keys) if (taken.has(key)) skipped.push({ key, reason: 'already-served' });
    if (wanted.length === 0) continue;
    if (matches.length !== 1) {
      for (const key of wanted) skipped.push({ key, reason: `target-matches-${matches.length}` });
      continue;
    }
    const [record] = matches;
    const payload = { previousSlugsByLocale: {}, previousSlugCantonByLocale: {} };
    for (const key of wanted) {
      const locale = key.slice(0, key.indexOf(':'));
      const slug = key.slice(locale.length + 1);
      (payload.previousSlugsByLocale[locale] ||= []).push(slug);
      const canton = target.cantons?.[locale]?.[slug];
      if (canton) (payload.previousSlugCantonByLocale[locale] ||= {})[slug] = canton;
    }
    mergeExpiredRouteEvidence(record, payload, 'recover-backfill-lost-routes');
    const served = localeRouteKeys(record);
    for (const key of wanted) {
      if (served.has(key)) {
        allowed.add(key);
        taken.add(key);
      } else {
        skipped.push({ key, reason: 'unrepresentable' });
      }
    }
  }
  const added = assertAdditiveRecovery(rows, next, { allowed, heldKeys });
  return { rows: next, added, skipped };
}

/**
 * Every route served by any slice. Reads the working tree and, for tracked files
 * a sparse checkout left out, the index blob: a partial population would make
 * served routes look lost.
 */
export function collectHeldRoutes(rootDir) {
  const dirs = ['data/jobs/by-crawler', 'data/jobs/expired/by-crawler'];
  const git = (args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 1 << 29 });
  const tracked = git(['ls-files', '-z', '--', ...dirs]).split('\0').filter((file) => file.endsWith('.json'));
  const onDisk = dirs.flatMap((dir) => (fs.existsSync(path.join(rootDir, dir))
    ? fs.readdirSync(path.join(rootDir, dir)).filter((name) => name.endsWith('.json')).map((name) => `${dir}/${name}`)
    : []));
  const files = new Set([...tracked, ...onDisk]);
  if (files.size === 0) throw new Error('no job slice found: refusing to treat every route as lost');
  const held = new Set();
  for (const file of files) {
    const full = path.join(rootDir, file);
    const parsed = JSON.parse(fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : git(['show', `:${file}`]));
    const rows = Array.isArray(parsed) ? parsed : parsed.jobs;
    if (!Array.isArray(rows)) throw new Error(`${file} is not a job slice`);
    for (const row of rows) for (const key of localeRouteKeys(row)) held.add(key);
  }
  return held;
}

/**
 * @param {{manifest: {targets: object[]}, expiredDir: string, heldKeys: Set<string>, write?: boolean}} options
 */
export function runRecovery({ manifest, expiredDir, heldKeys, write = false }) {
  const byCrawler = new Map();
  for (const target of manifest.targets) {
    if (!byCrawler.has(target.crawlerKey)) byCrawler.set(target.crawlerKey, []);
    byCrawler.get(target.crawlerKey).push(target);
  }
  const held = new Set(heldKeys);
  const files = [];
  const crawlers = [];
  const added = [];
  const skipped = [];
  for (const [crawlerKey, targets] of byCrawler) {
    const shards = readExpiredSliceShards(crawlerKey, { dir: expiredDir });
    const rows = shards.flatMap((shard) => shard.rows);
    const result = recoverCrawlerRows(rows, targets, held);
    skipped.push(...result.skipped);
    if (result.added.length === 0) continue;
    for (const key of result.added) held.add(key);
    added.push(...result.added);
    // Each record is written back to the file it came from. The store writer is
    // not used: it re-homes a row whose identity also exists in an earlier shard,
    // which would turn this add-only change into a cross-file move.
    let offset = 0;
    for (const shard of shards) {
      const slice = result.rows.slice(offset, offset + shard.rows.length);
      offset += shard.rows.length;
      if (JSON.stringify(slice) === JSON.stringify(shard.rows)) continue;
      assertExpiredSliceSize(shard.path, slice);
      files.push({ path: shard.path, rows: slice });
    }
    crawlers.push(crawlerKey);
  }
  // Nothing is written until every crawler passed its checks.
  if (write) for (const file of files) writeJsonAtomic(file.path, file.rows);
  return { added, skipped, crawlers };
}

function main(argv) {
  const manifest = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8'));
  const expiredDir = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
  if (argv.includes('--list-files')) {
    const keys = [...new Set(manifest.targets.map((target) => target.crawlerKey))];
    const tracked = execFileSync('git', ['ls-files', '--', 'data/jobs/expired/by-crawler'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    for (const file of tracked.split('\n')) {
      const name = path.basename(file).replace(/(\.shard-\d+)?\.json$/, '');
      if (keys.includes(name)) console.log(file);
    }
    return;
  }
  // A slice present in the index but absent on disk would be read as empty.
  for (const key of new Set(manifest.targets.map((target) => target.crawlerKey))) {
    const tracked = execFileSync('git', ['ls-files', '--', `data/jobs/expired/by-crawler/${key}.json`, `data/jobs/expired/by-crawler/${key}.shard-*.json`], { cwd: ROOT, encoding: 'utf8' });
    const missing = tracked.split('\n').filter((file) => file && !fs.existsSync(path.join(ROOT, file)));
    if (missing.length > 0) throw new Error(`materialise first (--list-files): ${missing.join(', ')}`);
  }
  const write = argv.includes('--write');
  const result = runRecovery({ manifest, expiredDir, heldKeys: collectHeldRoutes(ROOT), write });
  const reasons = {};
  for (const { reason } of result.skipped) reasons[reason] = (reasons[reason] || 0) + 1;
  console.log(`${write ? 'written' : 'dry run'}: routes added=${result.added.length} crawlers=${result.crawlers.length} skipped=${JSON.stringify(reasons)}`);
  if (result.crawlers.length > 0) console.log(`crawlers: ${result.crawlers.join(', ')}`);
}

if (isInvokedDirectly(import.meta.url)) main(process.argv.slice(2));
