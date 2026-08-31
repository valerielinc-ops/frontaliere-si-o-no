#!/usr/bin/env node
/**
 * reconcile-job-slugs.mjs
 *
 * Reconciles orphan slugs (from GSC) and expired job slugs with active jobs
 * using Jaccard token similarity matching. Matched slugs are added as
 * `previousSlugs` on the active job so the build plugin generates full-content
 * pages instead of generic soft-landings.
 *
 * Goes further than `reconcileGhostExpired()` in assemble-jobs-dataset.mjs
 * (exact title+company) and `backfill-slug-aliases.mjs` (substring matching)
 * by applying token-level Jaccard similarity with company/location/role guards.
 *
 * Usage:
 *   node scripts/reconcile-job-slugs.mjs [--dry-run] [--verbose] [--max <N>]
 *
 * Flags:
 *   --dry-run   Print matches but don't write any files
 *   --verbose   Show detailed matching logs for every candidate
 *   --max <N>   Process at most N orphan slugs (for testing)
 *
 * Exports:
 *   reconcileOrphanSlugs(activeJobs, orphanSlugs, enrichedData, options)
 *   reconcileExpiredSlugs(activeJobs, expiredJobs, options)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import {
  addPreviousSlugForLocale,
  LOCALES,
  DEFAULT_PREV_SLUG_CAP,
  LEGACY_PREV_SLUGS_CAP,
} from './lib/dedicated-crawler-common.mjs';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { readOrphanEnriched } from './lib/orphan-enriched-store.mjs';
import { mergePreviousSlugsCapped } from './lib/slug-history-journal.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const DATA_EXPIRED = path.resolve(ROOT, 'data', 'expired-jobs.json');
const DATA_ORPHAN_SLUGS = path.resolve(ROOT, 'data', 'orphan-indexed-job-slugs.json');
const DATA_SLICES_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const DATA_EXPIRED_SLICES_DIR = path.resolve(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const DATA_ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

// ─── Stop words ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Italian
  'di', 'del', 'dell', 'della', 'delle', 'dei', 'degli', 'il', 'lo', 'la',
  'le', 'i', 'gli', 'un', 'uno', 'una', 'per', 'con', 'su', 'in', 'da',
  'al', 'alla', 'allo', 'alle', 'nel', 'nella', 'nello', 'nelle', 'a', 'e',
  'o', 'ed', 'che', 'tra', 'fra', 'dal',
  // English
  'the', 'an', 'of', 'for', 'at', 'on', 'to', 'and', 'or', 'with', 'by',
  // German
  'der', 'die', 'das', 'ein', 'eine', 'des', 'dem', 'den', 'fur', 'im',
  'am', 'an', 'auf', 'und', 'oder', 'mit', 'von', 'zu', 'bei', 'nach',
  'als',
  // French
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'pour', 'dans', 'en',
  'au', 'aux', 'et', 'ou', 'avec', 'par', 'sur',
]);

/** Gender markers and percentage patterns to filter from slug tokens. */
const GENDER_MARKERS = new Set(['m', 'f', 'd', 'w', 'mf', 'fm', 'mw', 'wm', 'mfd', 'mwd']);
const PCT_PATTERN = /^\d+$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Tokenize a slug string into a Set of meaningful words.
 * Splits on hyphens, removes stop words, gender markers, and numeric-only tokens.
 */
function tokenizeSlug(slug) {
  if (!slug) return new Set();
  return new Set(
    String(slug)
      .toLowerCase()
      .split('-')
      .filter(
        (w) =>
          w.length >= 2 &&
          !STOP_WORDS.has(w) &&
          !GENDER_MARKERS.has(w) &&
          !PCT_PATTERN.test(w),
      ),
  );
}

/**
 * Tokenize a title string into a Set of meaningful words.
 * Normalizes accents and punctuation before splitting.
 */
