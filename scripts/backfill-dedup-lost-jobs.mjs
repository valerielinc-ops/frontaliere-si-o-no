#!/usr/bin/env node
/**
 * One-shot backfill: recover historical Class-B "silent slug-dedup losses"
 * from git history and write enriched expired entries into
 * data/jobs/expired/by-crawler/<slug>.json so jobsSeoPagesPlugin can render
 * soft-landing pages for the orphaned URLs.
 *
 * Background: scripts/cleanup-jobs.mjs (lines 305-329 pre-fix) collapsed
 * within-slice slug duplicates and then archived only the truly slug-distinct
 * removals. The dedup losers shared their slug with the winner, so they were
 * filtered out of `sliceRemoved` and never archived. This script recovers
 * them from `<sha>^:slice` for each housekeeping commit listed in the audit.
 *
 * Usage:
 *   node scripts/backfill-dedup-lost-jobs.mjs --dry-run                       (default)
 *   node scripts/backfill-dedup-lost-jobs.mjs --dry-run --audit /path/audit.md
 *   node scripts/backfill-dedup-lost-jobs.mjs --apply
 *
 * --dry-run is the default. Use --apply to actually write expired slice files.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_AUDIT_PATH = '/tmp/housekeeping-audit-2026-04-07.md';
const EXPIRED_SLICES_DIR = path.resolve(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const SLICE_DIR_REL = 'data/jobs/by-crawler';
const TRACKING_PATH = path.resolve(ROOT, 'data', 'all-known-job-slugs.json');
const LOCALE_LIST = ['it', 'en', 'de', 'fr'];
const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' };
const SECTION_BY_LOCALE = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const TICINO_MIN_SALARY_CHF = 41080;
const FALLBACK_POSTAL_CODE = '6900';
const FALLBACK_LOCALITY = 'Ticino';
const FALLBACK_REGION = 'TI';
const FALLBACK_COUNTRY = 'CH';
const FALLBACK_EMPLOYMENT_TYPE = 'OTHER';

const EXPIRATION_REASON = 'silent_dedup_backfill';

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, auditPath: DEFAULT_AUDIT_PATH };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    } else if (arg === '--audit') {
      args.auditPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--audit=')) {
      args.auditPath = arg.slice('--audit='.length);
    }
  }
  return args;
}

/**
 * Parse the housekeeping audit markdown table and return a list of commits
 * that have non-zero Class B (silent dedup loss) counts.
 *
 * Audit table format (Per-commit breakdown):
 *   | SHA | Date | Removed | A | **B** | D |
 *   |---|---|---|---|---|---|
 *   | f8b229154 | 2026-04-07 | 28 | 3 | **19** | 6 |
 *
 * Returns: Array<{ sha: string, date: string, classB: number }>
 */
export function parseAuditCommits(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  const lines = markdown.split('\n');
  const result = [];
  let inTable = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      if (inTable) inTable = false;
      continue;
    }
    if (line.startsWith('|---') || line.includes('| SHA |') || line.includes('|SHA|')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 6) continue;
    const sha = cells[0];
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const date = cells[1];
    const classBRaw = cells[4].replace(/\*\*/g, '').trim();
    const classB = Number.parseInt(classBRaw, 10);
    if (!Number.isFinite(classB) || classB <= 0) continue;
    result.push({ sha, date, classB });
  }
  return result;
}

