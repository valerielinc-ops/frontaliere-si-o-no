#!/usr/bin/env node
/**
 * One-shot backfill: recover indexed-URL coverage for jobs that were dropped
 * by dedicated crawlers BEFORE the archival fix landed (PR #703).
 *
 * For each `data/jobs/by-crawler/<key>.json`, walk every commit that touched
 * the file. Any job (by `id`) that appeared in history but is no longer in
 * the current slice is "lost" — re-archive it into
 * `data/jobs/expired/by-crawler/<key>.json` using the most-recent historical
 * version of the job. Existing expired entries are preserved (merge by slug);
 * historical expired entries that later disappeared from the archive are also
 * restored, and legacy entries receive sourceIdentity/firstSeenAt metadata
 * from the active-slice history. The same history pass repairs active slice
 * entries whose crawler-generated firstSeenAt was reset by a fresh rewrite;
 * otherwise the next company-alert run would still treat a standing vacancy
 * as new.
 * the on-disk shape matches what `runStandardCrawlerPipeline` would write
 * going forward, so the build plugin renders the same JobExpiredView.
 *
 * Run once, commit the resulting data diff. Subsequent crawl runs handle
 * fresh drops automatically.
 *
 * Usage:
 *   node scripts/backfill-expired-from-history.mjs           # all crawlers
 *   node scripts/backfill-expired-from-history.mjs upd       # one crawler
 *   node scripts/backfill-expired-from-history.mjs upd galenica  # several
 *
 * Env:
 *   DRY_RUN=1   — log what would change, don't write
 *   MAX_COMMITS=N — cap history depth per file (default: unbounded)
 *   CRAWLER_KEYS=key-a,key-b — restrict one run to a bounded crawler batch
 *   HISTORY_SINCE=<git date> — walk only commits newer than this ("all" = unbounded)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { mergeUrlKey } from './lib/job-url-key.mjs';
import {
  collapseDuplicateRouteEntries,
  createSameIdentityArchiveIndex,
  localeRouteKeys,
  mergeExpiredRouteEvidence,
  mergeSourceIdentityHistory,
  normalizeExpiredEntryTitles,
  normalizeExpiredAtEntries,
} from './lib/expired-jobs-archive.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import {
  listExpiredSliceFiles,
  readExpiredSliceShards,
  writeExpiredSliceRows,
} from './lib/expired-slice-store.mjs';
import { historySinceArgs } from './ci/prefetch-history-blobs.mjs';
import { compareExpiredAt } from './lib/compare-expired-at.mjs';
import { archiveRecordSourceIdentities, buildStableJobIdentity } from './lib/job-identity.mjs';
import { ambiguousJobIdentities, createFirstSeenMetadataIndex } from './lib/first-seen-history.mjs';
import { isHeldFromPublication } from './lib/translation-publication-hold.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_COMMITS = process.env.MAX_COMMITS ? Number(process.env.MAX_COMMITS) : 0;

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const envKeys = String(process.env.CRAWLER_KEYS || '')
  .split(/[\s,]+/u)
  .map((key) => key.trim())
  .filter(Boolean);
const onlyKeys = new Set([...argv, ...envKeys]);

function git(args, { quiet = false, cwd = ROOT } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    ...(quiet ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}),
  });
}

function readJobsFromSlice(blob) {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  return [];
}

function parseSlice(blob) {
  try {
    return JSON.parse(blob);
  } catch {
    return null;
  }
}

function buildExpiredEntry(job) {
  const sourceIdentity = job?.sourceIdentity || (job?.url ? buildStableJobIdentity(job) : '');
  const entry = {
    id: job?.id || job?.externalId || job?.jobId || undefined,
    slug: job.slug,
    title: job.title || '',
    titleByLocale: { ...(job.titleByLocale || {}) },
    company: job.company || '',
    companyKey: job.companyKey || '',
    location: job.location || '',
    canton: job.canton || undefined,
    addressLocality: job.addressLocality || '',
    descriptionByLocale: job.descriptionByLocale || {},
    slugByLocale: job.slugByLocale || {},
    sector: job.sector || '',
    expiredAt: pickExpiredAt(job),
    previousSlugs:
      Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
        ? [...job.previousSlugs]
        : undefined,
    previousSlugsByLocale:
      job.previousSlugsByLocale &&
      typeof job.previousSlugsByLocale === 'object' &&
      Object.keys(job.previousSlugsByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugsByLocale))
        : undefined,
    previousSlugCantonByLocale:
      job.previousSlugCantonByLocale &&
      typeof job.previousSlugCantonByLocale === 'object' &&
      Object.keys(job.previousSlugCantonByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugCantonByLocale))
        : undefined,
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || job.currency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
    sourceIdentityHistory:
      Array.isArray(job.sourceIdentityHistory) && job.sourceIdentityHistory.length > 0
        ? JSON.parse(JSON.stringify(job.sourceIdentityHistory))
        : undefined,
  };
  normalizeExpiredEntryTitles(entry);
  if (!entry.postalCode) delete entry.postalCode;
  if (!entry.streetAddress) delete entry.streetAddress;
  if (!entry.salaryMin) delete entry.salaryMin;
  if (!entry.salaryMax) delete entry.salaryMax;
  if (!entry.canton) delete entry.canton;
  if (!entry.id) delete entry.id;
  if (sourceIdentity) entry.sourceIdentity = sourceIdentity;
  if (job.firstSeenAt) entry.firstSeenAt = job.firstSeenAt;
  if (!entry.sourceIdentityHistory) delete entry.sourceIdentityHistory;
  return entry;
}

/**
 * Pick an expiredAt timestamp from job metadata. Prefer the most recent
 * timestamp we have (crawledAt is when we last saw it alive — close enough
 * to "expired right after" without lying about the actual upstream removal
 * time, which we don't have for historical jobs).
 */
