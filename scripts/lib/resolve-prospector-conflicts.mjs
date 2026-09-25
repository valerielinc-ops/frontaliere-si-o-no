#!/usr/bin/env node
/**
 * Resolve the generated Prospector files when the queue commit is rebased.
 *
 * `prospector-loop.yml` can spend several minutes between checkout and push.
 * Other writers of `main` can therefore land a commit first.  Git cannot
 * safely merge the re-serialised JSON documents by lines: a plain conflict
 * resolution would either drop the other run's observations or duplicate
 * them.  This resolver runs inside `git-push-with-retry.sh`'s rebase and knows
 * the data semantics of each Prospector document.
 *
 * During a rebase, index stage 2 is the upstream version and stage 3 is the
 * local commit being replayed.  Local observations win on an exact collision,
 * while append-mostly histories and monotonic statuses are merged explicitly.
 * Unknown conflicted paths and malformed JSON fail closed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitShowStage } from './git-show-stage.mjs';

export const PROSPECTOR_PATHS = Object.freeze({
  candidates: 'data/prospector/candidates.json',
  platforms: 'data/prospector/platforms.json',
  validation: 'data/prospector/validation.json',
  webChannelHealth: 'data/prospector/web-channel-health.json',
});

const MISSING = Symbol('missing');
const CRAWLER_PATH = /^data\/prospector\/crawlers\/[^/]+\.json$/;
const CANDIDATE_STATUS_RANK = Object.freeze({
  // `rejected` is a terminal candidate verdict. It must beat every live
  // status when two runs were based on the same candidate, otherwise a stale
  // local snapshot could resurrect a record that the other run tombstoned.
  rejected: 10,
  dead: 1,
  new: 2,
  resolved: 3,
  traced: 4,
  synthesized: 5,
  validated: 6,
  promoted: 7,
  promoting: 8,
  production: 9,
});
const PLATFORM_STATUS_RANK = Object.freeze({ candidate: 0, confirmed: 1, supported: 2, rejected: 3 });
const VALIDATION_VERDICTS = ['good', 'weak', 'bad', 'insufficient'];
const CHANNEL_HISTORY_LIMIT = 60;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function clone(value) {
  if (value === MISSING) return MISSING;
  return structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(a, b) {
  if (a === MISSING || b === MISSING) return a === b;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function objectOrEmpty(value) {
  return isObject(value) ? value : {};
}

function newest(...values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(String)
    .sort(compareTemporal)
    .at(-1) || null;
}

function oldest(...values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(String)
    .sort(compareTemporal)
    .at(0) || null;
}

function compareTemporal(a, b) {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
  return a.localeCompare(b);
}

function unionArray(...arrays) {
  const out = [];
  const seen = new Set();
  for (const array of arrays) {
    if (!Array.isArray(array)) continue;
    for (const value of array) {
      const key = JSON.stringify(canonical(value));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clone(value));
    }
  }
  return out;
}

/**
 * Three-way value merge. A side that is unchanged from the base yields to the
 * side that changed. If both changed, `mergeBoth` owns the domain semantics.
 */
export function mergeThreeWay(base, upstream, local, mergeBoth = (_upstream, local) => clone(local)) {
  if (same(upstream, local)) return clone(upstream);
  if (same(base, upstream)) return clone(local);
  if (same(base, local)) return clone(upstream);
  if (upstream === MISSING && local === MISSING) return MISSING;
  if (upstream === MISSING) return clone(local);
  if (local === MISSING) return clone(upstream);
  return mergeBoth(upstream, local, base);
}

function mergeMap(base, upstream, local, mergeValue) {
  const baseMap = objectOrEmpty(base);
  const upstreamMap = objectOrEmpty(upstream);
  const localMap = objectOrEmpty(local);
  const keys = new Set([...Object.keys(baseMap), ...Object.keys(upstreamMap), ...Object.keys(localMap)]);
  const result = {};
  for (const key of [...keys].sort()) {
    const value = mergeThreeWay(
      hasOwn(baseMap, key) ? baseMap[key] : MISSING,
      hasOwn(upstreamMap, key) ? upstreamMap[key] : MISSING,
      hasOwn(localMap, key) ? localMap[key] : MISSING,
      mergeValue,
    );
    if (value !== MISSING) result[key] = value;
  }
  return result;
}