function tokenizeTitle(title) {
  if (!title) return new Set();
  const normalized = String(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  return new Set(
    normalized
      .split(/\s+/)
      .filter(
        (w) =>
          w.length >= 2 &&
          !STOP_WORDS.has(w) &&
          !GENDER_MARKERS.has(w) &&
          !PCT_PATTERN.test(w),
      ),
  );
}

/**
 * Jaccard similarity: |intersection| / |union|.
 * Returns 0 if either set is empty, 1 if both are empty.
 */
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Count of tokens shared between two sets. */
function intersectionSize(setA, setB) {
  let count = 0;
  for (const t of setA) if (setB.has(t)) count++;
  return count;
}

/**
 * Normalize a company name for matching: lowercase, remove accents,
 * collapse punctuation and whitespace to single hyphens.
 */
function normalizeCompany(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Normalize a location string for comparison. */
function normalizeLocation(loc) {
  if (!loc) return '';
  return String(loc)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim();
}

/** Check if two locations are compatible (same city or one is a substring). */
function locationsCompatible(locA, locB) {
  if (!locA || !locB) return true; // no info = no block
  const a = normalizeLocation(locA);
  const b = normalizeLocation(locB);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Check first word match (city name without region qualifier)
  const firstA = a.split(/\s+/)[0];
  const firstB = b.split(/\s+/)[0];
  return firstA.length >= 3 && firstA === firstB;
}

/**
 * Detect approximate locale of a slug from prefix tokens.
 * Falls back to 'it' (default).
 */
function detectSlugLocale(slug) {
  if (!slug) return 'it';
  const tokens = slug.split('-').slice(0, 3);
  const deIndicators = new Set(['stellvertretender', 'stellvertretende', 'leiter', 'leiterin', 'mitarbeiter', 'mitarbeiterin', 'fachspezialist', 'sachbearbeiter', 'praktikant', 'lehrling', 'suche']);
  const frIndicators = new Set(['responsable', 'collaborateur', 'collaboratrice', 'specialiste', 'technicien', 'technicienne', 'directeur', 'directrice', 'recherche', 'adjoint']);
  const enIndicators = new Set(['senior', 'junior', 'manager', 'engineer', 'developer', 'analyst', 'specialist', 'coordinator', 'assistant', 'director', 'lead', 'head', 'chief']);
  for (const t of tokens) {
    if (deIndicators.has(t)) return 'de';
    if (frIndicators.has(t)) return 'fr';
  }
  // English detection is less reliable — many EN titles appear in IT slugs
  // Only flag as EN if multiple indicators
  const enCount = tokens.filter((t) => enIndicators.has(t)).length;
  if (enCount >= 2) return 'en';
  return 'it';
}

// ─── Active Job Index ────────────────────────────────────────────────────────

/**
 * Build lookup indices from active jobs for fast candidate retrieval.
 *
 * Also pre-computes per-job slug/title TOKEN SETS so the hot scoring loop
 * in `findBestMatch` doesn't re-tokenize the same job slugs and titles on
 * every expired-job iteration. Profiled on run 26611764310: the assemble
 * step took 494 s (vs 238 s baseline 2026-05-25) — `reconcileExpiredSlugs`
 * iterates 4906 expired jobs and for each calls `findBestMatch` against
 * up to ~10 candidates × 5 slugs + 4 titles → ~270 k duplicate
 * `tokenizeSlug` / `tokenizeTitle` calls when this pre-cache is missing.
 *
 * Cache storage: WeakMap keyed by the job object — NOT a property mutation
 * on the job itself. The first iteration of this fix used `job.__cachedSlugTokens`,
 * but `assemble-jobs-dataset.mjs` writes `assembled` (the same job array we
 * cache here) back to `data/jobs.json` and `public/data/jobs.json` after
 * reconciliation when `mergedCount > 0`. `JSON.stringify(new Map())` →
 * `'{}'`, which would pollute those committed files with empty
 * `__cachedSlugTokens: {}` / `__cachedTitleTokens: {}` fields on every
 * active job. WeakMap is invisible to JSON.stringify, so the on-disk
 * output stays byte-identical to the pre-cache version.
 */
function buildActiveIndex(activeJobs) {
  const byCompanyKey = Object.create(null); // companyKey → [job]
  const allSlugSet = new Set();             // all current + previous slugs
  const slugTokenCache = new WeakMap();     // job → Map<slugString, Set<token>>
  const titleTokenCache = new WeakMap();    // job → Map<locale, Set<token>>
  // Inverted index: slug-token → Set<job>. Used by findBestMatch's
  // no-company-match path to short-circuit the all-active-jobs scan
  // (6265 → ~50-100 candidates per orphan), turning the dominant
  // `for (const job of candidates)` O(E × C × S) loop into one driven
  // by `orphanTokens.size` bucket lookups. The bucket scope mirrors
  // what the scoring loop already iterates: each job's `job.slug` +
  // every `job.slugByLocale[*]`. previousSlugs are intentionally
  // EXCLUDED — the scoring inner loop iterates the same canonical+locale
  // slug list, so widening the bucket would let pre-filtered candidates
  // pass that the scoring would still reject (wasted work, not a
  // correctness bug).
  const slugTokenToJobs = new Map();        // token → Set<job>
  // Inverted index: title-token → Set<job>. Mirrors `slugTokenToJobs`
  // but keyed on `job.titleByLocale[*]` tokens. Strategy B (title-to-title
  // cross-locale Jaccard in findBestMatch) can match a job whose
  // SLUG diverges from the orphan but whose TITLE matches across locales.
  // The slug-token bucket alone narrows by slug-overlap ≥ 2, which can
  // EXCLUDE such jobs → missed merge → expired slug stays 404 with no
  // redirect bridge → organic traffic loss. findBestMatch OR-unions this
  // bucket with the slug bucket before scoring so Strategy B always sees
  // its candidates (the 🔴 fix from issue #907).
  const titleTokenToJobs = new Map();       // token → Set<job>

  for (const job of activeJobs) {
    // Index by company key
    const ck = job.companyKey || normalizeCompany(job.company);
    if (ck) {
      if (!byCompanyKey[ck]) byCompanyKey[ck] = [];
      byCompanyKey[ck].push(job);
    }

    // Collect all known slugs. `allSlugSet` is the "already attributed to an
    // active job" guard read by findBestMatch (early-return), reconcileOrphanSlugs
    // and reconcileExpiredSlugs (the "already reconciled → skip" short-circuit).
    // It MUST include `previousSlugsByLocale`, not only the flat `previousSlugs`:
    // the publisher-supersede bridge (scripts/lib/publisher-supersede.mjs
    // bridgeSlugHistory) folds a superseded crawled job's PER-LOCALE slugs ONLY
    // into the kept publisher record's `previousSlugsByLocale[loc]` (the flat list
    // gets just the canonical slug). A per-locale-only bridged slug missing here
    // would look like an un-attributed expired/orphan slug → reconcile* could
    // re-attribute it to a DIFFERENT active job → the same indexed source URL
    // emits TWO conflicting 301s (canonical ambiguity, SEO equity loss). The
    // sibling sets reconcileGhostExpired() and trackSlugHistoryDrift()'s knownNew
    // in assemble-jobs-dataset.mjs already index previousSlugsByLocale; this keeps
    // buildActiveIndex consistent with them (follow-up #2432, supersede PR #2408).
    if (job.slug) allSlugSet.add(job.slug);
    if (job.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) {
        if (s) allSlugSet.add(s);
      }
    }
    if (job.previousSlugs) {
      for (const s of job.previousSlugs) allSlugSet.add(s);
    }
    if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
      for (const arr of Object.values(job.previousSlugsByLocale)) {
        if (Array.isArray(arr)) for (const s of arr) if (s) allSlugSet.add(s);
      }
    }

    // Pre-tokenize all slugs (canonical + locale variants) — saves
    // repeated `tokenizeSlug` calls inside `findBestMatch`. We also fold
    // every emitted token into the inverted index (`slugTokenToJobs`)
    // so the no-company-match candidate set can be derived by bucket
    // union instead of scanning all 6265 active jobs.
    const slugCache = new Map();
    const jobTokensUnion = new Set();
    const collectSlug = (s) => {
      if (!s || slugCache.has(s)) return;
      const toks = tokenizeSlug(s);
      slugCache.set(s, toks);
      for (const t of toks) jobTokensUnion.add(t);
    };
    if (job.slug) collectSlug(job.slug);
    if (job.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) collectSlug(s);
    }
    slugTokenCache.set(job, slugCache);
    // Push job into each of its union tokens' bucket. The union
    // dedup avoids duplicate inserts when several locale slugs share
    // the same token (e.g. company name appearing in every locale slug).
    for (const t of jobTokensUnion) {
      let bucket = slugTokenToJobs.get(t);
      if (!bucket) {
        bucket = new Set();
        slugTokenToJobs.set(t, bucket);
      }
      bucket.add(job);
    }

    // Pre-tokenize all titles (per-locale) — saves repeated `tokenizeTitle`
    // calls inside `findBestMatch` Strategy B (title-to-title Jaccard). We
    // also fold every emitted title token into the inverted index
    // (`titleTokenToJobs`) so Strategy B's candidate set can be derived by
    // bucket union (slug ∪ title) instead of being limited to the
    // slug-overlap ≥ 2 set, which would silently drop divergent-slug /
    // matching-title jobs.
    if (job.titleByLocale) {
      const titleCache = new Map();
      const titleTokensUnion = new Set();
      for (const [locale, title] of Object.entries(job.titleByLocale)) {
        if (!title) continue;
        const toks = tokenizeTitle(title);
        titleCache.set(locale, toks);
        for (const t of toks) titleTokensUnion.add(t);
      }
      titleTokenCache.set(job, titleCache);
      // Push job into each of its union title tokens' bucket. The union
      // dedup avoids duplicate inserts when several locales share a token.
      for (const t of titleTokensUnion) {
        let bucket = titleTokenToJobs.get(t);
        if (!bucket) {
          bucket = new Set();
          titleTokenToJobs.set(t, bucket);
        }
        bucket.add(job);
      }
    }
  }

  return {
    byCompanyKey,
    allSlugSet,
    slugTokenCache,
    titleTokenCache,
    slugTokenToJobs,
    titleTokenToJobs,
  };
}

