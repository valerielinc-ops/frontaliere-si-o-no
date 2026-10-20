import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Apply the crawler ownership guard to a slice immediately before it enters a
 * private commit tree.
 *
 * The normal write-time guard reads the checkout's slices. Crawler groups do
 * not share a checkout across repositories, though, so a second group can
 * start from the same base and publish a new claim after the first group has
 * already moved main. This helper compares new URL claims and proven
 * cross-job history transfers with the current remote ownership snapshot.
 * Existing URL claims are deliberately preserved: removing an already indexed
 * duplicate is a slug/history migration, not a write-time drop. A historical
 * route is removed only when the current remote slice dropped it and exactly
 * one other crawler still owns it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { removePreviousSlugRoutes } from './slug-history-journal.mjs';

import {
  dropForeignOwnedVacancies,
  loadSourceHostOwnership,
  normalizeJobUrl,
} from './crawler-source-hosts.mjs';

function readJson(filePath, { missing = false } = {}) {
  if (!filePath || filePath === '-') return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (missing && error?.code === 'ENOENT') return undefined;
    throw new Error(`cannot read JSON ${filePath}: ${error.message}`);
  }
}

function jobsFromPayload(payload, label) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.jobs)) return payload.jobs;
  throw new Error(`${label} must be a JSON array or an object with a jobs array`);
}

function withJobs(payload, jobs) {
  return Array.isArray(payload) ? jobs : { ...payload, jobs };
}

function routeValues(job, { historicalOnly = false, activeOnly = false } = {}) {
  let values;
  if (historicalOnly) {
    values = [
      ...(Array.isArray(job?.previousSlugs) ? job.previousSlugs : []),
      ...Object.values(job?.previousSlugsByLocale || {})
        .flatMap((slugs) => Array.isArray(slugs) ? slugs : []),
    ];
  } else if (activeOnly) {
    values = [job?.slug, ...Object.values(job?.slugByLocale || {})];
  } else {
    values = [
      job?.slug,
      ...Object.values(job?.slugByLocale || {}),
      ...(Array.isArray(job?.previousSlugs) ? job.previousSlugs : []),
      ...Object.values(job?.previousSlugsByLocale || {})
        .flatMap((slugs) => Array.isArray(slugs) ? slugs : []),
    ];
  }
  return values.map((value) => String(value ?? '').trim()).filter(Boolean);
}

function routesFromPayload(payload, { historicalOnly = false } = {}) {
  const routes = new Set();
  for (const job of jobsFromPayload(payload, 'slice')) {
    for (const route of routeValues(job, { historicalOnly })) routes.add(route);
  }
  return routes;
}

/**
 * A stale writer can carry a previous-slug route that the current remote slice
 * has deliberately removed during fleet decontamination. The append-only
 * merge must not put it back when the complete remote ownership view proves
 * that exactly one other crawler now serves that route.
 *
 * Ambiguous routes, routes absent from the ownership view, and routes still
 * present in this slice are left untouched. Unknown is not permission to drop
 * an indexed redirect.
 *
 * @param {string} crawlerKey
 * @param {unknown} payload
 * @param {unknown} remotePayload
 * @param {{ routeOwners?: Map<string, Set<string>> }} ownership
 * @returns {{ jobs: unknown[], dropped: {slug: string, owner: string}[] }}
 */
export function dropForeignOwnedHistoricalSlugs(crawlerKey, payload, remotePayload, ownership) {
  const mine = String(crawlerKey || '').toLowerCase();
  const routeOwners = ownership?.routeOwners;
  if (!mine || !(routeOwners instanceof Map) || remotePayload === undefined) {
    return { jobs: jobsFromPayload(payload, 'local slice'), dropped: [] };
  }

  const remoteRoutes = routesFromPayload(remotePayload);
  const jobs = jobsFromPayload(payload, 'local slice');
  const dropped = [];
  const filtered = jobs.map((job) => {
    if (!job || typeof job !== 'object') return job;
    const activeRoutes = new Set(routeValues(job, { activeOnly: true }));
    const historical = new Set(routeValues(job, { historicalOnly: true }));
    const foreign = new Map();
    for (const route of historical) {
      if (remoteRoutes.has(route)) continue;
      const owners = routeOwners.get(route);
      if (!(owners instanceof Set) || owners.size !== 1) continue;
      const [owner] = owners;
      if (!owner || owner === mine || activeRoutes.has(route)) continue;
      foreign.set(route, owner);
    }
    if (foreign.size === 0) return job;

    const next = { ...job };
    removePreviousSlugRoutes(next, foreign, {
      source: 'crawler-commit-ownership.dropForeignOwnedHistoricalSlugs',
    });
    for (const [slug, owner] of foreign) dropped.push({ slug, owner });
    return next;
  });
  return { jobs: filtered, dropped };
}