function mergeUnknownObject(base, upstream, local) {
  const baseObject = objectOrEmpty(base);
  const upstreamObject = objectOrEmpty(upstream);
  const localObject = objectOrEmpty(local);
  const keys = new Set([...Object.keys(baseObject), ...Object.keys(upstreamObject), ...Object.keys(localObject)]);
  const result = {};
  for (const key of [...keys].sort()) {
    const value = mergeThreeWay(
      hasOwn(baseObject, key) ? baseObject[key] : MISSING,
      hasOwn(upstreamObject, key) ? upstreamObject[key] : MISSING,
      hasOwn(localObject, key) ? localObject[key] : MISSING,
      (upstreamValue, localValue, baseValue) => {
        if (Array.isArray(upstreamValue) && Array.isArray(localValue)) {
          return unionArray(upstreamValue, localValue);
        }
        if (isObject(upstreamValue) && isObject(localValue)) {
          return mergeUnknownObject(baseValue, upstreamValue, localValue);
        }
        return clone(localValue);
      },
    );
    if (value !== MISSING) result[key] = value;
  }
  return result;
}

function mergeCandidate(upstream, local) {
  const merged = { ...clone(upstream), ...clone(local) };
  const statuses = [upstream.status, local.status].filter((status) => status in CANDIDATE_STATUS_RANK);
  if (statuses.length) merged.status = statuses.sort((a, b) => CANDIDATE_STATUS_RANK[a] - CANDIDATE_STATUS_RANK[b]).at(-1);

  // These fields are observations accumulated by independent stages. A local
  // re-run must not erase a source, URL, or trail learned by the other run.
  for (const field of ['sources', 'applyHosts', 'careersUrls', 'trailVia', 'vacancySignals']) {
    if (Array.isArray(upstream[field]) || Array.isArray(local[field])) {
      merged[field] = unionArray(upstream[field], local[field]);
    }
  }
  if (Array.isArray(upstream.sampleTitles) || Array.isArray(local.sampleTitles)) {
    merged.sampleTitles = unionArray(upstream.sampleTitles, local.sampleTitles).slice(0, 20);
  }
  if (Array.isArray(upstream.validationHistory) || Array.isArray(local.validationHistory)) {
    const history = unionArray(upstream.validationHistory, local.validationHistory)
      .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')));
    merged.validationHistory = history.slice(-8);
  }
  if (upstream.firstSeenAt || local.firstSeenAt) merged.firstSeenAt = oldest(upstream.firstSeenAt, local.firstSeenAt);
  if (upstream.updatedAt || local.updatedAt) merged.updatedAt = newest(upstream.updatedAt, local.updatedAt);
  if (upstream.rejectedAt || local.rejectedAt) merged.rejectedAt = newest(upstream.rejectedAt, local.rejectedAt);
  return merged;
}

function mergeCounter(upstream, local, base) {
  const upstreamValue = Number(upstream) || 0;
  const localValue = Number(local) || 0;
  const baseValue = Number(base) || 0;
  // host/path hits and expansion attempts are cumulative observations. Each
  // side may have added a different delta since the common base, so taking the
  // max would silently discard one run's evidence. Negative deltas are not
  // expected, but treating them as zero keeps a stale writer from regressing
  // the counter.
  return baseValue + Math.max(0, upstreamValue - baseValue) + Math.max(0, localValue - baseValue);
}

