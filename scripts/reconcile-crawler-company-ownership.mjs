#!/usr/bin/env node
/**
 * One-time, idempotent reconciliation for issues #6759 and #6797.
 *
 * The live-source fixes prevent the 18 overlaps from returning. This script
 * repairs the committed slices without losing indexed routes: when two jobs
 * collapse, every active/historical slug from the removed identity is added
 * to the surviving job's previousSlugs contract. Alias-only jobs are rehomed
 * under the canonical company so their active route remains served.
 *
 * Usage:
 *   node scripts/reconcile-crawler-company-ownership.mjs          # dry-run
 *   node scripts/reconcile-crawler-company-ownership.mjs --apply  # write
 *   node scripts/reconcile-crawler-company-ownership.mjs --expired-sweep --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStableJobId, hasUsableJobId } from './lib/job-match-key.mjs';
import { normalizeJobUrl } from './lib/crawler-source-hosts.mjs';
import {
  dedicatedFribourgOwner,
  dedicatedMigrosOwner,
  dedicatedPostOwner,
  isCantonTicinoOscPosting,
} from './lib/crawler-company-ownership.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { compareExpiredAt } from './lib/compare-expired-at.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
// Route identity and history transfer now live with the archive WRITERS, which
// need the same two primitives to stop emitting duplicate routes in the first
// place. Re-exported here because this module is their historical home and the
// callers (tests included) import them from it.
import {
  collapseDuplicateRouteEntries,
  localeRouteKeys,
  normalizeExpiredAtEntries,
  transferSlugHistory,
} from './lib/expired-jobs-archive.mjs';

export { localeRouteKeys, transferSlugHistory };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

export const RETIREMENTS = [
  { retired: 'solothurner-spitaeler', canonical: 'soh-solothurner-spitaeler', cause: 'alias-storico' },
  { retired: 'kssg', canonical: 'hoch-health', cause: 'alias-storico' },
  { retired: 'spz', canonical: 'paraplegie', cause: 'alias-storico' },
  { retired: 'stgag', canonical: 'spital-thurgau', cause: 'alias-storico' },
  { retired: 'bewerbermanagement-stellen', canonical: 'tschuggen', cause: 'record-transitorio' },
  { retired: 'burgenstock-collection', canonical: 'buergenstock-hotels', cause: 'record-transitorio' },
  { retired: 'gkb-jobservice', canonical: 'gkb', cause: 'record-transitorio' },
  { retired: 'bewerbungsmanagement-spital-davos', canonical: 'spital-davos', cause: 'record-transitorio' },
  { retired: 'kzu-recruiting', canonical: 'kzu', cause: 'record-transitorio' },
  { retired: 'diakoniewerk-neumuenster', canonical: 'spital-zollikerberg', cause: 'alias-storico' },
];

export const SHARED_BOARD_TRANSFERS = [
  { broad: 'migros-ticino', dedicated: 'denner', cause: 'brand-distinti-board-condivisa' },
  { broad: 'migros-ticino', dedicated: 'migrolino', cause: 'brand-distinti-board-condivisa' },
  { broad: 'posta-svizzera-centro-regionale', dedicated: 'postauto', cause: 'brand-distinti-board-condivisa' },
  { broad: 'etat-de-fribourg', dedicated: 'rfsm-fribourg', cause: 'brand-distinti-board-condivisa' },
  { broad: 'confederazione-ticino', dedicated: 'agroscope', cause: 'crawler-troppo-largo' },
  { broad: 'luks', dedicated: 'spital-nidwalden', cause: 'brand-distinti-board-condivisa' },
  { broad: 'amministrazione-cantonale-ti', dedicated: 'canton-ticino-osc', cause: 'crawler-troppo-largo' },
  { broad: 'jumbo', dedicated: 'coop-ticino', cause: 'crawler-troppo-largo' },
];

export const ISSUE_6759_COVERAGE = [...RETIREMENTS, ...SHARED_BOARD_TRANSFERS];

export const ISSUE_6797_SHARED_BOARD_TRANSFERS = [
  {
    broad: 'swiss-medical-network',
    dedicated: 'privatklinik-obach',
    cause: 'brand-distinti-board-condivisa-race',
  },
];

function jobsOf(payload) {
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.jobs) ? payload.jobs : []);
}

function withJobs(payload, jobs) {
  return Array.isArray(payload) ? jobs : { ...payload, jobs };
}

function readSliceFrom(dir, key) {
  const file = path.join(dir, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, payload, jobs: jobsOf(payload) };
}

function readSlice(key) {
  return readSliceFrom(SLICES_DIR, key);
}

function readExpiredSlice(key) {
  return readSliceFrom(EXPIRED_SLICES_DIR, key);
}

let activeRollbackJournal = null;

function writeSlice(slice) {
  activeRollbackJournal?.capture(slice.file);
  writeJsonAtomic(slice.file, withJobs(slice.payload, slice.jobs));
}

function deleteSliceIfPresent(dir, key) {
  const file = path.join(dir, `${key}.json`);
  if (!fs.existsSync(file)) return false;
  activeRollbackJournal?.capture(file);
  fs.rmSync(file);
  return true;
}

function restoreFileSnapshot(file, snapshot) {
  if (snapshot === null) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snapshot);
}

function createRollbackJournal() {
  const snapshots = new Map();
  return {
    capture(file) {
      if (snapshots.has(file)) return;
      snapshots.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    },
    rollback() {
      for (const [file, snapshot] of [...snapshots.entries()].reverse()) {
        restoreFileSnapshot(file, snapshot);
      }
    },
  };
}

function assertRoutesPreserved(requiredJobs, actualJobs, label) {
  const required = new Set(requiredJobs.flatMap((job) => [...localeRouteKeys(job)]));
  const actual = new Set(actualJobs.flatMap((job) => [...localeRouteKeys(job)]));
  const missing = [...required].filter((route) => !actual.has(route));
  if (missing.length > 0) {
    throw new Error(`${label}: ${missing.length} locale routes lost (${missing.slice(0, 5).join(', ')})`);
  }
  return required.size;
}

/**
 * Merge a retired expired archive into the canonical archive by locale-aware
 * route identity. Expired records intentionally lack live URL/ID fields, so a
 * same-locale current/history route is their strongest safe identity.
 */
