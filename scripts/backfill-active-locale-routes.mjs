#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import { isSliceFile, listSliceFilePaths } from './lib/crawler-slice-files.mjs';
import { createCatFileBatch } from './lib/git-cat-file-batch.mjs';
import {
  fingerprintJob,
  DEFAULT_PREV_SLUG_CAP,
  LEGACY_PREV_SLUGS_CAP,
} from './lib/dedicated-crawler-common.mjs';
import { loadRestoreDenylist } from './backfill-prev-slugs-from-loss-events.mjs';
import { isHeldFromPublication } from './lib/translation-publication-hold.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  applyActiveLocaleRouteAlias,
  addServedRoutePaths,
  collectServedRoutePaths,
  planActiveLocaleRouteRecovery,
  stableJobIdentityKeys,
} from './lib/active-locale-route-recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const ACTIVE_DIR_REL = 'data/jobs/by-crawler';
const EXPIRED_DIR_REL = 'data/jobs/expired/by-crawler';
const CANTON_RESOLVERS = createCantonResolvers({
  cantonSlugFile: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-url-slugs.json'), 'utf8')),
  municipalitiesFile: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-municipalities.json'), 'utf8')),
});

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
}

function parseArgs(argv) {
  const args = { base: 'a8901a8fd95', head: 'HEAD', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--base') args.base = argv[++index];
    else if (flag === '--head') args.head = argv[++index];
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--dry-run') args.apply = false;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function routeFor(job, locale, slug) {
  const canton = CANTON_RESOLVERS.resolveJobCanton({ canton: job?.canton, location: job?.location });
  const section = CANTON_RESOLVERS.resolveCantonSection(locale, canton);
  const normalized = String(slug ?? '').trim().split('/').filter(Boolean).join('/');
  const segments = [locale === 'it' ? '' : locale, section, normalized].filter(Boolean);
  return `/${segments.join('/')}/`;
}

function rowsOf(text, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON slice: ${sourceName}`);
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.jobs;
  if (!Array.isArray(rows)) throw new Error(`invalid jobs slice shape: ${sourceName}`);
  return rows;
}

function compactJob(job, held) {
  return {
    id: job?.id,
    url: job?.url,
    slug: job?.slug,
    slugByLocale: job?.slugByLocale,
    previousSlugs: job?.previousSlugs,
    previousSlugsByLocale: job?.previousSlugsByLocale,
    title: job?.title,
    titleByLocale: job?.titleByLocale,
    company: job?.company,
    location: job?.location,
    canton: job?.canton,
    __recoveryHeld: held === true,
  };
}

const isHeld = (job) => job?.__recoveryHeld === true;

function loadHeadRows() {
  const files = listSliceFilePaths(ACTIVE_DIR);
  if (files.length === 0) throw new Error('active crawler slices are not materialized');
  const rows = [];
  for (const file of files) {
    const fileName = path.basename(file);
    const parsed = rowsOf(fs.readFileSync(file, 'utf8'), fileName);
    for (let index = 0; index < parsed.length; index += 1) {
      const job = parsed[index];
      if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
      const held = typeof job.heldFromPublication === 'boolean'
        ? job.heldFromPublication
        : isHeldFromPublication(job);
      rows.push({
        ownerId: `${fileName}\u0000${index}`,
        file,
        fileName,
        index,
        fingerprint: fingerprintJob(job),
        held,
        job: compactJob(job, held),
      });
    }
  }
  return rows;
}

function hasArchivedTitle(entry) {
  return typeof entry?.title === 'string' && entry.title.trim().length > 0
    || Object.values(entry?.titleByLocale || {}).some(
      (value) => typeof value === 'string' && value.trim().length > 0,
    );
}

function addHeadExpiredServedRoutes(target) {
  const files = listSliceFilePaths(EXPIRED_DIR);
  let titledRows = 0;
  for (const file of files) {
    const fileName = path.basename(file);
    const parsed = rowsOf(fs.readFileSync(file, 'utf8'), fileName);
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !hasArchivedTitle(entry)) continue;
      titledRows += 1;
      addServedRoutePaths(target, [{ job: compactJob(entry, false) }], {
        routeFor,
        isHeld,
        includeDerivedActiveSlug: false,
      });
    }
  }
  return { files: files.length, titledRows };
}

function changedBaseBlobs(base, head) {
  const raw = git(['diff', '--raw', '-z', '--no-renames', base, head, '--', ACTIVE_DIR_REL]);
  const tokens = raw.split('\u0000').filter(Boolean);
  const blobs = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const metadata = tokens[index].split(' ').filter(Boolean);
    const relativePath = tokens[index + 1];
    const oldOid = metadata[2];
    const fileName = path.basename(relativePath);
    if (!metadata[0]?.startsWith(':') || !oldOid || [...oldOid].every((character) => character === '0')) continue;
    if (!relativePath.startsWith(`${ACTIVE_DIR_REL}/`) || !isSliceFile(fileName)) continue;
    blobs.push({ oid: oldOid, relativePath, fileName });
  }
  return blobs;
}

/** Return untracked crawler input slices reported by `git status --porcelain`. */
export function untrackedSlicePathsFromStatus(statusText) {
  const paths = [];
  for (const line of String(statusText || '').split('\n')) {
    if (!line.startsWith('?? ')) continue;
    const rawPath = line.slice(3).trim();
    const relativePath = rawPath.startsWith('"')
      ? (() => {
        try { return JSON.parse(rawPath); } catch { return rawPath; }
      })()
      : rawPath;
    const normalized = String(relativePath).replaceAll('\\', '/');
    const underInputDir = [ACTIVE_DIR_REL, EXPIRED_DIR_REL]
      .some((directory) => normalized.startsWith(`${directory}/`));
    if (underInputDir && isSliceFile(path.posix.basename(normalized))) paths.push(normalized);
  }
  return paths;
}

function assertNoUntrackedInputSlices() {
  const status = execFileSync('git', [
    'status', '--porcelain=v1', '--untracked-files=all', '--', ACTIVE_DIR_REL, EXPIRED_DIR_REL,
  ], { cwd: ROOT, encoding: 'utf8' });
  const untracked = untrackedSlicePathsFromStatus(status);
  if (untracked.length > 0) {
    throw new Error(`crawler data has untracked input slices: ${untracked.join(', ')}`);
  }
}

async function loadChangedBaseRows(base, head) {
  const blobs = changedBaseBlobs(base, head);
  const rows = [];
  const reader = createCatFileBatch(ROOT);
  try {
    for (const blob of blobs) {
      const text = await reader.get(blob.oid);
      if (text === null) throw new Error(`base slice blob unavailable: ${blob.fileName}`);
      const parsed = rowsOf(text, blob.fileName);
      for (let index = 0; index < parsed.length; index += 1) {
        const job = parsed[index];
        if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
        const held = typeof job.heldFromPublication === 'boolean'
          ? job.heldFromPublication
          : isHeldFromPublication(job);
        rows.push({
          ownerId: `${blob.fileName}\u0000${index}`,
          fileName: blob.fileName,
          index,
          fingerprint: fingerprintJob(job),
          held,
          job: compactJob(job, held),
        });
      }
    }
  } finally {
    reader.close();
  }
  return { blobs, rows };
}

function assertSelectedHead(head) {
  const selected = git(['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const worktreeHead = git(['rev-parse', 'HEAD']).trim();
  if (selected !== worktreeHead) throw new Error('head revision must match materialized worktree');
  try {
    execFileSync('git', [
      'diff', '--quiet', selected, '--', ACTIVE_DIR_REL, EXPIRED_DIR_REL,
    ], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    throw new Error('crawler data differs from selected revision');
  }
  assertNoUntrackedInputSlices();
  return selected;
}

function applyPlan(actions) {
  const actionsByFile = new Map();
  for (const action of actions) {
    const list = actionsByFile.get(action.file) || [];
    list.push(action);
    actionsByFile.set(action.file, list);
  }
  const pending = [];
  for (const [file, fileActions] of actionsByFile) {
    const fileName = path.basename(file);
    const parsed = rowsOf(fs.readFileSync(file, 'utf8'), fileName);
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
    for (const action of fileActions) {
      const job = jobs[action.index];
      if (!job || (fingerprintJob(job) !== action.fingerprint
        && !stableJobIdentityKeys(job, fingerprintJob).includes(action.identity))) {
        throw new Error(`active slice identity changed before apply: ${fileName}`);
      }
      const held = typeof job.heldFromPublication === 'boolean'
        ? job.heldFromPublication
        : isHeldFromPublication(job);
      if (held || routeFor(job, action.locale, action.slug) !== action.baseRoute) {
        throw new Error(`active slice route changed before apply: ${fileName}`);
      }
      pending.push({ file, parsed, jobs, job, action });
    }
  }
  const pendingByFile = new Map();
  for (const entry of pending) {
    const entries = pendingByFile.get(entry.file) || [];
    entries.push(entry);
    pendingByFile.set(entry.file, entries);
  }
  // Prepare every mutation before touching disk. Backups make the subsequent
  // sequence of per-file atomic renames transactional for ordinary I/O/guard
  // failures: a later failure restores every earlier file byte-for-byte.
  // A multi-file POSIX transaction does not exist, so leave no intentional
  // partial result and fail closed if rollback itself fails.
  for (const entries of pendingByFile.values()) {
    for (const entry of entries) {
      applyActiveLocaleRouteAlias(entry.job, entry.action, {
        localeCap: DEFAULT_PREV_SLUG_CAP,
        legacyCap: LEGACY_PREV_SLUGS_CAP,
      });
    }
  }

  const backups = new Map();
  let backupIndex = 0;
  try {
    for (const file of pendingByFile.keys()) {
      const backup = `${file}.active-locale-route-recovery.${process.pid}.${backupIndex++}.bak`;
      fs.copyFileSync(file, backup);
      backups.set(file, backup);
    }
  } catch (error) {
    for (const backup of backups.values()) {
      try { fs.unlinkSync(backup); } catch { /* best effort */ }
    }
    throw error;
  }

  const written = [];
  try {
    for (const [file, entries] of pendingByFile) {
      writeJsonAtomic(file, entries[0].parsed);
      written.push(file);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const file of written.reverse()) {
      const backup = backups.get(file);
      try {
        fs.renameSync(backup, file);
      } catch (rollbackError) {
        rollbackErrors.push(`${path.basename(file)}: ${rollbackError.message}`);
      }
    }
    for (const backup of backups.values()) {
      try { fs.unlinkSync(backup); } catch { /* already moved or best effort */ }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`active locale route recovery rollback failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
  for (const backup of backups.values()) {
    try { fs.unlinkSync(backup); } catch { /* best effort cleanup */ }
  }
  return written.length;
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = performance.now();
  const args = parseArgs(argv);
  const base = git(['rev-parse', '--verify', `${args.base}^{commit}`]).trim();
  const head = assertSelectedHead(args.head);
  const headRows = loadHeadRows();
  const servedRoutes = collectServedRoutePaths(headRows, {
    routeFor,
    isHeld,
  });
  const headExpired = addHeadExpiredServedRoutes(servedRoutes);
  const baseLoad = await loadChangedBaseRows(base, head);
  const plan = planActiveLocaleRouteRecovery({
    baseRows: baseLoad.rows,
    headRows,
    routeFor,
    fingerprintOf: fingerprintJob,
    denylist: loadRestoreDenylist(),
    localeCap: DEFAULT_PREV_SLUG_CAP,
    legacyCap: LEGACY_PREV_SLUGS_CAP,
    isHeld,
    servedRoutes,
  });
  const filesChanged = args.apply ? applyPlan(plan.actions) : 0;
  const maxRssKiB = process.resourceUsage().maxRSS;
  const report = {
    mode: args.apply ? 'applied' : 'dry-run',
    base: base.slice(0, 12),
    head: head.slice(0, 12),
    baseBlobsRead: baseLoad.blobs.length,
    headExpiredFiles: headExpired.files,
    headExpiredRows: headExpired.titledRows,
    filesChanged,
    ...plan.summary,
    elapsedMs: Math.round(performance.now() - startedAt),
    maxRssKiB,
  };
  delete report.byCrawlerLocale;
  console.log(JSON.stringify(report));
  return report;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch(() => {
    console.error('Active locale route recovery failed closed; no raw job identifiers were emitted.');
    process.exitCode = 1;
  });
}