function historicalRoutesMissingFromRemote(payload, remotePayload) {
  if (remotePayload === undefined) return [];
  const remoteRoutes = routesFromPayload(remotePayload);
  const candidates = new Set();
  for (const job of jobsFromPayload(payload, 'local slice')) {
    for (const route of routeValues(job, { historicalOnly: true })) {
      if (!remoteRoutes.has(route)) candidates.add(route);
    }
  }
  return [...candidates];
}

/**
 * @param {string} crawlerKey
 * @param {unknown} payload
 * @param {unknown} basePayload
 * @param {{ urlsByKey?: Map<string, Set<string>>, routeOwners?: Map<string, Set<string>> }} ownership
 * @param {unknown} [remotePayload]
 * @returns {{ payload: unknown, dropped: {url: string, owner: string}[], droppedHistorical: {slug: string, owner: string}[] }}
 */
/**
 * Jobs of `payload` that the writer's base snapshot did not already publish.
 * A base URL is already published by this crawler from the writer's point of
 * view. Keep it even if the remote tree also contains another claimant: the
 * existing duplicate needs slug/previousSlugs adjudication.
 */
export function newClaims(payload, basePayload) {
  const jobs = jobsFromPayload(payload, 'local slice');
  const baseJobs = basePayload === undefined ? [] : jobsFromPayload(basePayload, 'base slice');
  const baseUrls = new Set(
    baseJobs.map((job) => normalizeJobUrl(job?.url || '')).filter(Boolean),
  );
  return jobs.filter((job) => {
    const url = normalizeJobUrl(job?.url || '');
    return !url || !baseUrls.has(url);
  });
}

export function filterNewForeignClaims(crawlerKey, payload, basePayload, ownership, remotePayload) {
  const jobs = jobsFromPayload(payload, 'local slice');
  const newJobs = newClaims(payload, basePayload);
  const guarded = dropForeignOwnedVacancies(crawlerKey, newJobs, ownership);
  const droppedUrls = new Set(guarded.dropped.map(({ url }) => url));
  const filtered = jobs.filter((job) => !droppedUrls.has(normalizeJobUrl(job?.url || '')));
  const historical = dropForeignOwnedHistoricalSlugs(
    crawlerKey,
    withJobs(payload, filtered),
    remotePayload,
    ownership,
  );

  return {
    payload: withJobs(payload, historical.jobs),
    dropped: guarded.dropped,
    droppedHistorical: historical.dropped,
  };
}

function main() {
  const [, , crawlerKey, basePath, localPath, ownershipRoot, outputPath, verdictPath, remotePath] = process.argv;
  if (!crawlerKey || !localPath || !ownershipRoot || !outputPath) {
    throw new Error(
      'usage: crawler-commit-ownership.mjs <crawler-key> <base-json|-> <local-json> <ownership-root> <output-json> [verdict-path] [remote-json]',
    );
  }

  const localPayload = readJson(localPath);
  const basePayload = readJson(basePath, { missing: true });
  const remotePayload = readJson(remotePath, { missing: true });
  const hasNewClaims = newClaims(localPayload, basePayload).length > 0;
  const hasHistoricalCandidates = historicalRoutesMissingFromRemote(localPayload, remotePayload).length > 0;
  // No new URL claim and no route removed from this slice means nothing the
  // remote ownership view could refuse. A translate-pending commit therefore
  // still skips the scan of every remote slice (~360 MB of JSON), while a
  // stale decontamination candidate gets the same full-fleet proof as a new
  // vacancy claim.
  // The optional verdict file tells the caller whether the result depended on
  // the ownership view (`consulted`) or only on base+local (`skipped`).
  if (!hasNewClaims && !hasHistoricalCandidates) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(localPath, outputPath);
    if (verdictPath) fs.writeFileSync(verdictPath, 'skipped\n', 'utf8');
    process.stdout.write(JSON.stringify({ dropped: [] }));
    return;
  }
  if (verdictPath) fs.writeFileSync(verdictPath, 'consulted\n', 'utf8');
  const ownership = loadSourceHostOwnership(ownershipRoot, { urls: true, routes: true });
  const { payload, dropped, droppedHistorical } = filterNewForeignClaims(
    crawlerKey,
    localPayload,
    basePayload,
    ownership,
    remotePayload,
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (dropped.length === 0 && droppedHistorical.length === 0) {
    // Preserve the exact blob when the guard is a no-op. This avoids turning a
    // formatting-only difference into a synthetic data change.
    fs.copyFileSync(localPath, outputPath);
  } else {
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(JSON.stringify({
    dropped,
    ...(droppedHistorical.length > 0 ? { droppedHistorical } : {}),
  }));
}

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) main();