function pickExpiredAt(job) {
  const ca = job.crawledAt && !Number.isNaN(new Date(job.crawledAt).getTime()) ? job.crawledAt : null;
  const dp = job.datePosted && !Number.isNaN(new Date(job.datePosted).getTime()) ? job.datePosted : null;
  return ca || dp || new Date().toISOString();
}

// Non escludeva nulla oltre l'estensione: stesso difetto di
// repair-job-locales.mjs. Il filtro `onlyKeys` resta suo, il predicato no.
function listSliceFiles() {
  return listSliceFileNames(BY_CRAWLER_DIR)
    .filter((f) => (onlyKeys.size === 0 ? true : onlyKeys.has(path.basename(f, '.json'))));
}

function listHistoryCommits(relPath, cwd) {
  try {
    return git(['log', '--all', '--follow', ...historySinceArgs(), '--format=%ct %H', '--', relPath], { cwd })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [timestamp, sha] = line.split(/\s+/);
        return { sha, timestamp: Number(timestamp) || 0 };
      })
      .filter(({ sha }) => sha);
  } catch (err) {
    console.error(`⚠️  git log failed for ${relPath}: ${err.message}`);
    return [];
  }
}

/**
 * Whether a `url:` source identity carries a posting-specific token in its last
 * path segment or its query. A token only in an ancestor segment names a board
 * or a tenant. Identities that are not URLs are declared per posting.
 */
function namesOnePosting(identity) {
  if (!identity.startsWith('url:')) return true;
  const url = identity.slice(4).toLowerCase().replace(/\/+$/, '');
  const key = mergeUrlKey(url);
  // `url:` = no token; `req:<host>:num:…` = the vendor rules' tenant fallback.
  if (key.startsWith('url:') || /:(?:num|hex|url):/.test(key)) return false;
  if (key.startsWith('req:')) return true;
  const token = key.slice(key.indexOf(':') + 1);
  const [beforeQuery, ...query] = url.split('#')[0].split('?');
  return `${beforeQuery.split('/').pop()}?${query.join('?')}`.includes(token);
}

/**
 * Collect the identities that name a page, not a posting (a listing URL). Such
 * an identity never proves on its own that a recovered payload is already
 * archived. Three signals:
 *   - two postings under it in one version of the slice;
 *   - two `#fragment`s under it over history;
 *   - for a URL without a posting token, sightings anywhere in history or in the
 *     archive that no chain of shared ids or slugs connects: successive
 *     postings of a one-vacancy listing are never open in the same version.
 * A URL that names one posting needs no link, so a rename that also changes the
 * id is still recognised.
 */
