/**
 * Apply the crawler ownership guard to a slice immediately before it enters a
 * private commit tree.
 *
 * The normal write-time guard reads the checkout's slices. Crawler groups do
 * not share a checkout across repositories, though, so a second group can
 * start from the same base and publish a new claim after the first group has
 * already moved main. This helper compares only claims that were not present
 * in the writer's base snapshot with the current remote ownership snapshot.
 * Existing claims are deliberately preserved: removing an already indexed
 * duplicate is a slug/history migration, not a write-time drop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * @param {string} crawlerKey
 * @param {unknown} payload
 * @param {unknown} basePayload
 * @param {{ urlsByKey?: Map<string, Set<string>> }} ownership
 * @returns {{ payload: unknown, dropped: {url: string, owner: string}[] }}
 */
export function filterNewForeignClaims(crawlerKey, payload, basePayload, ownership) {
  const jobs = jobsFromPayload(payload, 'local slice');
  const baseJobs = basePayload === undefined ? [] : jobsFromPayload(basePayload, 'base slice');
  const baseUrls = new Set(
    baseJobs.map((job) => normalizeJobUrl(job?.url || '')).filter(Boolean),
  );

  // A base URL is already published by this crawler from the writer's point
  // of view. Keep it even if the remote tree also contains another claimant:
  // the existing duplicate needs slug/previousSlugs adjudication.
  const newJobs = jobs.filter((job) => {
    const url = normalizeJobUrl(job?.url || '');
    return !url || !baseUrls.has(url);
  });
  const guarded = dropForeignOwnedVacancies(crawlerKey, newJobs, ownership);
  const droppedUrls = new Set(guarded.dropped.map(({ url }) => url));
  const filtered = jobs.filter((job) => !droppedUrls.has(normalizeJobUrl(job?.url || '')));

  return { payload: withJobs(payload, filtered), dropped: guarded.dropped };
}

function main() {
  const [, , crawlerKey, basePath, localPath, ownershipRoot, outputPath] = process.argv;
  if (!crawlerKey || !localPath || !ownershipRoot || !outputPath) {
    throw new Error(
      'usage: crawler-commit-ownership.mjs <crawler-key> <base-json|-> <local-json> <ownership-root> <output-json>',
    );
  }

  const localPayload = readJson(localPath);
  const basePayload = readJson(basePath, { missing: true });
  const ownership = loadSourceHostOwnership(ownershipRoot, { urls: true });
  const { payload, dropped } = filterNewForeignClaims(
    crawlerKey,
    localPayload,
    basePayload,
    ownership,
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (dropped.length === 0) {
    // Preserve the exact blob when the guard is a no-op. This avoids turning a
    // formatting-only difference into a synthetic data change.
    fs.copyFileSync(localPath, outputPath);
  } else {
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(JSON.stringify({ dropped }));
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