/**
 * Load known company keys from adapter files.
 */
function loadCompanyKeys() {
  const keys = new Set();
  try {
    const files = fs.readdirSync(DATA_ADAPTERS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const adapter = readJson(path.join(DATA_ADAPTERS_DIR, f));
        if (adapter?.companyKey) keys.add(adapter.companyKey);
      } catch { /* skip malformed */ }
    }
  } catch { /* adapters dir may not exist */ }
  return keys;
}

/**
 * Try to extract a company key from a slug by matching against known company keys.
 * Returns the matched key or null.
 */
function extractCompanyFromSlug(slug, knownCompanyKeys) {
  if (!slug || knownCompanyKeys.size === 0) return null;
  // Try longest match first: scan known keys and check if the slug ends with company-location pattern
  let bestMatch = null;
  let bestLen = 0;
  for (const ck of knownCompanyKeys) {
    if (slug.includes(ck) && ck.length > bestLen) {
      bestMatch = ck;
      bestLen = ck.length;
    }
  }
  return bestMatch;
}

// ─── Matching Engine ─────────────────────────────────────────────────────────

/**
 * Find the best active-job match for an orphan slug.
 *
 * @param {string} orphanSlug
 * @param {object|null} enrichment - Enriched data for this slug (from orphan-enriched-data)
 * @param {object[]} activeJobs
 * @param {object} index - From buildActiveIndex()
 * @param {Set<string>} knownCompanyKeys
 * @param {object} options - { verbose }
 * @returns {{ job: object, score: number, method: string } | null}
 */