function createListingIdentityCollector() {
  const ambiguous = new Set();
  const fragmentByIdentity = new Map();
  const groupsByIdentity = new Map(); // identity -> disjoint Set<id/slug key>[]
  const seenSightings = new Set();

  const addSighting = (identity, record) => {
    if (!identity || namesOnePosting(identity)) return;
    const slugs = [
      record.slug,
      ...Object.values(record.slugByLocale || {}),
      ...(record.previousSlugs || []),
      ...Object.values(record.previousSlugsByLocale || {}).flat(),
    ].filter(Boolean);
    const keys = [
      ...(record.id ? [`id:${record.id}`] : []),
      ...slugs.map((slug) => `slug:${slug}`),
    ];
    if (keys.length === 0) return;
    // Most versions repeat the previous one.
    const signature = JSON.stringify([identity, keys]);
    if (seenSightings.has(signature)) return;
    seenSightings.add(signature);
    const merged = new Set(keys);
    const apart = [];
    for (const group of groupsByIdentity.get(identity) || []) {
      if (keys.some((key) => group.has(key))) for (const key of group) merged.add(key);
      else apart.push(group);
    }
    groupsByIdentity.set(identity, [...apart, merged]);
  };

  return {
    isAmbiguous: (identity) => ambiguous.has(identity)
      || (groupsByIdentity.get(identity)?.length || 0) > 1,
    addArchiveRow(row) {
      addSighting(row?.sourceIdentity, row || {});
    },
    addVersion(jobs) {
      for (const identity of ambiguousJobIdentities(jobs)) ambiguous.add(identity);
      for (const job of jobs) {
        const url = String(job?.url || '');
        const hashAt = url.indexOf('#');
        const fragment = hashAt < 0 ? null : url.slice(hashAt);
        for (const identity of new Set([job?.sourceIdentity, buildStableJobIdentity(job || {})])) {
          if (!identity) continue;
          addSighting(identity, job || {});
          if (fragment === null) continue;
          const seen = fragmentByIdentity.get(identity);
          if (seen === undefined) fragmentByIdentity.set(identity, fragment);
          else if (seen !== fragment) ambiguous.add(identity);
        }
      }
    },
  };
}

/**
 * Backfill one crawler's expired archive. The directories are parameters so a
 * test can run the real history walk inside a throwaway git repository.
 */