export function mergeRetiredCrawlerArchive(canonicalJobs, retiredJobs, canonicalKey) {
  let out = [];
  let routeOwners = new Map();
  let collapsed = 0;
  let canonicalCollapsed = 0;
  let rehomed = 0;
  let slugsTransferred = 0;

  const rebuildRouteOwners = () => {
    routeOwners = new Map();
    for (const job of out) {
      for (const route of localeRouteKeys(job)) routeOwners.set(route, job);
    }
  };

  for (const { job, retired } of [
    ...canonicalJobs.map((job) => ({ job, retired: false })),
    ...retiredJobs.map((job) => ({ job, retired: true })),
  ]) {
    const normalized = {
      ...structuredClone(job),
      company: retired ? (canonicalJobs[0]?.company || job.company) : job.company,
      companyKey: canonicalKey,
    };
    const owners = new Set(
      [...localeRouteKeys(normalized)].map((route) => routeOwners.get(route)).filter(Boolean),
    );
    if (owners.size === 0) {
      out.push(normalized);
      if (retired) rehomed += 1;
      rebuildRouteOwners();
      continue;
    }

    // A record can bridge multiple previously separate entries through
    // different locale/history routes. Collapse the whole connected component
    // onto the most recently expired payload, then rebuild the route index.
    const component = [...owners, normalized];
    component.sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt));
    const survivor = component[0];
    out = out.filter((entry) => !owners.has(entry));
    for (const removed of component.slice(1)) {
      slugsTransferred += transferSlugHistory(survivor, removed);
    }
    out.push(survivor);
    collapsed += retired ? 1 : 0;
    canonicalCollapsed += owners.size - (retired ? 1 : 0);
    rebuildRouteOwners();
  }

  const routesBefore = assertRoutesPreserved(
    [...canonicalJobs, ...retiredJobs],
    out,
    `${canonicalKey} archive merge`,
  );
  return { jobs: out, collapsed, canonicalCollapsed, rehomed, slugsTransferred, routesBefore };
}