function findBestMatch(orphanSlug, enrichment, activeJobs, index, knownCompanyKeys, options = {}) {
  const verbose = options.verbose || false;

  // Already known?
  if (index.allSlugSet.has(orphanSlug)) {
    return null; // not orphan — already attached to an active job
  }

  const orphanTokens = tokenizeSlug(orphanSlug);
  if (orphanTokens.size < 2) {
    if (verbose) console.log(`  ⏭️ "${orphanSlug}" — too few tokens (${orphanTokens.size})`);
    return null;
  }

  // Extract company from slug or enrichment
  const enrichCompanyKey = enrichment?.companyKey || null;
  const slugCompanyKey = extractCompanyFromSlug(orphanSlug, knownCompanyKeys);
  const companyKey = enrichCompanyKey || slugCompanyKey;

  // Orphan title tokens (Strategy B). Computed before candidate selection so
  // the no-company-match branch can OR the title-token bucket into the set.
  const orphanLocale = enrichment?.locale || detectSlugLocale(orphanSlug);
  const orphanTitleTokens = enrichment?.title ? tokenizeTitle(enrichment.title) : null;

  // Determine candidate set
  let candidates;
  if (companyKey && index.byCompanyKey[companyKey]) {
    candidates = index.byCompanyKey[companyKey];
    if (verbose) console.log(`  🔍 Company match: "${companyKey}" — ${candidates.length} candidates`);
  } else if (index.slugTokenToJobs) {
    // No company narrowing — derive candidates from a UNION of two inverted
    // indices so both scoring strategies see every job they could match:
    //
    //   • Strategy A (slug-to-slug Jaccard): jobs whose union of
    //     (canonical+locale) slug tokens shares ≥ 2 tokens with
    //     `orphanTokens` — a SUPERSET of jobs that could pass the slug
    //     scoring guard (the `overlap < 2 → continue` slug guard in the
    //     scoring loop).
    //   • Strategy B (title-to-title cross-locale Jaccard): jobs whose
    //     `titleByLocale[*]` tokens share ≥ 2 tokens with the orphan's
    //     TITLE tokens. A job matchable ONLY via Strategy B can have a
    //     divergent slug (slug-overlap < 2) yet a matching cross-locale
    //     title; gating candidates on the slug bucket alone would silently
    //     drop it → missed merge → 404 with no redirect bridge (the 🔴 from
    //     issue #907). OR-ing the title bucket in fixes that.
    //
    // The union is still a SUPERSET of all jobs the scoring loop can accept,
    // so dropping a non-member only ever removes wasted score work — never a
    // correct match. Both Strategy A's `overlap < 2` slug guard and Strategy
    // B's `overlap < 2` title guard re-check inside the scoring loop, so a
    // job that enters via one bucket but matches via neither is rejected
    // there. The candidate set stays a fraction of `activeJobs.length`.
    const candidateSet = new Set();
    const slugOverlap = new Map(); // job → slug tokens-in-common count
    for (const tok of orphanTokens) {
      const bucket = index.slugTokenToJobs.get(tok);
      if (!bucket) continue;
      for (const j of bucket) {
        slugOverlap.set(j, (slugOverlap.get(j) || 0) + 1);
      }
    }
    // Slug-bucket candidates: keep the ≥ 2 slug-overlap requirement (a
    // single shared slug token can never clear Strategy A's `overlap < 2`
    // guard, so admitting it would be pure wasted work).
    for (const [j, n] of slugOverlap) {
      if (n >= 2) candidateSet.add(j);
    }
    // Title-bucket candidates: union in every job whose title tokens overlap
    // the orphan's title tokens, regardless of slug overlap. Mirrors
    // Strategy B's own `overlap < 2` title guard so we admit the same set it
    // can accept (≥ 2 shared title tokens) without re-filtering here.
    //
    // INVARIANT: slug-bucket jobs are inserted into `candidateSet` ABOVE,
    // before these title-only jobs. The scoring loop iterates candidates in
    // insertion order and `matchCount` increments only on a strict
    // `score > bestScore`, so a slug winner must establish `bestScore` before
    // any title-only candidate is scored. Reordering construction (title
    // bucket first) would let a title candidate bump `matchCount` ahead of a
    // slug winner → spuriously trip the slug ambiguity guard → dropped
    // redirect (expired slug 404 instead of bridge). Keep slug-bucket first.
    if (index.titleTokenToJobs && orphanTitleTokens && orphanTitleTokens.size >= 2) {
      const titleOverlap = new Map(); // job → title tokens-in-common count
      for (const tok of orphanTitleTokens) {
        const bucket = index.titleTokenToJobs.get(tok);
        if (!bucket) continue;
        for (const j of bucket) {
          titleOverlap.set(j, (titleOverlap.get(j) || 0) + 1);
        }
      }
      for (const [j, n] of titleOverlap) {
        if (n >= 2) candidateSet.add(j);
      }
    }
    candidates = [...candidateSet];
    if (verbose) {
      console.log(`  🔍 No company match — inverted index (slug ∪ title) narrowed to ${candidates.length} candidates (from ${activeJobs.length})`);
    }
  } else {
    // Defensive fallback for callers that built the index with a code
    // path predating the inverted-index field (older imports, tests).
    candidates = activeJobs;
    if (verbose) console.log(`  🔍 No company match — scanning all ${candidates.length} jobs (no inverted index)`);
  }

  let bestJob = null;
  let bestScore = 0;
  let bestMethod = '';
  let matchCount = 0;
  const threshold = companyKey ? 0.60 : 0.70;

  // Pull WeakMap caches off the index — `?.` fallbacks keep this defensive
  // against callers that built the index with an older code path.
  const slugTokenCache = index.slugTokenCache;
  const titleTokenCache = index.titleTokenCache;

  for (const job of candidates) {
    // ── Strategy A: Slug-to-slug Jaccard ──
    const allJobSlugs = [
      job.slug,
      ...(job.slugByLocale ? Object.values(job.slugByLocale) : []),
    ].filter(Boolean);
    const cachedSlugTokens = slugTokenCache?.get(job);

    for (const jobSlug of allJobSlugs) {
      const jobTokens = cachedSlugTokens?.get(jobSlug) ?? tokenizeSlug(jobSlug);
      const overlap = intersectionSize(orphanTokens, jobTokens);

      // Guard: require ≥ 3 meaningful tokens in common
      if (overlap < 3 && orphanTokens.size >= 4) continue;
      // For very short slugs, require ≥ 2
      if (overlap < 2) continue;

      const score = jaccard(orphanTokens, jobTokens);
      const isCrossLocale = detectSlugLocale(jobSlug) !== orphanLocale;
      const reqThreshold = isCrossLocale ? Math.max(threshold, 0.80) : threshold;

      if (score >= reqThreshold && score > bestScore) {
        bestScore = score;
        bestJob = job;
        bestMethod = isCrossLocale ? 'slug-cross-locale' : 'slug-jaccard';
        matchCount++;
      }
    }

    // ── Strategy B: Title-to-title Jaccard (cross-locale) ──
    if (orphanTitleTokens && orphanTitleTokens.size >= 3 && job.titleByLocale) {
      const cachedTitleTokens = titleTokenCache?.get(job);
      for (const [locale, title] of Object.entries(job.titleByLocale)) {
        if (!title) continue;
        const jobTitleTokens =
          cachedTitleTokens?.get(locale) ?? tokenizeTitle(title);
        if (jobTitleTokens.size < 2) continue;

        const overlap = intersectionSize(orphanTitleTokens, jobTitleTokens);
        if (overlap < 2) continue;

        const score = jaccard(orphanTitleTokens, jobTitleTokens);
        if (score >= 0.70 && score > bestScore) {
          bestScore = score;
          bestJob = job;
          bestMethod = `title-${locale}`;
          matchCount++;
        }
      }
    }
  }

  // ── One-to-many guard: if another candidate is within 0.05 of bestScore, skip ──
  //
  // The TRIGGER and AXIS are split by how the winner was matched, to add the new
  // title-axis safety WITHOUT regressing the pre-existing slug path:
  //
  //   • Slug wins (Strategy A): keep the EXACT pre-PR behavior — gate on
  //     `matchCount > 1` and re-scan on the SLUG axis. A legit slug winner
  //     (e.g. 0.90) with a near sibling (0.86) must still merge; broadening the
  //     trigger to `if (bestJob)` here would newly DROP that redirect → expired
  //     slug 404 → traffic loss on the existing slug path. A guard may only ADD
  //     skips, never remove a previously-recovered slug, so the slug path stays
  //     byte-for-byte equivalent to main.
  //
  //   • Title wins (Strategy B): run whenever there's a winner (`bestJob`), NOT
  //     only when `matchCount > 1`. Strategy B admits title-only candidates with
  //     DIVERGENT slugs, so two cross-company jobs with identical titles tie at
  //     the top score and leave `matchCount === 1` (strict `score > bestScore`
  //     never re-fires) — the `matchCount > 1` gate would let that arbitrary tie
  //     merge onto whichever job iterated first (301 to the WRONG company page).
  //     The re-scan therefore measures the TITLE axis (slug-jaccard would be ~0
  //     for divergent slugs → guard never fires → arbitrary merge of repeated
  //     cross-company titles like "Sviluppatore Software" / "Buchhalter").
  const isTitleWin = bestMethod.startsWith('title-');
  const ambiguityTriggered = isTitleWin ? !!bestJob : !!(matchCount > 1 && bestJob);
  if (ambiguityTriggered) {
    let closeMatches = 0;
    for (const job of candidates) {
      if (job === bestJob) continue;
      let jobBestScore = 0;
      if (isTitleWin) {
        // Title axis: best title-Jaccard across the candidate's locale titles.
        if (orphanTitleTokens && orphanTitleTokens.size >= 2 && job.titleByLocale) {
          const cachedTitleTokens = titleTokenCache?.get(job);
          for (const [locale, title] of Object.entries(job.titleByLocale)) {
            if (!title) continue;
            const jobTitleTokens =
              cachedTitleTokens?.get(locale) ?? tokenizeTitle(title);
            const score = jaccard(orphanTitleTokens, jobTitleTokens);
            if (score > jobBestScore) jobBestScore = score;
          }
        }
      } else {
        // Slug axis: best slug-Jaccard across the candidate's locale slugs.
        const allJobSlugs = [
          job.slug,
          ...(job.slugByLocale ? Object.values(job.slugByLocale) : []),
        ].filter(Boolean);
        const cachedSlugTokens = slugTokenCache?.get(job);
        for (const jobSlug of allJobSlugs) {
          const score = jaccard(
            orphanTokens,
            cachedSlugTokens?.get(jobSlug) ?? tokenizeSlug(jobSlug),
          );
          if (score > jobBestScore) jobBestScore = score;
        }
      }
      if (jobBestScore >= bestScore - 0.05) closeMatches++;
    }
    if (closeMatches > 0) {
      if (verbose) {
        console.log(
          `  ⚠️ "${orphanSlug}" — ambiguous: ${closeMatches + 1} close ${isTitleWin ? 'title' : 'slug'} matches (best: ${bestScore.toFixed(3)}), skipping`,
        );
      }
      return null;
    }
  }

  if (!bestJob) return null;

  // ── Title-match company guard (no-company orphan path) ──
  // A `title-*` win can pair an orphan with an active job purely on a generic
  // title-Jaccard (e.g. "Software Entwickler", "Buchhalter") with NO company
  // verification: the main company guard below only fires when the ORPHAN has a
  // companyKey, but on the no-company candidate path `companyKey` is falsy, so a
  // single active job of a DIFFERENT company could win the title match → 301 to
  // the wrong company's page. Derive any available orphan company signal and, if
  // it is known to DIFFER from the candidate's company, refuse the title merge.
  // (Slug wins are unaffected: they already carry locale-aligned slug tokens and
  // are gated by the main company guard + cross-role guard.)
  if (bestMethod.startsWith('title-') && !companyKey && bestJob.companyKey) {
    const orphanCompanyKey =
      enrichment?.companyKey ||
      (enrichment?.company ? normalizeCompany(enrichment.company) : null);
    // INTENT (issue #1010 / #971 review): when the orphan has NO company
    // signal at all (`orphanCompanyKey` falsy), the title merge is allowed to
    // proceed — we refuse ONLY when the orphan company is KNOWN to differ.
    // A same-title `title-*` win is already gated by title-Jaccard ≥ 0.70 +
    // role-overlap, so the persisted 301 lands on a same-role active listing
    // on the same aggregator: recovery vs a hard 404, net non-negative rather
    // than a misroute. Hardening this to a hard reject on unknown company
    // would re-introduce the 404 for legit recoveries and is intentionally
    // NOT done absent evidence of cross-company misroutes in production.
    if (orphanCompanyKey) {
      // Asymmetric, NOT full Jaccard: `bestJob.companyKey` is already normalized
      // and often truncated to a stem (e.g. "acme"), while the orphan company can
      // be the verbose enrichment name ("acme-solutions-ag"). Full Jaccard would
      // score "acme" vs "acme-solutions-ag" at 1/3 = 0.33 and FALSE-REJECT a
      // same-company orphan (losing the redirect → expired slug 404). Treat the
      // companies as compatible when the candidate key shares ANY token with the
      // orphan company (containment), and only refuse on a clear cross-company
      // split: both token sets non-empty AND zero overlap.
      const orphanCompanyTokens = tokenizeSlug(orphanCompanyKey);
      const jobCompanyTokens = tokenizeSlug(bestJob.companyKey);
      const sharedCompanyTokens = intersectionSize(
        orphanCompanyTokens,
        jobCompanyTokens,
      );
      if (
        orphanCompanyTokens.size > 0 &&
        jobCompanyTokens.size > 0 &&
        sharedCompanyTokens === 0
      ) {
        if (verbose) {
          console.log(
            `  ❌ "${orphanSlug}" — title-match company mismatch: "${orphanCompanyKey}" ≠ "${bestJob.companyKey}" (0 shared company tokens)`,
          );
        }
        return null;
      }
    }
  }

  // ── Company guard ──
  if (companyKey && bestJob.companyKey && companyKey !== bestJob.companyKey) {
    const companyScore = jaccard(
      tokenizeSlug(companyKey),
      tokenizeSlug(bestJob.companyKey),
    );
    if (companyScore < 0.80) {
      if (verbose) {
        console.log(
          `  ❌ "${orphanSlug}" — company mismatch: "${companyKey}" ≠ "${bestJob.companyKey}" (${companyScore.toFixed(3)})`,
        );
      }
      return null;
    }
  }

  // ── Location guard (soft) ──
  const orphanLocation = enrichment?.addressLocality || enrichment?.location || null;
  const jobLocation = bestJob.addressLocality || bestJob.location || null;
  if (orphanLocation && jobLocation && !locationsCompatible(orphanLocation, jobLocation)) {
    // Reduce score but don't block
    bestScore *= 0.85;
    if (verbose) {
      console.log(
        `  ⚠️ "${orphanSlug}" — location mismatch: "${orphanLocation}" ≠ "${jobLocation}" (score reduced to ${bestScore.toFixed(3)})`,
      );
    }
    // Re-check against threshold after penalty
    const isCrossLocale = bestMethod.includes('cross-locale');
    const reqThreshold = isCrossLocale ? 0.80 : threshold;
    if (bestScore < reqThreshold) return null;
  }

  // ── Cross-role guard ──
  // Strip company and location tokens from both sides; remaining role tokens
  // must overlap. The comparison AXIS depends on how the match was made:
  //
  //   • Slug matches (Strategy A): compare SLUG role tokens — both sides are
  //     in the same locale, so role words line up.
  //   • Title matches (Strategy B): compare TITLE role tokens, NOT slug ones.
  //     A Strategy B match is cross-locale by design (e.g. DE expired title
  //     vs IT active slug); its slugs legitimately share zero role tokens, so
  //     a slug-axis guard would false-reject exactly the merges Strategy B
  //     exists to recover (issue #907). The title-Jaccard ≥ 0.70 + overlap
  //     ≥ 2 already gate role compatibility on the correct (title) axis.
  const stripTokens = new Set();
  if (companyKey) {
    for (const t of companyKey.split('-')) {
      if (t.length >= 2) stripTokens.add(t);
    }
  }
  if (jobLocation) {
    for (const t of normalizeLocation(jobLocation).split(/\s+/)) {
      if (t.length >= 2) stripTokens.add(t);
    }
  }
  const isTitleMatch = bestMethod.startsWith('title-');
  let orphanRoleTokens;
  let jobRoleTokens;
  if (isTitleMatch) {
    // Title axis: orphan title tokens vs the matched locale's job title tokens.
    const matchedLocale = bestMethod.slice('title-'.length);
    const jobTitleTokens =
      titleTokenCache?.get(bestJob)?.get(matchedLocale) ??
      (bestJob.titleByLocale?.[matchedLocale]
        ? tokenizeTitle(bestJob.titleByLocale[matchedLocale])
        : new Set());
    orphanRoleTokens = new Set(
      [...(orphanTitleTokens ?? new Set())].filter((t) => !stripTokens.has(t)),
    );
    jobRoleTokens = new Set([...jobTitleTokens].filter((t) => !stripTokens.has(t)));
  } else {
    orphanRoleTokens = new Set([...orphanTokens].filter((t) => !stripTokens.has(t)));
    const bestJobSlugTokens = tokenizeSlug(bestJob.slug);
    jobRoleTokens = new Set([...bestJobSlugTokens].filter((t) => !stripTokens.has(t)));
  }

  if (orphanRoleTokens.size >= 2 && jobRoleTokens.size >= 2) {
    const roleOverlap = intersectionSize(orphanRoleTokens, jobRoleTokens);
    if (roleOverlap === 0) {
      if (verbose) {
        console.log(
          `  ❌ "${orphanSlug}" — cross-role guard: no role token overlap (orphan: [${[...orphanRoleTokens].join(', ')}], job: [${[...jobRoleTokens].join(', ')}])`,
        );
      }
      return null;
    }
  }

  // ── previousSlugs cap guard ──
  // Shared with dedicated-crawler-common.mjs's LEGACY_PREV_SLUGS_CAP so this
  // reconciliation path doesn't drift out of sync with the pipeline-wide
  // previousSlugs cap convention (issue #3630 sibling: this file used its
  // own hardcoded 30 while every crawler used 20/80).
  const currentPreviousSlugs = bestJob.previousSlugs?.length || 0;
  if (currentPreviousSlugs > LEGACY_PREV_SLUGS_CAP) {
    if (verbose) {
      console.log(
        `  ⚠️ "${orphanSlug}" — target job already has ${currentPreviousSlugs} previousSlugs (cap: ${LEGACY_PREV_SLUGS_CAP}), skipping`,
      );
    }
    return null;
  }

  return { job: bestJob, score: bestScore, method: bestMethod };
}