function gitShow(spec, { cwd = ROOT } = {}) {
  try {
    return execFileSync('git', ['show', spec], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function gitCommitDate(sha, { cwd = ROOT } = {}) {
  try {
    return execFileSync('git', ['show', '-s', '--format=%cI', sha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function listChangedSliceFiles(sha, { cwd = ROOT } = {}) {
  try {
    const out = execFileSync(
      'git',
      ['show', '--name-only', '--pretty=format:', sha],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${SLICE_DIR_REL}/`) && l.endsWith('.json'));
  } catch {
    return [];
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJobsArray(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.jobs)) return payload.jobs;
  return null;
}

function jobIdentityKey(job) {
  if (!job || typeof job !== 'object') return '';
  if (job.id) return `id:${job.id}`;
  if (job.url) return `url:${job.url}`;
  if (job.slug && job.title) return `slugtitle:${job.slug}|${job.title}`;
  return '';
}

function buildIdMap(jobs) {
  const map = new Map();
  if (!Array.isArray(jobs)) return map;
  for (const job of jobs) {
    const key = jobIdentityKey(job);
    if (key) map.set(key, job);
  }
  return map;
}

function buildSlugToJobsMap(jobs) {
  const map = new Map();
  if (!Array.isArray(jobs)) return map;
  for (const job of jobs) {
    const slug = job && typeof job.slug === 'string' ? job.slug.trim() : '';
    if (!slug) continue;
    if (!map.has(slug)) map.set(slug, []);
    map.get(slug).push(job);
  }
  return map;
}

function normalizeForCompare(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Slugify a free-form locality string into a URL-safe token suitable for
 * appending to a colliding base slug. Mirrors the conventions used elsewhere
 * in the project (lowercase, hyphen-separated, ASCII only, no leading or
 * trailing hyphens).
 */
export function slugifyLocality(value) {
  if (typeof value !== 'string') return '';
  const ascii = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii;
}

/**
 * Generate a unique soft-landing slug for a Class B dedup loser. Strategy:
 * append the loser's raw locality (e.g. -novaggio, -biasca) to the original
 * colliding slug. If that suffixed slug is already taken (by an active job
 * winner OR by a previously-recovered loser in the same backfill batch), keep
 * appending numeric suffixes (-2, -3, …) until a free slug is found. The
 * `takenSlugs` set is mutated to record the chosen slug so callers can
 * thread it through the rest of the batch.
 */
export function disambiguateSlugForLoser(originalSlug, locality, takenSlugs) {
  const base = typeof originalSlug === 'string' ? originalSlug.trim() : '';
  if (!base) return '';
  const taken = takenSlugs instanceof Set ? takenSlugs : new Set();
  const localitySlug = slugifyLocality(locality);
  let candidate = localitySlug ? `${base}-${localitySlug}` : base;
  if (candidate === base) {
    // No locality available — fall back to numeric suffixes only.
    candidate = `${base}-2`;
  }
  let n = 2;
  // Note: we never collide with the base itself because the active winner
  // already owns that slug. We must skip both the bare base and any
  // previously-claimed locality variant.
  const isFree = (s) => s !== base && !taken.has(s);
  while (!isFree(candidate)) {
    candidate = localitySlug ? `${base}-${localitySlug}-${n}` : `${base}-${n}`;
    n += 1;
    if (n > 99) break; // safety bound; should never happen in practice
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Classify a removed job (whose slug remains in the after-set) against the
 * surviving winners at that slug. The audit distinguishes:
 *   - Class A: true duplicate — same slug + same title + same RAW location
 *     (the upstream CMS just re-published the same role at a different URL).
 *     Recovering these adds no SEO value since the kept job already serves
 *     the slug, and they may collide with the existing rendered job.
 *   - Class B: silent loss — same slug but different title or different RAW
 *     location (a distinct opening at a different physical site that was
 *     collapsed into the winner's slug). These must be backfilled so the
 *     soft-landing pipeline knows about them.
 *
 * Use the raw `location` field (NOT `addressLocality`) because
 * `hardenJobLocaleFields` overwrites `addressLocality` to a single canonical
 * value across the slice, while `location` preserves the per-vacancy site.
 */
export function classifyDedupLoser(removedJob, keptWinners) {
  if (!removedJob) return 'B';
  const winners = Array.isArray(keptWinners)
    ? keptWinners
    : keptWinners
      ? [keptWinners]
      : [];
  if (winners.length === 0) return 'B';
  const removedTitle = normalizeForCompare(removedJob.title);
  const removedLoc = normalizeForCompare(removedJob.location || removedJob.addressLocality);
  for (const w of winners) {
    const wTitle = normalizeForCompare(w?.title);
    const wLoc = normalizeForCompare(w?.location || w?.addressLocality);
    if (removedTitle && removedTitle === wTitle && removedLoc === wLoc) {
      return 'A';
    }
  }
  return 'B';
}

/**
 * Build an enriched expired entry from a recovered job, applying the same
 * mandatory-field fallbacks the runtime pipeline uses (Ticino min wage,
 * postal 6900, OTHER employment type, etc.). Mirrors buildExpiredEntry in
 * scripts/cleanup-jobs.mjs but adds dedupArchive + expirationReason markers
 * and uses the historical commit date as expiredAt.
 *
 * `overrideSlug` lets callers substitute a disambiguated slug (e.g.
 * `${base}-${locality}`) for Class B dedup losers, so the loser gets its
 * own unique soft-landing page rather than colliding with the active
 * winner that occupies the original slug.
 */
export function buildBackfillExpiredEntry(job, expiredAt, overrideSlug = null) {
  if (!job || typeof job !== 'object') return null;
  if (!job.title || typeof job.title !== 'string') return null;
  const sourceSlug = typeof job.slug === 'string' ? job.slug.trim() : '';
  const finalSlug = typeof overrideSlug === 'string' && overrideSlug.trim()
    ? overrideSlug.trim()
    : sourceSlug;
  if (!finalSlug) return null;
  const titleByLocale = job.titleByLocale && typeof job.titleByLocale === 'object'
    ? { ...job.titleByLocale }
    : {};
  const descriptionByLocale = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
    ? { ...job.descriptionByLocale }
    : {};
  // When the slug is disambiguated, slugByLocale should reflect the new slug
  // for every locale so the build plugin generates a consistent soft-landing
  // URL. We don't have per-locale localized variants for the disambiguated
  // suffix (the locality token is already locale-neutral), so all locales use
  // the same finalSlug.
  const sourceSlugByLocale = job.slugByLocale && typeof job.slugByLocale === 'object'
    ? job.slugByLocale
    : {};
  const slugByLocale = finalSlug !== sourceSlug
    ? Object.fromEntries(LOCALE_LIST.map((l) => [l, finalSlug]))
    : { ...sourceSlugByLocale };

  const addressLocality = (typeof job.addressLocality === 'string' && job.addressLocality.trim())
    || (typeof job.location === 'string' && job.location.trim())
    || FALLBACK_LOCALITY;
  const postalCode = (typeof job.postalCode === 'string' && job.postalCode.trim())
    || FALLBACK_POSTAL_CODE;
  const streetAddress = (typeof job.streetAddress === 'string' && job.streetAddress.trim())
    || addressLocality;
  const employmentType = (typeof job.employmentType === 'string' && job.employmentType.trim())
    || FALLBACK_EMPLOYMENT_TYPE;
  const addressRegion = (typeof job.addressRegion === 'string' && job.addressRegion.trim())
    || FALLBACK_REGION;
  const addressCountry = (typeof job.addressCountry === 'string' && job.addressCountry.trim())
    || FALLBACK_COUNTRY;

  const salaryCurrency = (typeof job.salaryCurrency === 'string' && job.salaryCurrency.trim())
    || (typeof job.currency === 'string' && job.currency.trim())
    || 'CHF';
  const salaryPeriod = (typeof job.salaryPeriod === 'string' && job.salaryPeriod.trim()) || 'YEAR';
  const rawMin = Number.isFinite(job.salaryMin) ? job.salaryMin : null;
  const rawMax = Number.isFinite(job.salaryMax) ? job.salaryMax : null;
  const salaryMin = rawMin && rawMin > 0 ? rawMin : TICINO_MIN_SALARY_CHF;
  const salaryMax = rawMax && rawMax > 0 ? rawMax : null;

  const inheritedPrev = Array.isArray(job.previousSlugs)
    ? job.previousSlugs.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : [];
  // When we disambiguate, record the original colliding slug as a previous
  // alias so the build plugin can short-circuit any old indexed URL.
  // (Even though the active winner currently owns the base slug, retaining
  // this hint means future audits can trace the loser back to its origin.)
  const previousSlugs = finalSlug !== sourceSlug && sourceSlug
    ? Array.from(new Set([sourceSlug, ...inheritedPrev]))
    : inheritedPrev;

  const entry = {
    slug: finalSlug,
    title: job.title,
    titleByLocale,
    company: typeof job.company === 'string' ? job.company : '',
    companyKey: typeof job.companyKey === 'string' ? job.companyKey : '',
    location: typeof job.location === 'string' ? job.location : addressLocality,
    addressLocality,
    addressRegion,
    addressCountry,
    descriptionByLocale,
    slugByLocale,
    sector: typeof job.sector === 'string' ? job.sector : '',
    expiredAt,
    expirationReason: EXPIRATION_REASON,
    dedupArchive: true,
    previousSlugs,
    postalCode,
    streetAddress,
    employmentType,
    salaryMin,
    salaryMax,
    salaryCurrency,
    salaryPeriod,
  };
  return entry;
}

/**
 * Validate that a constructed expired entry satisfies the JobPosting
 * mandatory-fields rules from CLAUDE.md. Returns { ok: boolean, missing: string[] }.
 */
export function validateExpiredEntry(entry) {
  const missing = [];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, missing: ['entry'] };
  }
  if (!entry.slug) missing.push('slug');
  if (!entry.title) missing.push('title');
  if (!entry.expiredAt) missing.push('expiredAt');
  if (!entry.company) missing.push('company');
  if (!entry.addressLocality) missing.push('addressLocality');
  if (!entry.postalCode) missing.push('postalCode');
  if (!entry.streetAddress) missing.push('streetAddress');
  if (!entry.employmentType) missing.push('employmentType');
  if (!entry.salaryMin || !Number.isFinite(entry.salaryMin)) missing.push('salaryMin');
  if (!entry.salaryCurrency) missing.push('salaryCurrency');
  if (!entry.salaryPeriod) missing.push('salaryPeriod');
  // descriptionByLocale must contain at least one locale with >= 30 chars
  const desc = entry.descriptionByLocale && typeof entry.descriptionByLocale === 'object'
    ? entry.descriptionByLocale
    : {};
  const longestDesc = Object.values(desc).reduce(
    (acc, v) => Math.max(acc, typeof v === 'string' ? v.length : 0),
    0,
  );
  if (longestDesc < 30) missing.push('descriptionByLocale(>=30)');
  return { ok: missing.length === 0, missing };
}

function loadExpiredSliceFromDisk(crawlerKey) {
  const slicePath = path.join(EXPIRED_SLICES_DIR, `${crawlerKey}.json`);
  if (!fs.existsSync(slicePath)) return [];
  try {
    const text = fs.readFileSync(slicePath, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Load the set of currently-active slugs for a crawler from disk. Used to
 * seed the per-crawler taken-slug set so disambiguation never collides with
 * a live job page. Reads both the HEAD slice in data/jobs/by-crawler/ and
 * the global tracking file (so existing soft-landing slugs are also
 * respected).
 */
function loadActiveSlugsForCrawler(crawlerKey) {
  const slugs = new Set();
  const slicePath = path.resolve(ROOT, SLICE_DIR_REL, `${crawlerKey}.json`);
  if (fs.existsSync(slicePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
      const jobs = extractJobsArray(parsed);
      if (Array.isArray(jobs)) {
        for (const j of jobs) {
          if (j?.slug && typeof j.slug === 'string') slugs.add(j.slug.trim());
          if (j?.slugByLocale && typeof j.slugByLocale === 'object') {
            for (const v of Object.values(j.slugByLocale)) {
              if (typeof v === 'string' && v) slugs.add(v.trim());
            }
          }
        }
      }
    } catch { /* ignore */ }
  }
  // Also seed from the global tracking file (data/all-known-job-slugs.json),
  // which records every slug that has ever produced a soft-landing page so we
  // don't accidentally re-mint a slug that already serves another loser.
  if (fs.existsSync(TRACKING_PATH)) {
    try {
      const tracking = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
      if (tracking && typeof tracking === 'object') {
        for (const k of Object.keys(tracking)) slugs.add(k);
      }
    } catch { /* ignore */ }
  }
  return [...slugs];
}

function existingEntryKey(entry) {
  // The expired-slice schema is one entry per slug (matches cleanup-jobs.mjs
  // archiveExpiredJobsPerCrawler), so idempotency is keyed by slug alone.
  return entry.slug;
}

/**
 * Process all commits with non-zero Class B losses and produce a list of
 * proposed expired entries grouped by crawler key. Pure: does not write to
 * disk and does not consult the live filesystem (callers can compose with
 * loadExpiredSliceFromDisk + dedupAgainstExisting for idempotency).
 */
export function backfillFromCommits({
  commits,
  rootDir = ROOT,
  shouldExtractJobsForSlice,
  loadActiveSlugs,
}) {
  const proposedByCrawler = new Map();
  const perCommit = [];
  const unrecoverable = [];
  // takenSlugsByCrawler[crawlerKey] = Set of slugs already claimed (active
  // winners + already-disambiguated losers in this batch). Threading this
  // across all commits per crawler ensures collision-free output even when
  // the same colliding base slug appears in multiple consecutive commits.
  const takenSlugsByCrawler = new Map();
  // Identity-key tracking across the whole batch: if the same physical job
  // (same id/url) was lost in N consecutive commits, we only want to recover
  // it once (otherwise idempotency relies entirely on slug collapse, which
  // can mis-merge two distinct openings if their disambiguated slugs happen
  // to match). This per-batch dedup is strictly tighter than slug-only.
  const seenIdentityByCrawler = new Map();

  for (const commit of commits) {
    const { sha, classB } = commit;
    const expiredAt = gitCommitDate(sha, { cwd: rootDir });
    if (!expiredAt) {
      unrecoverable.push({ sha, reason: 'no commit date' });
      continue;
    }
    const slices = listChangedSliceFiles(sha, { cwd: rootDir });
    if (slices.length === 0) {
      unrecoverable.push({ sha, reason: 'no slice files in commit' });
      continue;
    }
    let commitRecovered = 0;
    for (const slicePath of slices) {
      const crawlerKey = path.basename(slicePath, '.json');
      if (typeof shouldExtractJobsForSlice === 'function' && !shouldExtractJobsForSlice(crawlerKey)) {
        continue;
      }
      const beforeText = gitShow(`${sha}^:${slicePath}`, { cwd: rootDir });
      const afterText = gitShow(`${sha}:${slicePath}`, { cwd: rootDir });
      if (!beforeText) {
        unrecoverable.push({ sha, slice: crawlerKey, reason: 'no pre-commit slice state' });
        continue;
      }
      if (!afterText) {
        unrecoverable.push({ sha, slice: crawlerKey, reason: 'no post-commit slice state' });
        continue;
      }
      const beforeJobs = extractJobsArray(safeJsonParse(beforeText));
      const afterJobs = extractJobsArray(safeJsonParse(afterText));
      if (!Array.isArray(beforeJobs) || !Array.isArray(afterJobs)) {
        unrecoverable.push({ sha, slice: crawlerKey, reason: 'malformed slice JSON' });
        continue;
      }
      // Initialize the crawler-scoped taken-slug set lazily. Seed it with
      // both the after-state slugs (the active winners) AND any
      // currently-active job slugs reported by loadActiveSlugs (which
      // typically reflects HEAD). This guarantees we never mint a slug that
      // collides with a live job page.
      if (!takenSlugsByCrawler.has(crawlerKey)) {
        const seeded = new Set();
        if (typeof loadActiveSlugs === 'function') {
          try {
            const active = loadActiveSlugs(crawlerKey) || [];
            for (const s of active) {
              if (typeof s === 'string' && s) seeded.add(s);
            }
          } catch { /* ignore loader errors */ }
        }
        takenSlugsByCrawler.set(crawlerKey, seeded);
      }
      const takenSlugs = takenSlugsByCrawler.get(crawlerKey);
      // Always seed with the after-state slugs of THIS commit, since they
      // were active at the time of pruning (and remain so if loadActiveSlugs
      // is missing).
      for (const j of afterJobs) {
        if (j?.slug && typeof j.slug === 'string') takenSlugs.add(j.slug.trim());
      }

      if (!seenIdentityByCrawler.has(crawlerKey)) {
        seenIdentityByCrawler.set(crawlerKey, new Set());
      }
      const seenIdentity = seenIdentityByCrawler.get(crawlerKey);

      const beforeMap = buildIdMap(beforeJobs);
      const afterMap = buildIdMap(afterJobs);
      const afterSlugMap = buildSlugToJobsMap(afterJobs);
      for (const [key, beforeJob] of beforeMap.entries()) {
        if (afterMap.has(key)) continue;
        const slug = typeof beforeJob.slug === 'string' ? beforeJob.slug.trim() : '';
        if (!slug) continue;
        // Class B = removed AND its slug remains in the post-commit slice.
        const keptWinners = afterSlugMap.get(slug);
        if (!keptWinners || keptWinners.length === 0) continue;
        // Skip Class A true duplicates (same opening, just a different
        // upstream URL/UUID) — those are already correctly served.
        const klass = classifyDedupLoser(beforeJob, keptWinners);
        if (klass === 'A') continue;

        // Per-opening dedup across the whole batch: a Class B loser with the
        // same (base slug + raw locality) as one we've already recovered is
        // the same physical opening, just dropped on a different day. Use
        // slug+locality (not id/url) so we are robust to upstream UUID churn.
        const localityForKey = typeof beforeJob.location === 'string' && beforeJob.location.trim()
          ? beforeJob.location
          : (typeof beforeJob.addressLocality === 'string' ? beforeJob.addressLocality : '');
        const openingKey = `${slug}|${normalizeForCompare(localityForKey)}`;
        if (seenIdentity.has(openingKey)) continue;
        seenIdentity.add(openingKey);
        // Suppress unused-binding lint by referencing key explicitly.
        void key;

        // Disambiguate: mint a unique soft-landing slug for this loser by
        // appending its raw locality (or a numeric suffix as fallback).
        const locality = typeof beforeJob.location === 'string' && beforeJob.location.trim()
          ? beforeJob.location
          : (typeof beforeJob.addressLocality === 'string' ? beforeJob.addressLocality : '');
        const newSlug = disambiguateSlugForLoser(slug, locality, takenSlugs);
        if (!newSlug) {
          unrecoverable.push({ sha, slice: crawlerKey, reason: 'slug disambiguation failed', slug });
          continue;
        }

        const entry = buildBackfillExpiredEntry(beforeJob, expiredAt, newSlug);
        if (!entry) {
          unrecoverable.push({ sha, slice: crawlerKey, reason: 'failed to build entry', id: beforeJob?.id });
          continue;
        }
        const validation = validateExpiredEntry(entry);
        if (!validation.ok) {
          unrecoverable.push({
            sha,
            slice: crawlerKey,
            reason: `invalid expired entry: missing ${validation.missing.join(',')}`,
            id: beforeJob?.id,
            slug: newSlug,
          });
          continue;
        }
        if (!proposedByCrawler.has(crawlerKey)) {
          proposedByCrawler.set(crawlerKey, []);
        }
        proposedByCrawler.get(crawlerKey).push(entry);
        commitRecovered += 1;
      }
    }
    perCommit.push({ sha, classB, recovered: commitRecovered });
  }

  return { proposedByCrawler, perCommit, unrecoverable };
}

/**
 * Idempotency filter: drop proposed entries whose slug already exists in the
 * on-disk expired slice for the same crawler. The expired-slice schema is
 * one entry per slug, so within a batch we also collapse same-slug proposals
 * keeping the most-recent expiredAt (matches cleanup-jobs.mjs behavior).
 */
export function dedupAgainstExisting(proposedByCrawler, loadExisting) {
  const filtered = new Map();
  let droppedDuplicates = 0;
  for (const [crawlerKey, proposals] of proposedByCrawler.entries()) {
    const existing = loadExisting(crawlerKey) || [];
    const existingKeys = new Set(existing.map(existingEntryKey));
    const bySlug = new Map();
    for (const entry of proposals) {
      const k = existingEntryKey(entry);
      if (existingKeys.has(k)) {
        droppedDuplicates += 1;
        continue;
      }
      const prior = bySlug.get(k);
      if (prior) {
        droppedDuplicates += 1;
        // Keep the entry with the most recent expiredAt (lexicographic ISO).
        if (String(entry.expiredAt || '').localeCompare(String(prior.expiredAt || '')) > 0) {
          bySlug.set(k, entry);
        }
        continue;
      }
      bySlug.set(k, entry);
    }
    const next = [...bySlug.values()];
    if (next.length > 0) filtered.set(crawlerKey, next);
  }
  return { filtered, droppedDuplicates };
}

function summarizeCounts(map) {
  const out = {};
  let total = 0;
  for (const [k, v] of map.entries()) {
    out[k] = v.length;
    total += v.length;
  }
  return { total, perCrawler: out };
}

function formatJsonSample(entry) {
  const safe = {
    ...entry,
    descriptionByLocale: Object.fromEntries(
      Object.entries(entry.descriptionByLocale || {}).map(([loc, val]) => [
        loc,
        typeof val === 'string' && val.length > 200 ? `${val.slice(0, 200)}…<truncated>` : val,
      ]),
    ),
  };
  return JSON.stringify(safe, null, 2);
}

function applyToDisk(filtered) {
  fs.mkdirSync(EXPIRED_SLICES_DIR, { recursive: true });
  const summary = [];
  for (const [crawlerKey, proposals] of filtered.entries()) {
    const slicePath = path.join(EXPIRED_SLICES_DIR, `${crawlerKey}.json`);
    const existing = loadExpiredSliceFromDisk(crawlerKey);
    const merged = [...existing, ...proposals].sort((a, b) =>
      String(b.expiredAt || '').localeCompare(String(a.expiredAt || '')),
    );
    fs.writeFileSync(slicePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    summary.push({ crawlerKey, added: proposals.length, total: merged.length });
  }
  return summary;
}

/**
 * Merge backfilled slugs into data/all-known-job-slugs.json so the build
 * plugin includes them in expiredSlugs and renders soft-landing pages. Each
 * locale gets a path under its section prefix, mirroring how jobsSeoPagesPlugin
 * auto-populates tracking entries from active jobs.
 */
function applyToTracking(filtered) {
  let tracking = {};
  if (fs.existsSync(TRACKING_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') tracking = parsed;
    } catch { /* start fresh */ }
  }
  let added = 0;
  for (const proposals of filtered.values()) {
    for (const entry of proposals) {
      const slug = entry.slug;
      if (!slug || tracking[slug]) continue;
      tracking[slug] = {};
      for (const locale of LOCALE_LIST) {
        const section = SECTION_BY_LOCALE[locale];
        const prefix = LOCALE_PREFIX[locale];
        const relPath = `${prefix}/${section}/${slug}`.replace(/\/+/g, '/');
        tracking[slug][locale] = relPath;
      }
      added += 1;
    }
  }
  if (added > 0) {
    fs.writeFileSync(TRACKING_PATH, `${JSON.stringify(tracking, null, 2)}\n`, 'utf8');
  }
  return { added, total: Object.keys(tracking).length };
}

function main() {
  const args = parseArgs(process.argv);
  const auditAbs = path.resolve(args.auditPath);
  if (!fs.existsSync(auditAbs)) {
    process.stderr.write(`error: audit file not found: ${auditAbs}\n`);
    process.exit(2);
  }
  const audit = fs.readFileSync(auditAbs, 'utf8');
  const commits = parseAuditCommits(audit);
  if (commits.length === 0) {
    process.stdout.write('no commits with Class B losses found in audit\n');
    return;
  }

  process.stdout.write(`mode: ${args.apply ? 'APPLY' : 'DRY-RUN'}\n`);
  process.stdout.write(`audit: ${auditAbs}\n`);
  process.stdout.write(`commits with Class B losses: ${commits.length}\n`);
  process.stdout.write(`expected total Class B losses: ${commits.reduce((s, c) => s + c.classB, 0)}\n\n`);

  const { proposedByCrawler, perCommit, unrecoverable } = backfillFromCommits({
    commits,
    rootDir: ROOT,
    loadActiveSlugs: loadActiveSlugsForCrawler,
  });

  const proposedSummary = summarizeCounts(proposedByCrawler);
  process.stdout.write('--- recovery summary ---\n');
  process.stdout.write(`extracted total: ${proposedSummary.total}\n`);
  for (const [k, v] of Object.entries(proposedSummary.perCrawler)) {
    process.stdout.write(`  ${k}: ${v}\n`);
  }
  process.stdout.write('\n--- per-commit ---\n');
  for (const c of perCommit) {
    process.stdout.write(`  ${c.sha}  expectedB=${c.classB}  recovered=${c.recovered}\n`);
  }
  if (unrecoverable.length > 0) {
    process.stdout.write('\n--- unrecoverable ---\n');
    for (const u of unrecoverable.slice(0, 50)) {
      process.stdout.write(`  ${JSON.stringify(u)}\n`);
    }
    if (unrecoverable.length > 50) {
      process.stdout.write(`  …and ${unrecoverable.length - 50} more\n`);
    }
  }

  const { filtered, droppedDuplicates } = dedupAgainstExisting(
    proposedByCrawler,
    loadExpiredSliceFromDisk,
  );
  const filteredSummary = summarizeCounts(filtered);
  process.stdout.write('\n--- after idempotency filter ---\n');
  process.stdout.write(`new entries to write: ${filteredSummary.total}\n`);
  process.stdout.write(`already-present (skipped): ${droppedDuplicates}\n`);
  for (const [k, v] of Object.entries(filteredSummary.perCrawler)) {
    process.stdout.write(`  ${k}: +${v}\n`);
  }

  process.stdout.write('\n--- files that WOULD be modified ---\n');
  for (const k of filtered.keys()) {
    const slicePath = path.join(EXPIRED_SLICES_DIR, `${k}.json`);
    process.stdout.write(`  ${path.relative(ROOT, slicePath)}\n`);
  }

  process.stdout.write('\n--- sample entries (first 3) ---\n');
  let printed = 0;
  outer: for (const proposals of filtered.values()) {
    for (const e of proposals) {
      if (printed >= 3) break outer;
      process.stdout.write(`${formatJsonSample(e)}\n\n`);
      printed += 1;
    }
  }

  if (args.apply) {
    const written = applyToDisk(filtered);
    process.stdout.write('\n--- APPLY: wrote expired slices ---\n');
    for (const w of written) {
      process.stdout.write(`  ${w.crawlerKey}: +${w.added} (total ${w.total})\n`);
    }
    const trackingResult = applyToTracking(filtered);
    process.stdout.write(`\n--- APPLY: tracking (data/all-known-job-slugs.json) ---\n`);
    process.stdout.write(`  added ${trackingResult.added} new slug(s); total now ${trackingResult.total}\n`);
  } else {
    process.stdout.write('\n(dry-run) no files were modified. Use --apply to write.\n');
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