/** Reconcile one canonical archive, including the no-retired-slice repair path. */
export function reconcileExpiredArchive(canonicalJobs, retiredJobs, canonicalKey) {
  const result = mergeRetiredCrawlerArchive(canonicalJobs, retiredJobs, canonicalKey);
  const repaired = normalizeExpiredAtEntries(
    result.jobs,
    { source: `reconcile-expired-slice/${canonicalKey}` },
  );
  return {
    ...result,
    repaired,
    needsWrite: Boolean(retiredJobs?.length) || result.canonicalCollapsed > 0 || repaired > 0,
  };
}

function ownershipIdentity(job = {}) {
  const url = String(job?.url || '');
  const yid = url.match(/[?&]yid=(\d+)/i)?.[1];
  if (yid) return `concorsi-ti-yid:${yid}`;
  const urlKey = extractStableJobId(url);
  if (urlKey && !urlKey.startsWith('url:')) return urlKey;
  const normalizedUrl = normalizeJobUrl(url);
  if (normalizedUrl) return `url:${normalizedUrl}`;
  if (hasUsableJobId(job)) return `id:${job.id}`;
  if (job?.slug) {
    throw new Error(`ownership identity reached unsafe slug fallback: ${job.slug}`);
  }
  return null;
}

/** Merge one retired company slice into its canonical survivor. */
export function mergeRetiredCrawlerJobs(canonicalJobs, retiredJobs, canonicalKey) {
  const out = canonicalJobs.map((job) => ({ ...job }));
  const byIdentity = new Map(out.map((job) => [ownershipIdentity(job), job]));
  const canonicalTemplate = out[0] || {};
  let collapsed = 0;
  let rehomed = 0;
  let slugsTransferred = 0;

  for (const retired of retiredJobs) {
    const identity = ownershipIdentity(retired);
    const survivor = identity ? byIdentity.get(identity) : null;
    if (survivor) {
      slugsTransferred += transferSlugHistory(survivor, retired);
      collapsed += 1;
      continue;
    }

    const rehomedJob = {
      ...retired,
      company: canonicalTemplate.company || retired.company,
      companyKey: canonicalKey,
      companyDomain: canonicalTemplate.companyDomain || retired.companyDomain,
      source: canonicalTemplate.source || retired.source,
    };
    out.push(rehomedJob);
    if (identity) byIdentity.set(identity, rehomedJob);
    rehomed += 1;
  }

  return { jobs: out, collapsed, rehomed, slugsTransferred };
}

/** Remove jobs already owned by a dedicated slice, transferring slug history. */
export function transferOverlappingJobs(sourceJobs, targetJobs, predicate = () => true) {
  const targets = targetJobs.map((job) => ({ ...job }));
  const byIdentity = new Map(targets.map((job) => [ownershipIdentity(job), job]));
  const kept = [];
  let moved = 0;
  let slugsTransferred = 0;

  for (const source of sourceJobs) {
    const identity = ownershipIdentity(source);
    const target = identity ? byIdentity.get(identity) : null;
    if (!target || !predicate(source)) {
      kept.push(source);
      continue;
    }
    slugsTransferred += transferSlugHistory(target, source);
    moved += 1;
  }
  return { sourceJobs: kept, targetJobs: targets, moved, slugsTransferred };
}

/** Transfer every predicate-owned record, rehoming unique records safely. */
export function transferOwnedJobs(sourceJobs, targetJobs, targetKey, predicate) {
  const targets = targetJobs.map((job) => ({ ...job }));
  const byIdentity = new Map(targets.map((job) => [ownershipIdentity(job), job]));
  const targetTemplate = targets[0] || {};
  const kept = [];
  let moved = 0;
  let rehomed = 0;
  let slugsTransferred = 0;

  for (const source of sourceJobs) {
    if (!predicate(source)) {
      kept.push(source);
      continue;
    }
    const identity = ownershipIdentity(source);
    const target = identity ? byIdentity.get(identity) : null;
    if (target) {
      slugsTransferred += transferSlugHistory(target, source);
    } else {
      const rehomedJob = {
        ...source,
        company: targetTemplate.company || source.company,
        companyKey: targetKey,
        companyDomain: targetTemplate.companyDomain || source.companyDomain,
        source: targetTemplate.source || source.source,
      };
      targets.push(rehomedJob);
      if (identity) byIdentity.set(identity, rehomedJob);
      rehomed += 1;
    }
    moved += 1;
  }

  return { sourceJobs: kept, targetJobs: targets, moved, rehomed, slugsTransferred };
}