function mergePlatform(upstream, local, base = {}) {
  const merged = { ...clone(upstream), ...clone(local) };
  const statuses = [upstream.status, local.status].filter((status) => status in PLATFORM_STATUS_RANK);
  if (statuses.length) merged.status = statuses.sort((a, b) => PLATFORM_STATUS_RANK[a] - PLATFORM_STATUS_RANK[b]).at(-1);

  for (const field of ['seenOn', 'markers', 'hostSamples', 'listingPaths']) {
    if (Array.isArray(upstream[field]) || Array.isArray(local[field])) merged[field] = unionArray(upstream[field], local[field]);
  }
  for (const field of ['hostHits', 'pathHits']) {
    if (isObject(upstream[field]) || isObject(local[field])) {
      const values = { ...objectOrEmpty(upstream[field]), ...objectOrEmpty(local[field]) };
      for (const key of new Set([...Object.keys(upstream[field] || {}), ...Object.keys(local[field] || {})])) {
        values[key] = mergeCounter(upstream[field]?.[key], local[field]?.[key], base[field]?.[key]);
      }
      merged[field] = Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]]));
    }
  }
  if (upstream.tenantCount !== undefined || local.tenantCount !== undefined) {
    merged.tenantCount = Math.max(Number(upstream.tenantCount) || 0, Number(local.tenantCount) || 0);
  }
  if (upstream.expansionAttempts !== undefined || local.expansionAttempts !== undefined) {
    merged.expansionAttempts = mergeCounter(upstream.expansionAttempts, local.expansionAttempts, base.expansionAttempts);
  }
  if (upstream.discoveredAt || local.discoveredAt) merged.discoveredAt = oldest(upstream.discoveredAt, local.discoveredAt);
  if (upstream.lastExpandedAt || local.lastExpandedAt) merged.lastExpandedAt = newest(upstream.lastExpandedAt, local.lastExpandedAt);
  return merged;
}

function mergeTombstone(upstream, local) {
  if (isObject(upstream) && isObject(local)) {
    const merged = { ...clone(upstream), ...clone(local) };
    if (upstream.rejectedAt || local.rejectedAt) merged.rejectedAt = newest(upstream.rejectedAt, local.rejectedAt);
    return merged;
  }
  return clone(local);
}

function documentMeta(base, upstream, local, known) {
  const baseObject = objectOrEmpty(base);
  const upstreamObject = objectOrEmpty(upstream);
  const localObject = objectOrEmpty(local);
  const result = {};
  const keys = new Set([...Object.keys(baseObject), ...Object.keys(upstreamObject), ...Object.keys(localObject)]);
  for (const key of [...keys].sort()) {
    if (known.has(key)) continue;
    const value = mergeThreeWay(
      hasOwn(baseObject, key) ? baseObject[key] : MISSING,
      hasOwn(upstreamObject, key) ? upstreamObject[key] : MISSING,
      hasOwn(localObject, key) ? localObject[key] : MISSING,
      (upstreamValue, localValue, baseValue) => {
        if (Array.isArray(upstreamValue) && Array.isArray(localValue)) return unionArray(upstreamValue, localValue);
        if (isObject(upstreamValue) && isObject(localValue)) return mergeUnknownObject(baseValue, upstreamValue, localValue);
        return clone(localValue);
      },
    );
    if (value !== MISSING) result[key] = value;
  }
  return result;
}

function mergeCandidatesDocument(base, upstream, local) {
  const result = documentMeta(base, upstream, local, new Set(['version', 'updatedAt', 'candidates', 'rejectedTombstones']));
  result.version = Math.max(Number(base?.version) || 1, Number(upstream?.version) || 1, Number(local?.version) || 1);
  result.updatedAt = newest(base?.updatedAt, upstream?.updatedAt, local?.updatedAt);
  result.candidates = mergeMap(base?.candidates, upstream?.candidates, local?.candidates, mergeCandidate);
  result.rejectedTombstones = mergeMap(base?.rejectedTombstones, upstream?.rejectedTombstones, local?.rejectedTombstones, mergeTombstone);
  return result;
}

function mergePlatformsDocument(base, upstream, local) {
  const result = documentMeta(base, upstream, local, new Set(['version', 'updatedAt', 'platforms']));
  result.version = Math.max(Number(base?.version) || 1, Number(upstream?.version) || 1, Number(local?.version) || 1);
  result.updatedAt = newest(base?.updatedAt, upstream?.updatedAt, local?.updatedAt);
  result.platforms = mergeMap(base?.platforms, upstream?.platforms, local?.platforms, mergePlatform);
  return result;
}

