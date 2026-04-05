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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const DATA_EXPIRED = path.resolve(ROOT, 'data', 'expired-jobs.json');
const DATA_ORPHAN_ENRICHED = path.resolve(ROOT, 'data', 'orphan-enriched-data.json');
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
 */
function buildActiveIndex(activeJobs) {
  const byCompanyKey = Object.create(null); // companyKey → [job]
  const allSlugSet = new Set();             // all current + previous slugs

  for (const job of activeJobs) {
    // Index by company key
    const ck = job.companyKey || normalizeCompany(job.company);
    if (ck) {
      if (!byCompanyKey[ck]) byCompanyKey[ck] = [];
      byCompanyKey[ck].push(job);
    }

    // Collect all known slugs
    if (job.slug) allSlugSet.add(job.slug);
    if (job.slugByLocale) {
      for (const s of Object.values(job.slugByLocale)) {
        if (s) allSlugSet.add(s);
      }
    }
    if (job.previousSlugs) {
      for (const s of job.previousSlugs) allSlugSet.add(s);
    }
  }

  return { byCompanyKey, allSlugSet };
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

  // Determine candidate set
  let candidates;
  if (companyKey && index.byCompanyKey[companyKey]) {
    candidates = index.byCompanyKey[companyKey];
    if (verbose) console.log(`  🔍 Company match: "${companyKey}" — ${candidates.length} candidates`);
  } else {
    // No company narrowing — use full set but require higher threshold
    candidates = activeJobs;
    if (verbose) console.log(`  🔍 No company match — scanning all ${candidates.length} jobs`);
  }

  const orphanLocale = enrichment?.locale || detectSlugLocale(orphanSlug);
  const orphanTitleTokens = enrichment?.title ? tokenizeTitle(enrichment.title) : null;

  let bestJob = null;
  let bestScore = 0;
  let bestMethod = '';
  let matchCount = 0;
  const threshold = companyKey ? 0.60 : 0.70;

  for (const job of candidates) {
    // ── Strategy A: Slug-to-slug Jaccard ──
    const allJobSlugs = [
      job.slug,
      ...(job.slugByLocale ? Object.values(job.slugByLocale) : []),
    ].filter(Boolean);

    for (const jobSlug of allJobSlugs) {
      const jobTokens = tokenizeSlug(jobSlug);
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
      for (const [locale, title] of Object.entries(job.titleByLocale)) {
        if (!title) continue;
        const jobTitleTokens = tokenizeTitle(title);
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

  // ── One-to-many guard: if multiple candidates scored above threshold, skip ──
  if (matchCount > 1 && bestJob) {
    // Re-scan to check if another job is within 0.05 of bestScore
    let closeMatches = 0;
    for (const job of candidates) {
      if (job === bestJob) continue;
      const allJobSlugs = [
        job.slug,
        ...(job.slugByLocale ? Object.values(job.slugByLocale) : []),
      ].filter(Boolean);
      for (const jobSlug of allJobSlugs) {
        const score = jaccard(orphanTokens, tokenizeSlug(jobSlug));
        if (score >= bestScore - 0.05) closeMatches++;
      }
    }
    if (closeMatches > 0) {
      if (verbose) {
        console.log(
          `  ⚠️ "${orphanSlug}" — ambiguous: ${closeMatches + 1} close matches (best: ${bestScore.toFixed(3)}), skipping`,
        );
      }
      return null;
    }
  }

  if (!bestJob) return null;

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
  // Strip company and location tokens from both slugs; remaining tokens must overlap
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
  const orphanRoleTokens = new Set([...orphanTokens].filter((t) => !stripTokens.has(t)));
  const bestJobSlugTokens = tokenizeSlug(bestJob.slug);
  const jobRoleTokens = new Set([...bestJobSlugTokens].filter((t) => !stripTokens.has(t)));

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
  const currentPreviousSlugs = bestJob.previousSlugs?.length || 0;
  if (currentPreviousSlugs > 30) {
    if (verbose) {
      console.log(
        `  ⚠️ "${orphanSlug}" — target job already has ${currentPreviousSlugs} previousSlugs (cap: 30), skipping`,
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

    // Apply merge
    if (!dryRun) {
      if (!job.previousSlugs) job.previousSlugs = [];
      job.previousSlugs.push(orphanSlug);
    }

    // Also add cross-locale slugs from enrichment if available
    if (enrichment?.slugByLocale && !dryRun) {
      for (const [, localeSlug] of Object.entries(enrichment.slugByLocale)) {
        if (localeSlug && !existingSlugs.has(localeSlug)) {
          job.previousSlugs.push(localeSlug);
          existingSlugs.add(localeSlug);
          index.allSlugSet.add(localeSlug);
        }
      }
    }

    index.allSlugSet.add(orphanSlug);
    updatedJobs.set(job.slug || job.slugByLocale?.it, job);
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

    // Cap check
    const totalAfter = (job.previousSlugs?.length || 0) + uniqueNew.length;
    if (totalAfter > 30) {
      if (verbose) {
        console.log(`  ⚠️ Would exceed previousSlugs cap (${totalAfter} > 30), skipping`);
      }
      skippedCount++;
      continue;
    }

    if (!dryRun) {
      if (!job.previousSlugs) job.previousSlugs = [];
      job.previousSlugs.push(...uniqueNew);
    }

    for (const s of uniqueNew) index.allSlugSet.add(s);
    updatedJobs.set(job.slug || job.slugByLocale?.it, job);
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
        sliceJob.previousSlugs = updatedJob.previousSlugs;
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
  if (!reconciledIds?.size || !fs.existsSync(DATA_EXPIRED_SLICES_DIR)) return;

  const files = fs.readdirSync(DATA_EXPIRED_SLICES_DIR).filter((f) => f.endsWith('.json'));
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
  const enrichedData = readJson(DATA_ORPHAN_ENRICHED, []);

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