function assertOwnedTransfer(sourceJobs, result, predicate, label) {
  const targetIdentities = new Set(result.targetJobs.map(ownershipIdentity).filter(Boolean));
  const missing = sourceJobs
    .filter(predicate)
    .map(ownershipIdentity)
    .filter((identity) => identity && !targetIdentities.has(identity));
  const leaked = result.sourceJobs.filter(predicate);
  if (missing.length > 0 || leaked.length > 0) {
    throw new Error(`${label}: ownership transfer incomplete (${missing.length} missing target, ${leaked.length} left in broad slice)`);
  }
}

/** Shared-board overlaps must be fully removed even when ownership has no predicate. */
export function assertNoOverlappingJobs(broadJobs, dedicatedJobs, label) {
  const targetIdentities = new Set(dedicatedJobs.map(ownershipIdentity).filter(Boolean));
  const overlaps = broadJobs
    .map(ownershipIdentity)
    .filter((identity) => identity && targetIdentities.has(identity));
  if (overlaps.length > 0) {
    throw new Error(`${label}: ${overlaps.length} shared ownership identities remain`);
  }
}

/**
 * A RETIREMENTS merge (active or archive) must leave every locale route owned
 * by exactly one job. `mergeRetiredCrawlerJobs`/`mergeRetiredCrawlerArchive`
 * collapse overlaps found *during* the merge, but two jobs that already
 * shared a route before this run (e.g. two separately-merged historical
 * records) are never compared against each other otherwise — the same class
 * of asymmetry `assertNoOverlappingJobs` guards against for shared-board
 * transfers.
 */
export function assertNoDuplicateRoutesWithin(jobs, label) {
  const owners = new Map();
  for (const job of jobs) {
    for (const route of localeRouteKeys(job)) {
      const owner = owners.get(route);
      if (owner !== undefined && owner !== job) {
        throw new Error(`${label}: route ${route} is owned by more than one job`);
      }
      owners.set(route, job);
    }
  }
}

/**
 * Observe previous-route claims that cross expired-slice boundaries.
 *
 * The normal collapse is intentionally scoped to one company slice. This
 * observer covers the sibling case: two grouped-commit slices can carry the
 * same companyKey and claim the same historical route even when neither file
 * is one of the explicit RETIREMENTS inputs.
 */
export function auditExpiredArchiveRouteOverlaps(slices) {
  const owners = new Map();
  const crossSliceDuplicateRoutes = [];
  for (const slice of slices || []) {
    const file = path.basename(String(slice?.file || slice?.key || '(unknown)'));
    for (const job of slice?.jobs || []) {
      if (!job?.companyKey) continue;
      for (const route of localeRouteKeys(job)) {
        const key = `${job.companyKey}::${route}`;
        const previous = owners.get(key);
        if (!previous) {
          owners.set(key, { file, slug: job.slug });
        } else if (previous.file !== file) {
          crossSliceDuplicateRoutes.push({
            companyKey: job.companyKey,
            route,
            files: [previous.file, file],
            slugs: [previous.slug, job.slug],
          });
        }
      }
    }
  }
  const retired = new Set(RETIREMENTS.map(({ retired: key }) => `${key}.json`));
  return {
    crossSliceDuplicateRoutes,
    retiredArchiveFiles: [...new Set((slices || [])
      .map((slice) => path.basename(String(slice?.file || slice?.key || '')))
      .filter((file) => retired.has(file)))],
  };
}

/**
 * Sweep every committed expired slice with the same route-collapse primitive
 * used by the crawler writers. Each file is checked for route conservation
 * before an optional atomic write; the legacy-cap refusal remains reportable
 * and leaves that component untouched.
 */
