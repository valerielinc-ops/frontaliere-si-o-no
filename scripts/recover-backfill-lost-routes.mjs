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
 * For each target this script adds, through `addExpiredRoutes`, the
 * listed routes that NO record (active or expired) serves today. It does not use
 * `createSameIdentityArchiveIndex().absorb`: that one counts a stem as served
 * when the record holds its deterministic alias, while here the stem URL itself
 * is served by nobody. It skips a target that is not found exactly once, and
 * never removes a record or a route. Every file is checked against
 * `assertAdditiveRecovery` and the size ceiling before anything is written.
 *
 * A second manifest (scripts/data/residual-lost-routes-20261127.json, all
 * removal causes) proves ownership by the posting-specific source token every
 * historical holder of the route declared; pass it with `--manifest=<path>`.
 * A target with `state: "active"` has no archived record: its routes go to the
 * active record through `addPreviousSlugForLocale`, and a route whose locale
 * bucket is already at DEFAULT_PREV_SLUG_CAP is skipped, never swapped for one.
 *
 * Usage:
 *   node scripts/recover-backfill-lost-routes.mjs             # dry run
 *   node scripts/recover-backfill-lost-routes.mjs --write
 *   node scripts/recover-backfill-lost-routes.mjs --list-files # slices to materialise
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  assertExpiredSliceSize,
  addExpiredRoutes,
  localeRouteKeys,
} from './lib/expired-jobs-archive.mjs';
import { addPreviousSlugForLocale, DEFAULT_PREV_SLUG_CAP } from './lib/dedicated-crawler-common.mjs';
import { setExpiredRouteCanton } from './lib/expired-route-canton.mjs';
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
 * The canonical live-record capture, one route at a time. It stops at the cap:
 * going past it would make the writer evict an older route of the same bucket.
 *
 * @returns {Set<string>} the keys left out because their bucket is full
 */
function addActiveRoutes(record, routeKeys, cantons = {}) {
  const full = new Set();
  for (const key of routeKeys) {
    const separator = key.indexOf(':');
    const locale = key.slice(0, separator);
    const slug = key.slice(separator + 1);
    if ((record.previousSlugsByLocale?.[locale]?.length || 0) >= DEFAULT_PREV_SLUG_CAP) {
      full.add(key);
      continue;
    }
    addPreviousSlugForLocale(record, locale, slug, DEFAULT_PREV_SLUG_CAP, 'recover-backfill-lost-routes', { syncLegacy: false });
    if (cantons[locale]?.[slug]) setExpiredRouteCanton(record, locale, slug, cantons[locale][slug]);
  }
  return full;
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
    let capFull = new Set();
    if (target.state === 'active') capFull = addActiveRoutes(record, wanted, target.cantons);
    else addExpiredRoutes(record, wanted, { cantons: target.cantons, source: 'recover-backfill-lost-routes' });
    const served = localeRouteKeys(record);
    for (const key of wanted) {
      if (served.has(key)) {
        allowed.add(key);
        taken.add(key);
      } else {
        skipped.push({ key, reason: capFull.has(key) ? 'cap-full' : 'unrepresentable' });
      }
    }
  }
  const added = assertAdditiveRecovery(rows, next, { allowed, heldKeys });
  return { rows: next, added, skipped };
}

const gitBlobId = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

const sliceDirOf = (expiredDir, state) => (state === 'active' ? path.resolve(expiredDir, '..', '..', 'by-crawler') : expiredDir);

function sliceNames(dir, crawlerKey) {
  const own = (name) => name === `${crawlerKey}.json`
    || (name.startsWith(`${crawlerKey}.shard-`) && /^\.shard-\d+\.json$/.test(name.slice(crawlerKey.length)));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(own).sort() : [];
}

/** The slices of one crawler: archive shards, or the active envelope(s). */
function readTargetShards(expiredDir, crawlerKey, state) {
  if (state !== 'active') return readExpiredSliceShards(crawlerKey, { dir: expiredDir });
  const dir = sliceDirOf(expiredDir, state);
  return sliceNames(dir, crawlerKey).map((name) => {
    const file = path.join(dir, name);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(envelope.jobs)) throw new Error(`${file} is not an active job slice`);
    return { path: file, rows: envelope.jobs, envelope };
  });
}

function parseSliceRows(file, text) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed.jobs;
  if (!Array.isArray(rows)) throw new Error(`${file} is not a job slice`);
  return rows;
}

/**
 * Plan the recovery over `readShards(crawlerKey)`: which slices change and how.
 * Writes nothing.
 *
 * @param {{targets: object[]}} manifest
 * @param {(crawlerKey: string) => {path: string, rows: object[]}[]} readShards
 * @param {Set<string>} heldKeys
 */
function planRecovery(manifest, readShards, heldKeys) {
  const bySlices = new Map();
  for (const target of manifest.targets) {
    const state = target.state === 'active' ? 'active' : 'expired';
    const group = `${state}/${target.crawlerKey}`;
    if (!bySlices.has(group)) bySlices.set(group, { crawlerKey: target.crawlerKey, state, targets: [] });
    bySlices.get(group).targets.push(target);
  }
  const held = new Set(heldKeys);
  const files = [];
  const crawlers = [];
  const added = [];
  const skipped = [];
  for (const { crawlerKey, state, targets } of bySlices.values()) {
    const shards = readShards(crawlerKey, state);
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
      // An active slice is an envelope around its rows; only the rows change.
      files.push({ path: shard.path, rows: slice, payload: shard.envelope ? { ...shard.envelope, jobs: slice } : slice });
    }
    crawlers.push(crawlerKey);
  }
  return { files, crawlers, added, skipped };
}