export function processSlice(sliceFile, {
  rootDir = ROOT,
  byCrawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler'),
  expiredDir = path.join(rootDir, 'data', 'jobs', 'expired', 'by-crawler'),
} = {}) {
  const crawlerKey = path.basename(sliceFile, '.json');
  const currentRel = `data/jobs/by-crawler/${sliceFile}`;
  // The archive is the monolith plus its `<key>.shard-NNN.json` files
  // (scripts/lib/expired-slice-store.mjs): walk the history of each of them.
  const expiredRels = [
    `data/jobs/expired/by-crawler/${sliceFile}`,
    ...listExpiredSliceFiles(crawlerKey, { dir: expiredDir })
      .filter((file) => file.index > 0)
      .map((file) => `data/jobs/expired/by-crawler/${file.name}`),
  ];
  const currentPath = path.join(byCrawlerDir, sliceFile);
  if (!fs.existsSync(currentPath)) return null;

  const currentBlob = fs.readFileSync(currentPath, 'utf-8');
  const currentPayload = parseSlice(currentBlob);
  const currentJobs = readJobsFromSlice(currentBlob);
  const currentIds = new Set(currentJobs.map((j) => j.id).filter(Boolean));
  const currentSlugs = new Set(currentJobs.map((j) => j.slug).filter(Boolean));

  // Walk commits that touched this file. --follow handles renames; the
  // tradeoff is git ignores merge commits' textual diff, which is fine —
  // squash-merged commits still show, and we cover them via the per-commit
  // blob read below.
  // --all is required here: the 2026-05-27 history rewrite (PR #645)
  // stranded the pre-rewrite branch tips. Those reachable-only-via-reflog
  // commits hold the very job data we're trying to recover — without
  // --all the walk only sees the ~5 post-rewrite commits. The expired path is
  // included as well: later housekeeping can collapse or remove an archive
  // entry even though its source posting remains recoverable in Git.
  const commitBySha = new Map();
  for (const commit of [
    ...listHistoryCommits(currentRel, rootDir),
    ...expiredRels.flatMap((expiredRel) => listHistoryCommits(expiredRel, rootDir)),
  ]) {
    const prior = commitBySha.get(commit.sha);
    if (!prior || commit.timestamp > prior.timestamp) commitBySha.set(commit.sha, commit);
  }
  const commits = [...commitBySha.values()]
    .sort((a, b) => b.timestamp - a.timestamp || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0))
    .map(({ sha }) => sha);
  if (commits.length === 0) return null;
  const sliceCommits = MAX_COMMITS > 0 ? commits.slice(0, MAX_COMMITS) : commits;

  // Walk commits NEWEST → OLDEST (git log default order). First time we see
  // a lost id wins — that's the most recent version of the job. The compact
  // metadata index sees every historical version, including jobs that are
  // active today, so legacy archive entries can recover firstSeenAt too.
  const lostById = new Map();
  // Ids whose most recent historical version was held out of publication for
  // translation: never public, so never archived (no expired soft-landing).
  const heldLostIds = new Set();
  const historicalExpiredBySlug = new Map();
  const historicalIndex = createFirstSeenMetadataIndex();
  const listingIdentities = createListingIdentityCollector();
  listingIdentities.addVersion(currentJobs);
  let previousActiveBlob = null;
  for (const sha of sliceCommits) {
    let blob = null;
    try {
      blob = git(['show', `${sha}:${currentRel}`], { quiet: true, cwd: rootDir });
    } catch {
      // File didn't exist at that commit (rename predecessor) — skip
    }
    if (blob != null) {
      const jobs = readJobsFromSlice(blob);
      // Most commits touch only the archive: do not re-scan an unchanged slice.
      if (blob !== previousActiveBlob) listingIdentities.addVersion(jobs);
      previousActiveBlob = blob;
      for (const job of jobs) {
        historicalIndex.add(job);
        if (!job?.id || !job?.slug) continue;
        if (currentIds.has(job.id)) continue;
        if (currentSlugs.has(job.slug)) continue; // same slug, different id — treat as kept
        if (lostById.has(job.id) || heldLostIds.has(job.id)) continue;
        if (isHeldFromPublication(job)) {
          heldLostIds.add(job.id);
          continue;
        }
        lostById.set(job.id, job);
      }
    }

    for (const expiredRel of expiredRels) {
      let expiredBlob = null;
      try {
        expiredBlob = git(['show', `${sha}:${expiredRel}`], { quiet: true, cwd: rootDir });
      } catch {
        // The per-crawler archive (or this shard) did not exist at that commit.
      }
      if (expiredBlob == null) continue;
      for (const entry of readJobsFromSlice(expiredBlob)) {
        if (!entry?.slug) continue;
        const previous = historicalExpiredBySlug.get(entry.slug);
        if (!previous || compareExpiredAt(previous.expiredAt, entry.expiredAt) < 0) {
          historicalExpiredBySlug.set(entry.slug, entry);
        }
      }
    }
  }

  // No early return on an empty `lostById`: the existing slice still gets its
  // ingress repair below, which is the whole point of reading it.

  // Read any existing expired slice, merge by slug. We keep entries whose
  // expiredAt is newer (the existing slice may already have entries from
  // PR #703 or earlier cleanup-jobs runs that we shouldn't downgrade).
  // Monolith + shards through the store. An unreadable file fails the run:
  // starting fresh would rewrite it with only the recovered rows.
  const existingShards = readExpiredSliceShards(crawlerKey, { dir: expiredDir });
  const existing = existingShards.flatMap((shard) => shard.rows);

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej?.slug) bySlug.set(ej.slug, ej);
  }

  // Every sighting is in before the first identity lookup. Archive rows count
  // too: a bounded history may know a departed posting only from them.
  for (const row of [...existing, ...historicalExpiredBySlug.values()]) {
    listingIdentities.addArchiveRow(row);
  }

  // What the archive serves before this run: none of it may disappear below.
  const routesServedBefore = existing.flatMap((entry) => [...localeRouteKeys(entry || {})]);
  const indexArchive = () => createSameIdentityArchiveIndex([...bySlug.values()], {
    activeJobs: currentJobs,
    isAmbiguousIdentity: listingIdentities.isAmbiguous,
  });

  /**
   * Fold one recovered payload (historical archive row or lost active job) into
   * the archive. Both merge directions carry the loser's routes: the newer
   * payload wins the content, never the right to forget a served URL. Work done
   * on an already-archived posting is counted in `recoveredFromHistory`.
   *
   * @returns {boolean} whether `entry` became a new record
   */
  const recover = (entry, identityIndex) => {
    const previous = bySlug.get(entry.slug);
    // The slug alone is not the posting. Unless its holder declares this source
    // posting, look for the record that does (a rename or a collision alias).
    if (!previous || !archiveRecordSourceIdentities(previous).has(entry.sourceIdentity)) {
      const absorbed = identityIndex.absorb(entry);
      if (absorbed) {
        if (absorbed.changed) recoveredFromHistory++;
        return false;
      }
    }
    if (!previous) {
      bySlug.set(entry.slug, entry);
      identityIndex.add(entry);
      return true;
    }
    const source = `backfill-expired-from-history/${sliceFile}`;
    if (compareExpiredAt(previous.expiredAt, entry.expiredAt) < 0) {
      let routeCapRefused = false;
      mergeExpiredRouteEvidence(
        entry,
        previous,
        source,
        { onLegacyRouteCapRefusal: () => { routeCapRefused = true; } },
      );
      // The existing record remains the proven owner of its older routes;
      // replacing it would turn a cap refusal into an archive 404.
      if (routeCapRefused) return false;
      identityIndex.remove(previous);
      mergeSourceIdentityHistory(entry, previous);
      bySlug.set(entry.slug, entry);
      identityIndex.add(entry);
      recoveredFromHistory++;
      return false;
    }
    identityIndex.update(previous, () => {
      const routeEvidenceChanged = mergeExpiredRouteEvidence(previous, entry, source);
      const sourceIdentityChanged = mergeSourceIdentityHistory(previous, entry);
      if (routeEvidenceChanged || sourceIdentityChanged) recoveredFromHistory++;
    });
    return false;
  };

  // Newest first: of several recovered payloads of one posting, the latest
  // becomes the record and the older ones only add what it does not serve.
  const newestFirst = (a, b) => compareExpiredAt(b.expiredAt, a.expiredAt);
  let recoveredFromHistory = 0;
  const historicalIdentityIndex = indexArchive();
  // Rows whose slug the archive still holds go first, so that their routes count
  // as served when the vanished slugs are examined.
  const historicalEntries = [...historicalExpiredBySlug.values()].sort(newestFirst);
  for (const entry of [
    ...historicalEntries.filter((candidate) => bySlug.has(candidate.slug)),
    ...historicalEntries.filter((candidate) => !bySlug.has(candidate.slug)),
  ]) {
    if (recover(entry, historicalIdentityIndex)) recoveredFromHistory++;
  }

  // Older archives predate sourceIdentity/firstSeenAt. Enrich them from the
  // complete Git history before merging newly recovered drops. This also
  // handles a vacancy that is active again today: it need not be absent from
  // the current slice to have a durable first-seen date in the archive.
  const metadata = historicalIndex.enrich([...bySlug.values()]);
  const activeMetadata = historicalIndex.enrichActive(currentJobs);

  if (activeMetadata.enrichedEntries > 0 && !DRY_RUN) {
    const nextPayload = Array.isArray(currentPayload)
      ? currentJobs
      : { ...(currentPayload || {}), jobs: currentJobs };
    writeJsonAtomic(currentPath, nextPayload);
  }

  let added = 0;
  // Indexed after the enrichment, which gives legacy rows their sourceIdentity.
  const lostIdentityIndex = indexArchive();
  for (const entry of [...lostById.values()].map(buildExpiredEntry).sort(newestFirst)) {
    if (recover(entry, lostIdentityIndex)) added++;
  }

  // Repair AFTER the historical merge, never before: stamping the run
  // timestamp on a legacy entry first would make it the MOST recent one, so
  // the refresh above would never fire and the degraded payload would keep the
  // soft landing — the comparator inverts, instead of the entry losing as it
  // does with an unorderable value.
  const repaired = normalizeExpiredAtEntries(
    [...bySlug.values()],
    { source: `backfill-expired-from-history/${sliceFile}` },
  );

  // A repair adds no slug, so `added` stays put: write it out anyway,
  // otherwise the unorderable value survives on disk until an unrelated add.
  if (
    added === 0
    && recoveredFromHistory === 0
    && repaired === 0
    && metadata.enrichedEntries === 0
    && activeMetadata.enrichedEntries === 0
  ) {
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostById.size,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: 0,
    };
  }

  // Same slug-keyed dedup as the pipeline writers: `bySlug` keeps the CURRENT
  // slug, so two entries whose histories overlap on a locale route both
  // survive it. Collapse by route before writing.
  const archived = collapseDuplicateRouteEntries(
    [...bySlug.values()].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)),
    { source: 'backfill-expired-from-history' },
  ).entries;
  // Last boundary before the write: whatever step caused it, a route the
  // archive served on entry and nobody serves now would become a 404. Keep the
  // archive on disk untouched and say which routes were at stake.
  const servedAfter = new Set([...archived, ...currentJobs].flatMap((entry) => [...localeRouteKeys(entry)]));
  const droppedRoutes = [...new Set(routesServedBefore)].filter((routeKey) => !servedAfter.has(routeKey));
  if (droppedRoutes.length > 0) {
    console.error(
      `::error::backfill-expired-from-history/${sliceFile}: refusing to write the archive, `
      + `${droppedRoutes.length} served route(s) would be lost (${droppedRoutes.slice(0, 10).join(', ')})`,
    );
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostById.size,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: activeMetadata.enrichedEntries,
      refusedRoutes: droppedRoutes.length,
    };
  }
  if (!DRY_RUN) {
    // Shard placement + the 90 MB ceiling on every file.
    writeExpiredSliceRows(crawlerKey, archived, { dir: expiredDir, existing: existingShards });
  }
  return {
    crawlerKey,
    scannedCommits: sliceCommits.length,
    lost: lostById.size,
    added: added + recoveredFromHistory,
    recovered: recoveredFromHistory,
    enriched: metadata.enrichedEntries,
    activeEnriched: activeMetadata.enrichedEntries,
  };
}