export function sweepExpiredArchiveSlices({ dir = EXPIRED_SLICES_DIR, apply = false } = {}) {
  const slices = listSliceFileNames(dir).map((file) => {
    const filePath = path.join(dir, file);
    let jobs;
    try {
      jobs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`expired archive ${file} is not valid JSON: ${error.message}`, { cause: error });
    }
    if (!Array.isArray(jobs)) throw new Error(`expired archive ${file} is not a JSON array`);
    return { file, filePath, jobs, originalJobs: structuredClone(jobs) };
  });
  const beforeAudit = auditExpiredArchiveRouteOverlaps(slices);
  let collapsed = 0;
  let repaired = 0;
  let capRefused = 0;
  const report = [];

  for (const slice of slices) {
    const result = collapseDuplicateRouteEntries(slice.jobs, { source: `expired-sweep/${slice.file}` });
    assertRoutesPreserved(slice.jobs, result.entries, `expired-sweep/${slice.file}`);
    const repairedInSlice = normalizeExpiredAtEntries(
      result.entries,
      { source: `expired-sweep/${slice.file}` },
    );
    const changed = result.collapsed > 0 || repairedInSlice > 0;
    // A cap refusal returns a sorted view containing the original entries.
    // Do not substitute that view for the candidate when nothing was actually
    // repaired: the refusal is an explicit "leave this component untouched".
    slice.candidateJobs = changed ? result.entries : slice.jobs;
    collapsed += result.collapsed;
    repaired += repairedInSlice;
    capRefused += result.capRefused;
    report.push({
      file: slice.file,
      collapsed: result.collapsed,
      repaired: repairedInSlice,
      capRefused: result.capRefused,
      changed,
    });
  }

  // The per-file collapse above cannot see two grouped-commit slices that
  // claim the same company route. Tag each candidate with its source file,
  // collapse only when the audit still finds a cross-slice collision, and then
  // return a merged survivor to the file that owned its newest payload.
  const candidateSlices = slices.map((slice) => ({ file: slice.file, jobs: slice.candidateJobs }));
  const candidateAudit = auditExpiredArchiveRouteOverlaps(candidateSlices);
  let crossSliceCollapsed = 0;
  let crossSliceCapRefused = 0;
  let finalJobsByFile = new Map(slices.map((slice) => [slice.file, slice.candidateJobs]));
  if (candidateAudit.crossSliceDuplicateRoutes.length > 0) {
    const taggedEntries = slices.flatMap((slice) => slice.candidateJobs.map((job) => ({
      ...structuredClone(job),
      __sweepSourceFile: slice.file,
    })));
    const crossResult = collapseDuplicateRouteEntries(taggedEntries, {
      source: 'expired-sweep/cross-slice',
    });
    assertRoutesPreserved(taggedEntries, crossResult.entries, 'expired-sweep/cross-slice');
    crossSliceCollapsed = crossResult.collapsed;
    crossSliceCapRefused = crossResult.capRefused;
    if (crossSliceCollapsed > 0) {
      finalJobsByFile = new Map(slices.map((slice) => [slice.file, []]));
      for (const entry of crossResult.entries) {
        const sourceFile = entry.__sweepSourceFile;
        if (!finalJobsByFile.has(sourceFile)) {
          throw new Error(`expired archive sweep lost source file marker for ${sourceFile}`);
        }
        const { __sweepSourceFile: _sourceFile, ...cleanEntry } = entry;
        finalJobsByFile.get(sourceFile).push(cleanEntry);
      }
    }
  }
  collapsed += crossSliceCollapsed;
  capRefused += crossSliceCapRefused;

  const changedFiles = new Set();
  for (const slice of slices) {
    const finalJobs = finalJobsByFile.get(slice.file) || [];
    const changed = JSON.stringify(slice.originalJobs) !== JSON.stringify(finalJobs);
    if (changed) changedFiles.add(slice.file);
    // Make the audit below represent exactly what an apply would persist. An
    // unchanged file retains its original ordering and object identity rather
    // than an unpersisted sorted candidate.
    slice.jobs = changed ? finalJobs : slice.originalJobs;
    const entryReport = report.find((item) => item.file === slice.file);
    if (entryReport) entryReport.changed = changed;
  }

  const afterAudit = auditExpiredArchiveRouteOverlaps(slices);
  const overlapKey = (overlap) => `${overlap.companyKey}::${overlap.route}`;
  const beforeOverlapKeys = new Set(beforeAudit.crossSliceDuplicateRoutes.map(overlapKey));
  const introducedOverlaps = afterAudit.crossSliceDuplicateRoutes.filter(
    (overlap) => !beforeOverlapKeys.has(overlapKey(overlap)),
  );
  const touchedExistingOverlaps = afterAudit.crossSliceDuplicateRoutes.filter(
    (overlap) => beforeOverlapKeys.has(overlapKey(overlap))
      && overlap.files.some((file) => changedFiles.has(file)),
  );
  if (apply && (introducedOverlaps.length > 0 || touchedExistingOverlaps.length > 0)) {
    throw new Error(
      `expired archive sweep left ${afterAudit.crossSliceDuplicateRoutes.length} cross-slice route overlap(s)`,
    );
  }
  if (apply) {
    for (const slice of slices) {
      if (!changedFiles.has(slice.file)) continue;
      activeRollbackJournal?.capture(slice.filePath);
      writeJsonAtomic(slice.filePath, slice.jobs);
    }
  }
  return {
    filesScanned: slices.length,
    filesChanged: changedFiles.size,
    collapsed,
    repaired,
    capRefused,
    crossSliceDuplicatesBefore: beforeAudit.crossSliceDuplicateRoutes.length,
    crossSliceDuplicatesAfter: afterAudit.crossSliceDuplicateRoutes.length,
    crossSliceCollapsed,
    retiredArchiveFiles: beforeAudit.retiredArchiveFiles,
    report,
  };
}

