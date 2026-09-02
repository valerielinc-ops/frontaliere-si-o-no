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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addPreviousSlugForLocale,
  DEFAULT_PREV_SLUG_CAP,
  getPreviousSlugsForLocale,
  LOCALES,
  promotePreviousSlugToLegacy,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { normalizeJobUrl } from './lib/crawler-source-hosts.mjs';
import {
  dedicatedFribourgOwner,
  dedicatedMigrosOwner,
  dedicatedPostOwner,
  isCantonTicinoOscPosting,
} from './lib/crawler-company-ownership.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

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

function writeSlice(slice) {
  writeJsonAtomic(slice.file, withJobs(slice.payload, slice.jobs));
}

function deleteSliceIfPresent(dir, key) {
  const file = path.join(dir, `${key}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** Every locale-qualified URL token served by an active or expired record. */
export function localeRouteKeys(job = {}) {
  const routes = new Set();
  for (const locale of LOCALES) {
    const current = job.slugByLocale?.[locale] || (locale === 'it' ? job.slug : '');
    if (current) routes.add(`${locale}:${current}`);
    if (locale === 'it' && job.slug) routes.add(`${locale}:${job.slug}`);
    for (const slug of getPreviousSlugsForLocale(job, locale)) {
      if (slug) routes.add(`${locale}:${slug}`);
    }
  }
  return routes;
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
    component.sort((a, b) => String(b.expiredAt || '').localeCompare(String(a.expiredAt || '')));
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

function ownershipIdentity(job = {}) {
  const url = String(job?.url || '');
  const yid = url.match(/[?&]yid=(\d+)/i)?.[1];
  if (yid) return `concorsi-ti-yid:${yid}`;
  const urlKey = extractStableJobId(url);
  if (urlKey && !urlKey.startsWith('url:')) return urlKey;
  const normalizedUrl = normalizeJobUrl(url);
  if (normalizedUrl) return `url:${normalizedUrl}`;
  // `job?.id` alone treats a falsy-but-real id (e.g. numeric `0`) as absent
  // and misroutes it into the unsafe slug fallback below. An empty string is
  // still genuinely no identity, so it keeps falling through.
  if (job?.id != null && job.id !== '') return `id:${job.id}`;
  if (job?.slug) {
    throw new Error(`ownership identity reached unsafe slug fallback: ${job.slug}`);
  }
  return null;
}

/** Preserve every route known by `removed` on `survivor`. */
export function transferSlugHistory(survivor, removed) {
  let transferred = 0;
  const requiredRoutes = new Map(LOCALES.map((locale) => [
    locale,
    new Set([
      ...getPreviousSlugsForLocale(survivor, locale),
      ...getPreviousSlugsForLocale(removed, locale),
      ...(removed.slugByLocale?.[locale] ? [removed.slugByLocale[locale]] : []),
      ...(locale === 'it' && removed.slug ? [removed.slug] : []),
    ]),
  ]));
  const add = (locale, slug) => {
    if (!slug || slug === survivor.slugByLocale?.[locale]) return;
    const before = new Set(survivor.previousSlugsByLocale?.[locale] || []).size;
    addPreviousSlugForLocale(
      survivor,
      locale,
      slug,
      DEFAULT_PREV_SLUG_CAP,
      'reconcile-crawler-company-ownership',
    );
    const after = new Set(survivor.previousSlugsByLocale?.[locale] || []).size;
    if (after > before) transferred += 1;
  };

  for (const locale of LOCALES) {
    add(locale, removed.slugByLocale?.[locale]);
    for (const slug of removed.previousSlugsByLocale?.[locale] || []) add(locale, slug);
  }
  add('it', removed.slug);

  // A flat-only legacy slug has no locale provenance. The SEO bridge contract
  // deliberately serves it under every locale prefix. Attributing it to `it`
  // would silently remove the existing EN/DE/FR routes. Keep those entries
  // flat while locale-attributed history stays in its exact bucket.
  const attributed = new Set();
  for (const slugs of Object.values(removed.previousSlugsByLocale || {})) {
    if (Array.isArray(slugs)) for (const slug of slugs) attributed.add(slug);
  }
  const flatOnly = new Set(
    (removed.previousSlugs || []).filter((slug) => slug && !attributed.has(slug)),
  );
  for (const slug of flatOnly) {
    if (promotePreviousSlugToLegacy(
      survivor,
      slug,
      undefined,
      'reconcile-crawler-company-ownership/flat-history',
    )) transferred += 1;
  }

  // Merging two histories can overflow a 20-entry locale bucket. Promote an
  // evicted route to unattributed legacy history: that bucket remains capped,
  // while the old URL is still served (conservatively under every locale).
  for (const [locale, required] of requiredRoutes) {
    const served = new Set(getPreviousSlugsForLocale({
      ...survivor,
    }, locale));
    const activeSlug = survivor.slugByLocale?.[locale] || survivor.slug;
    if (activeSlug) served.add(activeSlug);
    for (const slug of required) {
      if (!slug || served.has(slug)) continue;
      promotePreviousSlugToLegacy(
        survivor,
        slug,
        undefined,
        'reconcile-crawler-company-ownership/cap-overflow',
      );
      served.add(slug);
      transferred += 1;
    }
  }
  return transferred;
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

function run({ apply = false } = {}) {
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
      const result = mergeRetiredCrawlerArchive(
        canonicalExpired.jobs,
        retiredExpired?.jobs || [],
        item.canonical,
      );
      canonicalExpired.jobs = result.jobs;
      const needsWrite = Boolean(retiredExpired) || result.canonicalCollapsed > 0;
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

function main() {
  const apply = process.argv.includes('--apply');
  const report = run({ apply });
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    coverage: ISSUE_6759_COVERAGE.length + ISSUE_6797_SHARED_BOARD_TRANSFERS.length,
    report,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