function reportKey(report) {
  if (report && report.companyKey) return String(report.companyKey);
  return `__anonymous__:${JSON.stringify(canonical(report))}`;
}

function mergeValidationDocument(base, upstream, local) {
  const result = documentMeta(base, upstream, local, new Set(['generatedAt', 'tally', 'promotedVacancies', 'reports']));
  result.generatedAt = newest(base?.generatedAt, upstream?.generatedAt, local?.generatedAt);
  const toMap = (reports) => Object.fromEntries((Array.isArray(reports) ? reports : []).map((report) => [reportKey(report), report]));
  const reports = mergeMap(toMap(base?.reports), toMap(upstream?.reports), toMap(local?.reports), (_upstream, localValue) => clone(localValue));
  result.reports = Object.values(reports).sort((a, b) => reportKey(a).localeCompare(reportKey(b)));

  const tally = Object.fromEntries(VALIDATION_VERDICTS.map((verdict) => [verdict, 0]));
  for (const report of result.reports) {
    const verdict = String(report?.verdict || '');
    tally[verdict] = (tally[verdict] || 0) + 1;
  }
  result.tally = tally;
  result.promotedVacancies = result.reports
    .filter((report) => report?.verdict === 'good')
    .reduce((sum, report) => sum + (Number(report?.vacancyCount) || 0), 0);
  return result;
}

function channelEntryKey(entry) {
  if (!entry?.at) return JSON.stringify(canonical(entry));
  // `at` is normally unique, but two workers can observe the same
  // millisecond. Include the measured payload so a coincident timestamp does
  // not collapse two different channel observations.
  return JSON.stringify([
    entry.at,
    entry.collection,
    entry.totalPages,
    entry.pagesRead,
    entry.employers,
    entry.outage,
  ]);
}

function mergeChannelHealth(base, upstream, local) {
  const merged = mergeThreeWay(base, upstream, local, (upstreamValue, localValue) => {
    const byKey = new Map();
    for (const entry of [...(Array.isArray(upstreamValue) ? upstreamValue : []), ...(Array.isArray(localValue) ? localValue : [])]) {
      byKey.set(channelEntryKey(entry), clone(entry));
    }
    return [...byKey.values()]
      .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
      .slice(-CHANNEL_HISTORY_LIMIT);
  });
  return merged;
}

function mergeCrawlerDocument(base, upstream, local) {
  return mergeThreeWay(base, upstream, local, (upstreamValue, localValue) => {
    const merged = { ...clone(upstreamValue), ...clone(localValue) };
    for (const field of new Set([...Object.keys(upstreamValue), ...Object.keys(localValue)])) {
      if (isObject(upstreamValue[field]) && isObject(localValue[field])) {
        merged[field] = mergeUnknownObject({}, upstreamValue[field], localValue[field]);
      }
    }
    for (const field of ['seedUrls', 'allowedDetailOrigins', 'sampleTitles']) {
      if (Array.isArray(upstreamValue[field]) || Array.isArray(localValue[field])) {
        merged[field] = unionArray(upstreamValue[field], localValue[field]);
      }
    }
    if (upstreamValue.detailTemplate !== undefined || localValue.detailTemplate !== undefined) {
      const templates = unionArray(
        Array.isArray(upstreamValue.detailTemplate) ? upstreamValue.detailTemplate : [upstreamValue.detailTemplate],
        Array.isArray(localValue.detailTemplate) ? localValue.detailTemplate : [localValue.detailTemplate],
      ).filter(Boolean);
      merged.detailTemplate = templates.length <= 1 ? templates[0] : templates;
    }
    if (upstreamValue.sampleVacancyCount !== undefined || localValue.sampleVacancyCount !== undefined) {
      merged.sampleVacancyCount = Math.max(Number(upstreamValue.sampleVacancyCount) || 0, Number(localValue.sampleVacancyCount) || 0);
    }
    if (upstreamValue.detailEnrichment !== undefined || localValue.detailEnrichment !== undefined) {
      merged.detailEnrichment = Boolean(upstreamValue.detailEnrichment || localValue.detailEnrichment);
    }
    if (upstreamValue.learnedAt || localValue.learnedAt) merged.learnedAt = newest(upstreamValue.learnedAt, localValue.learnedAt);
    return merged;
  });
}