function main() {
  if (!fs.existsSync(BY_CRAWLER_DIR)) {
    console.error(`❌ ${BY_CRAWLER_DIR} not found`);
    process.exit(1);
  }
  const files = listSliceFiles();
  if (files.length === 0) {
    console.log('ℹ️  No slice files matched.');
    return;
  }
  console.log(`🧮 Backfilling expired slices from history${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   crawlers: ${files.length}, history cap: ${MAX_COMMITS || 'unbounded'}`);

  const summary = {
    crawlers: 0,
    withDrops: 0,
    withMetadata: 0,
    addedTotal: 0,
    recoveredTotal: 0,
    enrichedTotal: 0,
    activeEnrichedTotal: 0,
    lostTotal: 0,
    scannedTotal: 0,
    refusedArchives: 0,
  };
  for (const file of files) {
    const result = processSlice(file);
    if (!result) continue;
    summary.crawlers++;
    summary.scannedTotal += result.scannedCommits;
    if (result.lost > 0) summary.withDrops++;
    summary.lostTotal += result.lost;
    if (result.refusedRoutes > 0) summary.refusedArchives++;
    summary.addedTotal += result.added;
    summary.recoveredTotal += result.recovered;
    summary.enrichedTotal += result.enriched;
    summary.activeEnrichedTotal += result.activeEnriched || 0;
    if (result.enriched > 0 || result.activeEnriched > 0) summary.withMetadata++;
    if (result.lost > 0 || result.enriched > 0 || result.activeEnriched > 0 || process.env.VERBOSE === '1') {
      console.log(
        `  ${result.crawlerKey}: scanned=${result.scannedCommits} lost=${result.lost} added=${result.added} recovered=${result.recovered} metadata=${result.enriched} activeMetadata=${result.activeEnriched || 0}`,
      );
    }
  }
  console.log('');
  console.log(`✅ Done. Crawlers: ${summary.crawlers}, with drops: ${summary.withDrops}`);
  console.log(`   Total lost: ${summary.lostTotal}, newly archived: ${summary.addedTotal}`);
  console.log(`   Recovered historical archive entries: ${summary.recoveredTotal}`);
  console.log(`   Archives enriched: ${summary.enrichedTotal} entries across ${summary.withMetadata} crawlers`);
  console.log(`   Active slices enriched: ${summary.activeEnrichedTotal} jobs`);
  console.log(`   Total commits scanned: ${summary.scannedTotal}`);
  console.log(`   Archives left untouched (route loss refused): ${summary.refusedArchives}`);
}

// Importing the module (tests) must not start a repository-wide backfill.
if (isInvokedDirectly(import.meta.url)) main();