function reconcile({ apply = false } = {}) {
  const report = [];

  for (const item of RETIREMENTS) {
    const canonical = readSlice(item.canonical);
    const retired = readSlice(item.retired);
    let activeResult = { skipped: 'retired active slice already absent' };
    if (retired) {
      if (!canonical) {
        throw new Error(`${item.retired}->${item.canonical}: canonical slice absent; refusing to delete retired jobs`);
      }
      const result = mergeRetiredCrawlerJobs(canonical.jobs, retired.jobs, item.canonical);
      canonical.jobs = result.jobs;
      assertNoDuplicateRoutesWithin(canonical.jobs, `${item.retired}->${item.canonical} active merge`);
      activeResult = { ...result, jobs: undefined, retiredSlice: apply ? 'deleted' : 'would-delete' };
      if (apply) {
        // Write the survivor first. A crash before the unlink leaves a duplicate
        // that the next idempotent run can retry; unlinking first could lose the
        // only copy of an alias-only job and its indexed routes.
        writeSlice(canonical);
        if (!deleteSliceIfPresent(SLICES_DIR, item.retired)) {
          throw new Error(`${item.retired}->${item.canonical}: retired slice was not deleted after merge`);
        }
      }
    }

    const canonicalExpired = readExpiredSlice(item.canonical);
    const retiredExpired = readExpiredSlice(item.retired);
    let archiveResult = { skipped: 'retired expired slice already absent; canonical archive already deduplicated' };
    if (retiredExpired && !canonicalExpired) {
      throw new Error(`${item.retired}->${item.canonical}: canonical expired slice absent; refusing to delete retired archive`);
    }
    if (canonicalExpired) {
      const result = reconcileExpiredArchive(
        canonicalExpired.jobs,
        retiredExpired?.jobs || [],
        item.canonical,
      );
      canonicalExpired.jobs = result.jobs;
      assertNoDuplicateRoutesWithin(canonicalExpired.jobs, `${item.retired}->${item.canonical} archive merge`);
      const needsWrite = result.needsWrite;
      if (needsWrite) {
        archiveResult = {
          ...result,
          jobs: undefined,
          retiredSlice: retiredExpired ? (apply ? 'deleted' : 'would-delete') : 'already-absent',
        };
      }
      if (apply && needsWrite) {
        // Archive soft landings are route state. Persist and re-read the
        // canonical target before unlinking the alias so a partial write can
        // only leave duplicates, never erase history.
        writeSlice(canonicalExpired);
        const persisted = readExpiredSlice(item.canonical);
        if (!persisted) {
          throw new Error(`${item.retired}->${item.canonical}: canonical expired slice missing after write`);
        }
        assertRoutesPreserved(
          [...canonicalExpired.jobs, ...(retiredExpired?.jobs || [])],
          persisted.jobs,
          `${item.retired}->${item.canonical} persisted archive`,
        );
        if (persisted.jobs.some((job) => job.companyKey !== item.canonical)) {
          throw new Error(`${item.retired}->${item.canonical}: non-canonical companyKey remained after archive write`);
        }
        if (retiredExpired && !deleteSliceIfPresent(EXPIRED_SLICES_DIR, item.retired)) {
          throw new Error(`${item.retired}->${item.canonical}: retired expired slice was not deleted after merge`);
        }
      }
    }
    report.push({
      ...item,
      active: activeResult,
      archive: archiveResult,
    });
  }

  for (const item of [...SHARED_BOARD_TRANSFERS, ...ISSUE_6797_SHARED_BOARD_TRANSFERS]) {
    const source = readSlice(item.broad);
    const target = readSlice(item.dedicated);
    if (!source || !target) {
      report.push({ ...item, skipped: 'slice absent' });
      continue;
    }
    const ownerPredicate = item.broad === 'migros-ticino'
      ? (job) => dedicatedMigrosOwner(job) === item.dedicated
      : item.broad === 'posta-svizzera-centro-regionale'
        ? (job) => dedicatedPostOwner(job.company) === item.dedicated
        : item.broad === 'etat-de-fribourg'
          ? (job) => dedicatedFribourgOwner(job) === item.dedicated
          : item.broad === 'amministrazione-cantonale-ti'
            ? isCantonTicinoOscPosting
            : null;
    const result = ownerPredicate
      ? transferOwnedJobs(source.jobs, target.jobs, item.dedicated, ownerPredicate)
      : transferOverlappingJobs(source.jobs, target.jobs);
    if (ownerPredicate) {
      assertOwnedTransfer(source.jobs, result, ownerPredicate, `${item.broad}->${item.dedicated}`);
    }
    source.jobs = result.sourceJobs;
    target.jobs = result.targetJobs;
    if (!ownerPredicate) {
      // These boards expose the umbrella company on every record, so there is
      // no honest owner predicate. The supplier vacancy identity is the
      // ownership contract; assert its postcondition instead.
      assertNoOverlappingJobs(source.jobs, target.jobs, `${item.broad}->${item.dedicated}`);
    }
    if (apply) {
      writeSlice(source);
      writeSlice(target);
    }
    report.push({ ...item, moved: result.moved, rehomed: result.rehomed || 0, slugsTransferred: result.slugsTransferred });
  }

  // The OSC slice also contained four general-administration jobs. Run the
  // inverse transfer after the explicit OSC jobs have left the broad slice.
  const osc = readSlice('canton-ticino-osc');
  const administration = readSlice('amministrazione-cantonale-ti');
  if (!osc || !administration) return report;
  const inverse = transferOverlappingJobs(
    osc.jobs,
    administration.jobs,
    (job) => !isCantonTicinoOscPosting({ ...job, companyKey: '' }),
  );
  osc.jobs = inverse.sourceJobs;
  administration.jobs = inverse.targetJobs;
  if (apply) {
    writeSlice(osc);
    writeSlice(administration);
  }
  report.push({ broad: 'canton-ticino-osc', dedicated: 'amministrazione-cantonale-ti', correction: 'inverse', moved: inverse.moved, slugsTransferred: inverse.slugsTransferred });

  return report;
}

export function withFileRollback(operation) {
  const previousJournal = activeRollbackJournal;
  const journal = createRollbackJournal();
  activeRollbackJournal = journal;
  try {
    return operation(journal.capture);
  } catch (error) {
    try {
      journal.rollback();
    } catch (rollbackError) {
      const combined = new Error('reconciliation failed and its file rollback also failed');
      combined.cause = { error, rollbackError };
      throw combined;
    }
    throw error;
  } finally {
    activeRollbackJournal = previousJournal;
  }
}

export function run({ apply = false, expiredSweep = false } = {}) {
  const operation = () => {
    if (!expiredSweep) return reconcile({ apply });
    return {
      ownership: reconcile({ apply }),
      expiredSweep: sweepExpiredArchiveSlices({ apply }),
    };
  };
  return apply ? withFileRollback(operation) : operation();
}

function main() {
  const apply = process.argv.includes('--apply');
  const expiredSweep = process.argv.includes('--expired-sweep');
  const report = run({ apply, expiredSweep });
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    expiredSweep,
    coverage: ISSUE_6759_COVERAGE.length + ISSUE_6797_SHARED_BOARD_TRANSFERS.length,
    report,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