/**
 * Every route served by the slices that a commit would contain, that is by the
 * git index: a route seen only in a file that never reaches the commit would be
 * skipped as served and stay lost. A slice the sparse checkout left out is read
 * from its blob (a partial population would make served routes look lost).
 *
 * Throws on an untracked slice, an unmerged entry, and a tracked slice that
 * differs on disk from the index. The one accepted difference is this script's
 * own unstaged output: exactly what `manifest` produces from the index rows.
 */
export function collectHeldRoutes(rootDir, { manifest = { targets: [] } } = {}) {
  const dirs = ['data/jobs/by-crawler', 'data/jobs/expired/by-crawler'];
  const git = (args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 1 << 29 });
  const tracked = new Map();
  for (const entry of git(['ls-files', '--stage', '-z', '--', ...dirs]).split('\0')) {
    if (!entry.endsWith('.json')) continue;
    const [meta, file] = entry.split('\t');
    const [, oid, stage] = meta.split(' ');
    if (stage !== '0') throw new Error(`unmerged job slice: ${file}`);
    tracked.set(file, oid);
  }
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(rootDir, dir))) continue;
    for (const name of fs.readdirSync(path.join(rootDir, dir))) {
      const file = `${dir}/${name}`;
      if (name.endsWith('.json') && !tracked.has(file)) throw new Error(`untracked job slice: ${file}`);
    }
  }
  if (tracked.size === 0) throw new Error('no job slice found: refusing to treat every route as lost');
  const held = new Set();
  const modified = new Map();
  for (const [file, oid] of tracked) {
    const full = path.join(rootDir, file);
    const disk = fs.existsSync(full) ? fs.readFileSync(full) : null;
    const clean = disk !== null && gitBlobId(disk) === oid;
    const rows = parseSliceRows(file, clean ? disk.toString('utf8') : git(['cat-file', 'blob', oid]));
    for (const row of rows) for (const key of localeRouteKeys(row)) held.add(key);
    if (disk !== null && !clean) modified.set(file, { rows, disk: disk.toString('utf8') });
  }
  if (modified.size === 0) return held;

  const expiredDir = path.join(rootDir, 'data', 'jobs', 'expired', 'by-crawler');
  const relative = (file) => path.relative(rootDir, file).split(path.sep).join('/');
  const plan = planRecovery(manifest, (crawlerKey, state) => readTargetShards(expiredDir, crawlerKey, state)
    .map((shard) => ({ ...shard, rows: modified.get(relative(shard.path))?.rows ?? shard.rows })), held);
  const own = new Map(plan.files.map((file) => [relative(file.path), JSON.stringify(file.rows)]));
  for (const [file, { disk }] of modified) {
    if (own.get(file) !== JSON.stringify(parseSliceRows(file, disk))) {
      throw new Error(`uncommittable local change: ${file} (stage it or restore it)`);
    }
  }
  return held;
}

/**
 * @param {{manifest: {targets: object[]}, expiredDir: string, heldKeys: Set<string>, write?: boolean}} options
 */
export function runRecovery({ manifest, expiredDir, heldKeys, write = false }) {
  const { files, crawlers, added, skipped } = planRecovery(
    manifest,
    (crawlerKey, state) => readTargetShards(expiredDir, crawlerKey, state),
    heldKeys,
  );
  // Nothing is written until every crawler passed its checks.
  if (write) for (const file of files) writeJsonAtomic(file.path, file.payload);
  return { added, skipped, crawlers };
}

export function main(argv, { rootDir = ROOT, manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  const chosen = argv.find((arg) => arg.startsWith('--manifest='))?.slice('--manifest='.length);
  const manifest = JSON.parse(fs.readFileSync(chosen ? path.resolve(rootDir, chosen) : manifestPath, 'utf8'));
  const expiredDir = path.join(rootDir, 'data', 'jobs', 'expired', 'by-crawler');
  const git = (args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 1 << 26 });
  const targetFiles = [...new Set(manifest.targets.flatMap((target) => {
    const dir = target.state === 'active' ? 'data/jobs/by-crawler' : 'data/jobs/expired/by-crawler';
    return git(['ls-files', '--', `${dir}/${target.crawlerKey}.json`, `${dir}/${target.crawlerKey}.shard-*.json`]).split('\n').filter(Boolean);
  }))];
  if (argv.includes('--list-files')) {
    for (const file of targetFiles) console.log(file);
    return;
  }
  // A slice present in the index but absent on disk would be read as empty.
  const missing = targetFiles.filter((file) => !fs.existsSync(path.join(rootDir, file)));
  if (missing.length > 0) throw new Error(`materialise first (--list-files): ${missing.join(', ')}`);
  const write = argv.includes('--write');
  const result = runRecovery({ manifest, expiredDir, heldKeys: collectHeldRoutes(rootDir, { manifest }), write });
  const reasons = {};
  for (const { reason } of result.skipped) reasons[reason] = (reasons[reason] || 0) + 1;
  console.log(`${write ? 'written' : 'dry run'}: routes added=${result.added.length} crawlers=${result.crawlers.length} skipped=${JSON.stringify(reasons)}`);
  if (result.crawlers.length > 0) console.log(`crawlers: ${result.crawlers.join(', ')}`);
}

if (isInvokedDirectly(import.meta.url)) main(process.argv.slice(2));