// ─── Exported: reconcileOrphanSlugs ──────────────────────────────────────────

/**
 * Reconcile orphan slugs with active jobs using Jaccard similarity matching.
 *
 * @param {object[]} activeJobs - Array of active job objects (mutated in-place)
 * @param {Array<string|object>} orphanSlugs - Raw orphan slugs (strings or {locale, path} objects)
 * @param {object[]} enrichedData - Enriched orphan data with titles, companies, locales
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.verbose=false]
 * @param {number} [options.max=Infinity]
 * @returns {{ mergedCount: number, skippedCount: number, updatedJobs: Map<string, object>, remainingOrphans: Array<string|object> }}
 */
export function reconcileOrphanSlugs(activeJobs, orphanSlugs, enrichedData, options = {}) {
  const { dryRun = false, verbose = false, max = Infinity } = options;

  if (!activeJobs?.length || !orphanSlugs?.length) {
    return { mergedCount: 0, skippedCount: 0, updatedJobs: new Map(), remainingOrphans: orphanSlugs || [] };
  }

  const index = buildActiveIndex(activeJobs);
  const knownCompanyKeys = loadCompanyKeys();

  // Build enrichment lookup: slug → enriched entry
  const enrichmentBySlug = Object.create(null);
  if (enrichedData?.length) {
    for (const entry of enrichedData) {
      if (entry.slug) enrichmentBySlug[entry.slug] = entry;
      if (entry.canonicalSlug && entry.canonicalSlug !== entry.slug) {
        enrichmentBySlug[entry.canonicalSlug] = entry;
      }
    }
  }

  let mergedCount = 0;
  let skippedCount = 0;
  const updatedJobs = new Map(); // slug → job
  const remainingOrphans = [];
  let processed = 0;

  for (const entry of orphanSlugs) {
    if (processed >= max) {
      remainingOrphans.push(entry);
      continue;
    }

    // Normalize entry to a slug string
    let orphanSlug;
    if (typeof entry === 'string') {
      orphanSlug = entry;
    } else if (entry?.path) {
      // Extract slug from path like "/cerca-lavoro-ticino/slug" or "/en/find-jobs-ticino/slug"
      const segments = entry.path.split('/').filter(Boolean);
      orphanSlug = segments[segments.length - 1] || '';
    } else {
      remainingOrphans.push(entry);
      continue;
    }

    if (!orphanSlug) {
      remainingOrphans.push(entry);
      continue;
    }

    // Skip if already known
    if (index.allSlugSet.has(orphanSlug)) {
      skippedCount++;
      continue;
    }

    processed++;
    const enrichment = enrichmentBySlug[orphanSlug] || null;

    if (verbose) console.log(`\n🔎 [${processed}] "${orphanSlug}"`);

    // Try primary slug first, then any cross-locale slugs from enrichment
    const slugsToTry = [orphanSlug];
    if (enrichment?.slugByLocale) {
      for (const locSlug of Object.values(enrichment.slugByLocale)) {
        if (locSlug && locSlug !== orphanSlug && !index.allSlugSet.has(locSlug)) {
          slugsToTry.push(locSlug);
        }
      }
    }

    let match = null;
    for (const trySlug of slugsToTry) {
      const m = findBestMatch(trySlug, enrichment, activeJobs, index, knownCompanyKeys, { verbose: verbose && trySlug === orphanSlug });
      if (m && (!match || m.score > match.score)) {
        match = m;
      }
    }

    if (!match) {
      skippedCount++;
      remainingOrphans.push(entry);
      if (verbose) console.log(`  ⏭️ No match found (tried ${slugsToTry.length} slug variants)`);
      continue;
    }

    const { job, score, method } = match;

    // Verify slug isn't already in the job's previousSlugs
    const existingSlugs = new Set([
      ...(job.slugByLocale ? Object.values(job.slugByLocale) : []),
      ...(job.previousSlugs || []),
      job.slug,
    ].filter(Boolean));

    if (existingSlugs.has(orphanSlug)) {
      skippedCount++;
      continue;
    }

    // Apply merge — journaled via the shared addPreviousSlugForLocale helper
    // (issue #3630 sibling) instead of a raw `.push()`, so this write shows
    // up in the slug-history-journal summary and previousSlugs stays synced
    // with previousSlugsByLocale rather than drifting from it.
    if (!dryRun) {
      const orphanLocale = detectSlugLocale(orphanSlug);
      addPreviousSlugForLocale(job, orphanLocale, orphanSlug, DEFAULT_PREV_SLUG_CAP, 'reconcile-job-slugs.reconcileOrphanSlugs');
    }

    // Also add cross-locale slugs from enrichment if available. Enrichment
    // entries carry a REAL locale key (unlike orphanSlug above, which is
    // detected heuristically) — use it directly instead of discarding it.
    if (enrichment?.slugByLocale && !dryRun) {
      for (const [locale, localeSlug] of Object.entries(enrichment.slugByLocale)) {
        if (localeSlug && !existingSlugs.has(localeSlug)) {
          addPreviousSlugForLocale(job, locale, localeSlug, DEFAULT_PREV_SLUG_CAP, 'reconcile-job-slugs.reconcileOrphanSlugs');
          existingSlugs.add(localeSlug);
          index.allSlugSet.add(localeSlug);
        }
      }
    }

    index.allSlugSet.add(orphanSlug);
    // Keyed by resolveJobDiffKey, not bare slug — activeJobs spans every
    // company, and two jobs sharing a computed slug would silently drop one
    // company's update from this Map (same collision class fixed in
    // scatter-jobs-to-slices.mjs for issue #3734).
    updatedJobs.set(resolveJobDiffKey(job), job);
    mergedCount++;

    const prefix = dryRun ? '⏭️ [dry-run]' : '✅';
    console.log(
      `${prefix} "${orphanSlug}" → "${job.slug || job.slugByLocale?.it}" (${job.company || 'unknown'}, score: ${score.toFixed(3)}, method: ${method})`,
    );
  }

  return { mergedCount, skippedCount, updatedJobs, remainingOrphans };
}