function ensureShape(target, value) {
  if (value === MISSING) return;
  if (target === PROSPECTOR_PATHS.candidates && (!isObject(value) || !isObject(value.candidates))) {
    throw new Error(`${target}: expected an object with a candidates map`);
  }
  if (target === PROSPECTOR_PATHS.platforms && (!isObject(value) || !isObject(value.platforms))) {
    throw new Error(`${target}: expected an object with a platforms map`);
  }
  if (target === PROSPECTOR_PATHS.validation && (!isObject(value) || !Array.isArray(value.reports))) {
    throw new Error(`${target}: expected an object with a reports array`);
  }
  if (target === PROSPECTOR_PATHS.webChannelHealth && !Array.isArray(value)) {
    throw new Error(`${target}: expected an array`);
  }
  if (CRAWLER_PATH.test(target) && !isObject(value)) {
    throw new Error(`${target}: expected a crawler object`);
  }
}

function mergePath(target, base, upstream, local) {
  if (!isSupportedProspectorPath(target)) throw new Error(`unsupported Prospector conflict: ${target}`);
  if (upstream === MISSING && local === MISSING) return MISSING;
  for (const value of [base, upstream, local]) ensureShape(target, value);
  if (target === PROSPECTOR_PATHS.candidates) return mergeCandidatesDocument(base, upstream, local);
  if (target === PROSPECTOR_PATHS.platforms) return mergePlatformsDocument(base, upstream, local);
  if (target === PROSPECTOR_PATHS.validation) return mergeValidationDocument(base, upstream, local);
  if (target === PROSPECTOR_PATHS.webChannelHealth) return mergeChannelHealth(base, upstream, local);
  if (CRAWLER_PATH.test(target)) return mergeCrawlerDocument(base, upstream, local);
  throw new Error(`unsupported Prospector conflict: ${target}`);
}

export function mergeProspectorPath(target, base, upstream, local) {
  return mergePath(target, base, upstream, local);
}

export function isSupportedProspectorPath(target) {
  return Object.values(PROSPECTOR_PATHS).includes(target) || CRAWLER_PATH.test(target);
}

function readStageOrMissing(stage, target) {
  try {
    return JSON.parse(gitShowStage(stage, target));
  } catch (error) {
    const stderr = String(error?.stderr || '');
    const message = String(error?.message || '');
    if (/does not exist in|exists on disk, but not in|is in the index, but not at stage|path .* does not exist/i.test(`${stderr}\n${message}`)) {
      return MISSING;
    }
    throw new Error(`cannot read rebase stage ${stage} for ${target}: ${message}`);
  }
}

function conflictedPaths() {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf-8' })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

function writeResolved(target, value) {
  if (value === MISSING) {
    execFileSync('git', ['rm', '--', target], { stdio: 'inherit' });
    return;
  }
  const output = path.resolve(process.cwd(), target);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  execFileSync('git', ['add', '--', target]);
}

export function resolveProspectorConflicts(paths = conflictedPaths()) {
  if (!paths.length) {
    return { paths: [], resolved: 0 };
  }
  const unsupported = paths.filter((target) => !isSupportedProspectorPath(target));
  if (unsupported.length) {
    throw new Error(`unexpected conflicted files: ${unsupported.join(', ')}`);
  }
  for (const target of paths) {
    const base = readStageOrMissing(1, target);
    const upstream = readStageOrMissing(2, target);
    const local = readStageOrMissing(3, target);
    writeResolved(target, mergePath(target, base, upstream, local));
  }
  execFileSync('git', ['add', '-A']);
  return { paths, resolved: paths.length };
}

export function main() {
  try {
    const result = resolveProspectorConflicts();
    if (!result.paths.length) {
      process.stdout.write('[resolve-prospector] no Prospector conflicts\n');
      return;
    }
    process.stdout.write(`[resolve-prospector] resolved ${result.resolved} generated path(s): ${result.paths.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`[resolve-prospector] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) main();