// ─── Exported: reconcileExpiredSlugs ─────────────────────────────────────────

/**
 * Reconcile expired job slugs with active jobs using Jaccard similarity.
 * Goes beyond the exact title+company matching in reconcileGhostExpired().
 *
 * @param {object[]} activeJobs - Array of active job objects (mutated in-place)
 * @param {object[]} expiredJobs - Array of expired job objects (mutated: matched entries removed)
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.verbose=false]
 * @param {number} [options.max=Infinity]
 * @returns {{ mergedCount: number, skippedCount: number, updatedJobs: Map<string, object>, updatedExpired: object[], reconciledIds: Set<string> }}
 */
export function reconcileExpiredSlugs(activeJobs, expiredJobs, options = {}) {
  const { dryRun = false, verbose = false, max = Infinity } = options;

  if (!activeJobs?.length || !expiredJobs?.length) {
    return { mergedCount: 0, skippedCount: 0, updatedJobs: new Map(), updatedExpired: expiredJobs || [] };
  }

  const index = buildActiveIndex(activeJobs);
  const knownCompanyKeys = loadCompanyKeys();

  let mergedCount = 0;
  let skippedCount = 0;
  const updatedJobs = new Map();
  const reconciledIds = new Set();
  let processed = 0;

  for (const ej of expiredJobs) {
    if (processed >= max) break;
    processed++;

    const expSlugs = [
      ej.slug,
      ...(ej.slugByLocale ? Object.values(ej.slugByLocale) : []),
      ...(ej.previousSlugs || []),
    ].filter(Boolean);

    // Already reconciled: slugs are known to an active job — remove from expired
    if (expSlugs.some((s) => index.allSlugSet.has(s))) {
      reconciledIds.add(ej.slug || ej.id || JSON.stringify(ej.slugByLocale));
      skippedCount++;
      continue;
    }

    // Build a pseudo-enrichment from the expired job
    const enrichment = {
      slug: ej.slug,
      companyKey: ej.companyKey || normalizeCompany(ej.company),
      title: ej.title,
      titleByLocale: ej.titleByLocale,
      locale: 'it',
      addressLocality: ej.addressLocality || ej.location,
    };

    const primarySlug = ej.slugByLocale?.it || ej.slug;
    if (verbose) console.log(`\n👻 [${processed}] expired: "${primarySlug}"`);

    // Try all locale slugs for matching (not just IT), keep the best result
    const localeSlugsToTry = [
      primarySlug,
      ...(ej.slugByLocale
        ? Object.values(ej.slugByLocale).filter((s) => s && s !== primarySlug)
        : []),
    ];

    let match = null;
    for (const trySlug of localeSlugsToTry) {
      const m = findBestMatch(trySlug, enrichment, activeJobs, index, knownCompanyKeys, { verbose: verbose && trySlug === primarySlug });
      if (m && (!match || m.score > match.score)) {
        match = m;
      }
    }

    if (!match) {
      skippedCount++;
      if (verbose) console.log(`  ⏭️ No match found for expired job (tried ${localeSlugsToTry.length} locale slugs)`);
      continue;
    }

    const { job, score, method } = match;

    // Collect all slugs from the expired entry to merge
    const existingSlugs = new Set([
      ...(job.slugByLocale ? Object.values(job.slugByLocale) : []),
      ...(job.previousSlugs || []),
      job.slug,
    ].filter(Boolean));

    const newSlugs = expSlugs.filter((s) => s && !existingSlugs.has(s));
    const uniqueNew = [...new Set(newSlugs)];

    if (uniqueNew.length === 0) {
      skippedCount++;
      continue;
    }

    // Cap check — shared LEGACY_PREV_SLUGS_CAP, not a locally hardcoded 30
    // (issue #3630 sibling: this file's own cap had drifted from the
    // pipeline-wide convention used everywhere else).
    const totalAfter = (job.previousSlugs?.length || 0) + uniqueNew.length;
    if (totalAfter > LEGACY_PREV_SLUGS_CAP) {
      if (verbose) {
        console.log(`  ⚠️ Would exceed previousSlugs cap (${totalAfter} > ${LEGACY_PREV_SLUGS_CAP}), skipping`);
      }
      skippedCount++;
      continue;
    }

    if (!dryRun) {
      // Journaled via addPreviousSlugForLocale (issue #3630 sibling) instead
      // of a raw `.push(...uniqueNew)` — keeps previousSlugsByLocale synced
      // and makes the write visible in the slug-history-journal summary.
      // slugByLocale entries carry a real locale key; anything else
      // (ej.slug, ej.previousSlugs) falls back to heuristic detection.
      const slugLocaleMap = new Map();
      if (ej.slugByLocale) {
        for (const [locale, s] of Object.entries(ej.slugByLocale)) {
          if (s) slugLocaleMap.set(s, locale);
        }
      }
      for (const s of uniqueNew) {
        const locale = slugLocaleMap.get(s) || detectSlugLocale(s);
        addPreviousSlugForLocale(job, locale, s, DEFAULT_PREV_SLUG_CAP, 'reconcile-job-slugs.reconcileExpiredSlugs');
      }
    }

    for (const s of uniqueNew) index.allSlugSet.add(s);
    updatedJobs.set(resolveJobDiffKey(job), job);
    reconciledIds.add(ej.slug || ej.id || JSON.stringify(ej.slugByLocale));
    mergedCount++;

    const prefix = dryRun ? '⏭️ [dry-run]' : '✅';
    console.log(
      `${prefix} expired "${primarySlug}" → "${job.slug || job.slugByLocale?.it}" (${job.company || 'unknown'}, score: ${score.toFixed(3)}, method: ${method}, +${uniqueNew.length} slugs)`,
    );
  }

  // Remove reconciled entries from expired list
  const updatedExpired = dryRun
    ? expiredJobs
    : expiredJobs.filter((ej) => {
        const id = ej.slug || ej.id || JSON.stringify(ej.slugByLocale);
        return !reconciledIds.has(id);
      });

  return { mergedCount, skippedCount, updatedJobs, updatedExpired, reconciledIds };
}

// ─── Per-Crawler Slice Updater ───────────────────────────────────────────────

/**
 * Update per-crawler slice files for all modified jobs.
 * @param {Map<string, object>} updatedJobs - slug → job (must have companyKey)
 */
function updateCrawlerSlices(updatedJobs) {
  // Group jobs by companyKey
  const byCompany = Object.create(null);
  for (const job of updatedJobs.values()) {
    const ck = job.companyKey;
    if (!ck) continue;
    if (!byCompany[ck]) byCompany[ck] = [];
    byCompany[ck].push(job);
  }

  for (const [ck, jobs] of Object.entries(byCompany)) {
    const slicePath = path.join(DATA_SLICES_DIR, `${ck}.json`);
    if (!fs.existsSync(slicePath)) continue;

    const slice = readJson(slicePath);
    if (!slice?.jobs) continue;

    let modified = false;
    for (const updatedJob of jobs) {
      // Find the matching job in the slice
      const sliceJob = slice.jobs.find(
        (sj) =>
          sj.slug === updatedJob.slug ||
          (sj.slugByLocale?.it && sj.slugByLocale.it === updatedJob.slugByLocale?.it),
      );
      if (sliceJob) {
        // Merge, don't overwrite (issue #3630 sibling): updatedJob comes
        // from data/jobs.json, a snapshot that can be stale relative to the
        // live crawler slice — a dedicated crawler run after that snapshot
        // was taken may have captured slice-only previousSlugs entries.
        // Overwriting the slice's array wholesale silently discarded those.
        const mergedFlat = mergePreviousSlugsCapped(sliceJob.previousSlugs, updatedJob.previousSlugs, {
          jobId: sliceJob.id || updatedJob.id,
          source: 'reconcile-job-slugs.updateCrawlerSlices',
          cap: LEGACY_PREV_SLUGS_CAP,
        });
        if (mergedFlat.length > 0) sliceJob.previousSlugs = mergedFlat;
        else delete sliceJob.previousSlugs;

        if (updatedJob.previousSlugsByLocale) {
          if (!sliceJob.previousSlugsByLocale) sliceJob.previousSlugsByLocale = {};
          for (const locale of LOCALES) {
            const a = sliceJob.previousSlugsByLocale[locale] || [];
            const b = updatedJob.previousSlugsByLocale[locale] || [];
            if (a.length === 0 && b.length === 0) continue;
            const union = [...new Set([...a, ...b])];
            sliceJob.previousSlugsByLocale[locale] =
              union.length > DEFAULT_PREV_SLUG_CAP ? union.slice(-DEFAULT_PREV_SLUG_CAP) : union;
          }
        }
        modified = true;
      }
    }

    if (modified) {
      writeJson(slicePath, slice);
      console.log(`💾 Updated slice: ${ck}.json`);
    }
  }
}

// ─── Expired Per-Crawler Slice Updater ───────────────────────────────────────

/**
 * Remove reconciled entries from expired per-crawler slice files.
 * Without this, reconciled expired jobs reappear on next assembleExpiredJobs().
 * @param {Set<string>} reconciledIds - IDs of expired entries that were reconciled
 */
function updateExpiredCrawlerSlices(reconciledIds) {
  if (!reconciledIds?.size) return;

  const files = listSliceFileNames(DATA_EXPIRED_SLICES_DIR);
  let totalRemoved = 0;

  for (const file of files) {
    const slicePath = path.join(DATA_EXPIRED_SLICES_DIR, file);
    const entries = readJson(slicePath, []);
    if (!Array.isArray(entries) || entries.length === 0) continue;

    const filtered = entries.filter((ej) => {
      const id = ej.slug || ej.id || JSON.stringify(ej.slugByLocale);
      return !reconciledIds.has(id);
    });

    const removed = entries.length - filtered.length;
    if (removed > 0) {
      writeJson(slicePath, filtered);
      totalRemoved += removed;
      console.log(`💾 Updated expired slice: ${file} (removed ${removed} reconciled)`);
    }
  }

  if (totalRemoved > 0) {
    console.log(`🗑️  Removed ${totalRemoved} reconciled entries from expired slices`);
  }
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const maxIdx = args.indexOf('--max');
  const max = maxIdx !== -1 && args[maxIdx + 1] ? Number(args[maxIdx + 1]) : Infinity;

  console.log('🔄 Reconcile Job Slugs');
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Verbose: ${verbose ? 'ON' : 'OFF'}`);
  if (max !== Infinity) console.log(`   Max orphans: ${max}`);
  console.log('');

  // ── Load data ──
  const activeJobs = readJson(DATA_JOBS, []);
  const expiredJobs = readJson(DATA_EXPIRED, []);
  const orphanSlugs = readJson(DATA_ORPHAN_SLUGS, []);
  // Sharded under data/orphan-enriched-data/ (#4248) — the monolith crossed
  // GitHub's 100 MB per-blob push limit and blocked every sync push.
  const enrichedData = readOrphanEnriched(ROOT);

  console.log(`📊 Loaded: ${activeJobs.length} active, ${expiredJobs.length} expired, ${orphanSlugs.length} orphan slugs, ${enrichedData.length} enriched entries`);
  console.log('');

  // ── Phase 1: Reconcile expired slugs ──
  console.log('═══ Phase 1: Expired → Active ═══');
  const expiredResult = reconcileExpiredSlugs(activeJobs, expiredJobs, { dryRun, verbose, max });

  console.log('');
  console.log(`📈 Expired reconciliation: ${expiredResult.mergedCount} merged, ${expiredResult.skippedCount} skipped`);
  console.log('');

  // ── Phase 2: Reconcile orphan slugs ──
  console.log('═══ Phase 2: Orphan → Active ═══');
  const orphanResult = reconcileOrphanSlugs(activeJobs, orphanSlugs, enrichedData, { dryRun, verbose, max });

  console.log('');
  console.log(`📈 Orphan reconciliation: ${orphanResult.mergedCount} merged, ${orphanResult.skippedCount} skipped`);
  console.log('');

  // ── Write results ──
  if (!dryRun) {
    const allUpdatedJobs = new Map([
      ...expiredResult.updatedJobs,
      ...orphanResult.updatedJobs,
    ]);

    const hasExpiredCleanup = expiredResult.reconciledIds?.size > 0;

    if (allUpdatedJobs.size > 0 || hasExpiredCleanup) {
      if (allUpdatedJobs.size > 0) {
        // Write active jobs (only if previousSlugs changed)
        writeJson(DATA_JOBS, activeJobs);
        writeJson(PUBLIC_JOBS, activeJobs);
        console.log(`💾 Wrote ${DATA_JOBS} and ${PUBLIC_JOBS}`);

        // Update per-crawler slices
        updateCrawlerSlices(allUpdatedJobs);

        // Write remaining orphan slugs
        writeJson(DATA_ORPHAN_SLUGS, orphanResult.remainingOrphans);
        console.log(`💾 Wrote ${DATA_ORPHAN_SLUGS} (${orphanResult.remainingOrphans.length} remaining)`);
      }

      // Write expired jobs (with reconciled entries removed)
      writeJson(DATA_EXPIRED, expiredResult.updatedExpired);
      console.log(`💾 Wrote ${DATA_EXPIRED} (${expiredResult.updatedExpired.length} remaining)`);

      // Remove reconciled entries from expired per-crawler slices
      updateExpiredCrawlerSlices(expiredResult.reconciledIds);
    } else {
      console.log('ℹ️  No changes — all files untouched');
    }
  }

  // ── Summary ──
  console.log('');
  console.log('═══ Summary ═══');
  console.log(`  Expired: ${expiredResult.mergedCount} merged, ${expiredResult.skippedCount} skipped`);
  console.log(`  Orphans: ${orphanResult.mergedCount} merged, ${orphanResult.skippedCount} skipped, ${orphanResult.remainingOrphans.length} remaining`);
  console.log(`  Total merged: ${expiredResult.mergedCount + orphanResult.mergedCount}`);
  console.log(`  Jobs updated: ${new Map([...expiredResult.updatedJobs, ...orphanResult.updatedJobs]).size}`);
  console.log('');
}
