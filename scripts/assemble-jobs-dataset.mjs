#!/usr/bin/env node
/**
 * scripts/assemble-jobs-dataset.mjs
 *
 * Assembles the global jobs artifacts from per-crawler slice files.
 *
 * Source directories (written by each migrated crawler):
 *   data/jobs/by-crawler/<key>.json
 *     → { crawlerKey, assembledAt, jobs: [...] }
 *   data/jobs-crawler-summaries/by-crawler/<key>.json
 *     → summary entry ({ key, label, generatedAt, total, ... })
 *
 * Assembled outputs (consumed by runtime/build — unchanged interface):
 *   data/jobs.json
 *   public/data/jobs.json
 *   data/jobs-crawler-summaries.json
 *
 * Merge rules:
 *   1. Stable identity: url → id/externalId → slug → title+company+location fallback.
 *   2. When the same identity appears in multiple slices, the slice with the
 *      newest `assembledAt` timestamp wins (last-write wins).
 *   3. Final sort: descending postedDate, then ascending stable identity for ties.
 *
 * Usage:
 *   node scripts/assemble-jobs-dataset.mjs              # assemble only
 *   node scripts/assemble-jobs-dataset.mjs --stats      # assemble + regenerate stats
 *
 * Module API (for crawlers):
 *   writeJobsCrawlerSlice(crawlerKey, jobs)    → write data/jobs/by-crawler/<key>.json
 *   writeSummaryCrawlerSlice(summaryEntry)     → write data/jobs-crawler-summaries/by-crawler/<key>.json
 *   assembleJobsDataset({ withStats? })        → run full assembly
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSliceFilePaths } from './lib/crawler-slice-files.mjs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createEmptyCrawlerSummaryStore,
  readCrawlerSummaryStore,
  writeCrawlerSummaryStore,
} from './lib/crawler-summary-store.mjs';
import { buildAssembledJobIdentity, buildStableJobIdentity } from './lib/job-identity.mjs';
import { carryForwardMarks, dedupeByIdentityPreservingMarks } from './lib/job-mark-persistence.mjs';
import { supersedeCrawledByPublisher } from './lib/publisher-supersede.mjs';
import { hardenJobsWithStructuredSalary } from './lib/structured-salary.mjs';
import { normalizeDescriptionBullets, cleanCrawlerArtifacts, restoreExistingSlugIdentity } from './lib/crawler-template.mjs';
import { computeCrawlerQualityAggregate, computeJobQualityScore, buildStableId, cleanPreviousSlugsPerLocale, isLocationExplicitlyForeign, healTruncatedStLocalities, addPreviousSlugForLocale, captureLostSlugs, DEFAULT_PREV_SLUG_CAP, stableSlugHash, appendSlugDisambiguator } from './lib/dedicated-crawler-common.mjs';
import { inferAnyCanton, isKnownSwissCity, isCantonOnlyLabel, swissCityFromLocationField, rescueSwissCityFromText, isTargetCanton, TARGET_CANTONS } from './lib/target-swiss-locations.mjs';
import { getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { filterFixtureJobs } from './lib/fixture-data-filter.mjs';
import { SWISS_LOCALITY_SENTENCE_SPLIT_RX } from './lib/swiss-locality-sentence-split.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { readOrphanEnriched } from './lib/orphan-enriched-store.mjs';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Summary guard — ensures every crawler writes a summary on exit ──── */

let _summaryWritten = false;

/**
 * Register a process-exit guard that writes a minimal summary if the crawler
 * exits (via early return, process.exit, or uncaught error) before calling
 * writeSummaryCrawlerSlice().
 *
 * Call this once at the top of main() in each crawler script.
 *
 * @param {string} key   - Crawler key (same as COMPANY_KEY)
 * @param {string} label - Human-readable label (company name)
 * @param {{discovered?: number|null}|null} [counts] - Optional mutable
 *   counter the crawler updates as it discovers candidates (issue #5945):
 *   `counts.discovered` set right after the pre-filter fetch lets an early
 *   return (e.g. "0 Swiss jobs after filtering") report a non-zero
 *   `discovered` count, so `check-crawler-health.mjs` can tell "filtered"
 *   from "broken" without a human verifying the source live. Omit when the
 *   crawler hasn't been instrumented — behaviour is unchanged.
 */
export function registerCrawlerSummaryGuard(key, label, counts = null) {
  process.on('exit', (code) => {
    if (_summaryWritten) return;
    try {
      const discovered =
        counts && Number.isFinite(counts.discovered) ? counts.discovered : null;
      writeSummaryCrawlerSlice({
        key,
        label: label || key,
        generatedAt: new Date().toISOString(),
        total: 0,
        discovered,
        written: 0,
        newCount: 0,
        updatedCount: 0,
        removedCount: 0,
        unchangedCount: 0,
        newJobs: [],
        updatedJobs: [],
        removedJobs: [],
        unchangedJobs: [],
        earlyExit: true,
        exitCode: code,
      });
    } catch { /* best-effort — process is exiting */ }

    // Also write GH Actions step summary
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      const status = code === 0 ? '⚠️ Uscita anticipata' : `❌ Errore (exit ${code})`;
      try {
        fs.appendFileSync(summaryFile,
          `\n## 📋 Riepilogo crawler — ${label || key}\n\n` +
          `${status} — nessun riepilogo dettagliato disponibile.\n`);
      } catch { /* non-blocking */ }
    }
  });
}

/**
 * Defensive sanitizer for the `location` / `addressLocality` field.
 *
 * Many per-crawler parsers extract the city by stripping the "Location"
 * label from a node's textContent — but when the source page inlines
 * "Location: Ticino, Switzerland.Availability to work…" mid-paragraph
 * (no newline), that strategy returns the entire paragraph tail as the
 * city. The corrupted value then leaks into the slug, the canton, and
 * the <title> tag downstream.
 *
 * Rules (mirror scripts/lib/alten-job-parser.mjs):
 *   1. Strip a leading "Location" label, optional `:` / `.`, and whitespace.
 *   2. Cut at the first sentence boundary (`;`, newline, or a sentence-ending
 *      `.`) — but NOT a period that belongs to a "St."/"Ste." abbreviation in
 *      a Swiss city name. Splitting on every `.` truncated "St. Moritz" →
 *      "St" / "St. Gallen" → "St", which then failed the Swiss-municipality
 *      whitelist below and silently dropped every job for those employers.
 *   3. Strip a leading `:` / whitespace left over from `Location:Ticino`.
 *   4. Trim.
 *   5. If the value still smells like prose (>60 char OR contains tell-tale
 *      body-content keywords), fall back to the job's OWN canton label.
 *
 * On (5) and on the empty/"undefined" guard the fallback used to be the literal
 * `'Ticino'` — written when by-crawler files really were Ticino-only. The funnel
 * now serves all 26 cantons, so that constant silently relabels a Nidwalden or
 * Bern posting as Ticino: `inferAnyCanton('Ticino')` then returns TI, the canton
 * field flips, the job is emitted under `/cerca-lavoro-ticino/`, ships
 * `addressRegion:"TI"` in its JobPosting (AGENTS.md Non-Negotiable #3) and
 * pollutes the single query that carries most of the organic traffic. Callers
 * therefore pass the job's own canton label (`cantonFallbackLocality`), and the
 * bare `'Ticino'` survives only where there is genuinely no canton on record.
 *
 * @param {unknown} rawValue
 * @param {string} [fallbackLocality='Ticino'] locality to use when the value
 *   carries no usable city — derive it from the job's canton, never hardcode.
 */
function sanitizeJobLocationField(rawValue, fallbackLocality = 'Ticino') {
  if (typeof rawValue !== 'string') return rawValue;
  const original = rawValue;
  const fallback = String(fallbackLocality || '').trim() || 'Ticino';
  // A detail parser that returns the literal string "undefined"/"null" (or an
  // empty/whitespace value) slips past every `|| fallback` (truthy) and would
  // become `addressLocality: "undefined"` → Google rejects the JobPosting
  // structured data → de-index (AGENTS.md non-negotiable #3). Issue #900.
  const trimmedOriginal = original.trim();
  if (trimmedOriginal === '' || /^(undefined|null)$/i.test(trimmedOriginal)) {
    return fallback;
  }
  let s = original
    .replace(/^.*?Location\s*[:.]?\s*/i, '')
    // Sentence-boundary cut that preserves "St."/"Ste." abbreviation periods
    // in Swiss city names (St. Moritz, St. Gallen, Ste. Croix). The negative
    // lookbehind keeps the period when it directly follows a "St"/"Ste" token;
    // prose still cuts on every other period (e.g. "…Switzerland.Availability").
    // Shared with alten-job-parser.mjs — see swiss-locality-sentence-split.mjs.
    .split(SWISS_LOCALITY_SENTENCE_SPLIT_RX)[0]
    .replace(/^[\s:]+/, '')
    .trim();
  if (s.length > 60 || /\b(availability|offer you|requirements|inspektionen|home ?office|company address|posizione esclusivamente|ottima conoscenza|befristet)\b/i.test(s)) {
    return fallback;
  }
  return s === '' ? original : s;
}

/**
 * Locality label to use when a job's own location text is unusable.
 *
 * Returns the Italian display name of the job's canton ("NW" → "Nidvaldo"), so
 * the placeholder agrees with the canton the crawler recorded instead of
 * contradicting it. Falls back to `'Ticino'` only for a job with no canton at
 * all — there the funnel's primary canton is the historical default and the
 * canton fill/pin logic downstream is what decides the real section.
 *
 * @param {object} job
 * @returns {string}
 */
export function cantonFallbackLocality(job) {
  const code = String(job?.canton || '').toUpperCase().trim();
  if (!code) return 'Ticino';
  const label = getCantonDisplayName(code, 'it');
  return label && label !== code ? label : 'Ticino';
}

/**
 * Re-label a canton-ONLY locality that names a canton the job is not in.
 *
 * A locality like "Ticino" is not a municipality — it is the canton's own name
 * standing in for a city, produced by `safeLocationToken`'s default fallback,
 * by a publisher intake field, or by a parser that scraped the region label.
 * `isWeakCantonOnlyLabelOverride` (#4570) already stops such a label flipping
 * the job's `canton`, and `resolveCantonAgainstPin` stops a stale pin doing the
 * same — but the string itself survives into `addressLocality`, so a Solothurn
 * or Nidwalden posting still ships `jobLocation.address.addressLocality:
 * "Ticino"` in its JobPosting (AGENTS.md Non-Negotiable #3 — jobLocation must
 * be correct, in every locale) and reads as a Ticino job to anyone scanning the
 * card. 111 live records carried this shape.
 *
 * Rewrites the label to the job's OWN canton name; leaves real city names, and
 * labels that already agree with the job's canton, untouched.
 *
 * @param {string} value current locality string
 * @param {string} canton job's canton code
 * @returns {string} the value, or the job's canton label when the value names a
 *   different canton
 */
export function realignCantonOnlyLocality(value, canton) {
  const s = String(value ?? '').trim();
  const code = String(canton || '').toUpperCase().trim();
  if (!s || !code) return value;
  if (!isCantonOnlyLabel(s)) return value;
  if (inferAnyCanton(s) === code) return value;
  const label = getCantonDisplayName(code, 'it');
  return label && label !== code ? label : value;
}

/**
 * Repair a `company` value that is actually a slice of the job DESCRIPTION.
 *
 * The extraction bug that produced these was fixed upstream on 2026-07-27
 * (`looksLikeShortLabelValue` in scripts/lib/shared-jobs-crawler.mjs, #4810),
 * but records crawled before that keep the bad value forever: a job is only
 * rewritten when it is re-crawled, and `company` feeds the job page's
 * structured-data `hiringOrganization.name` (AGENTS.md Non-Negotiable #3) plus
 * the newsletter/job-alert context. This is the persist-time net that repairs
 * them and stops the same class returning through any of the ~80 other parsers.
 *
 * Deliberately LOOSER than `looksLikeShortLabelValue`: that one filters a
 * risky extraction branch and may safely reject a real name (another branch
 * then supplies it), whereas here a false positive would discard a genuine
 * employer. Verified against the live dataset: flags all 37 corrupted records
 * and none of "asana Spital AG (Menziken / Leuggern)",
 * "tl (Transports publics de la région lausannoise)" or
 * "KSML — Kantonaler Stellenmarkt für Lehrerinnen und Lehrer (Kanton Bern)".
 *
 * @param {string} rawValue
 * @param {string} [fallback] display name to use when the value is prose
 * @returns {string} the original value, or the fallback when it was prose
 */
export function sanitizeJobCompanyField(rawValue, fallback = '') {
  const s = String(rawValue ?? '').trim();
  if (!s) return fallback || s;
  // Control / bidi / zero-width characters never belong in an employer name.
  if (/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(s)) return fallback || '';
  // Short values are names, however oddly cased ("tl", "asana Spital AG").
  if (s.length <= 60) return s;
  const startsMidSentence = /^[^\p{Lu}\p{N}]/u.test(s);
  const hasSentenceBreak = /[.;]\s+\p{Ll}/u.test(s);
  if (startsMidSentence || hasSentenceBreak) return fallback || '';
  return s;
}

/**
 * Strip a markdown bold wrapper that the translation pipeline left around a
 * WHOLE job title: `**Partner Comercial de Recursos Humanos**` → the title.
 *
 * Deliberately the narrowest rule that fixes the observed defect, because
 * asterisks in a job title are usually REAL CONTENT and removing them
 * corrupts an employer's own wording:
 *
 *   - `Verkaufsberater:in ***delicatessa 40-60% (w/m/d)` — Globus brands its
 *     food hall `***delicatessa`. Verified on the employer's page, where it
 *     appears 12 times including `<title>` and `og:title`.
 *   - `Verkäufer*in`, `Mitarbeiter*in` — the German gender star, a single `*`
 *     that must never be touched.
 *   - `Un chargé ou une chargée de communication ***` — trailing source
 *     decoration, left alone: it is what the employer published.
 *
 * So the wrapper is stripped ONLY when the entire trimmed title opens with
 * `**`, closes with `**`, and carries no other asterisk in between — the one
 * shape that cannot be anything but markdown.
 */
export function sanitizeJobTitleField(rawValue) {
  const s = String(rawValue ?? '');
  const t = s.trim();
  if (t.length < 5 || !t.startsWith('**') || !t.endsWith('**')) return s;
  const inner = t.slice(2, -2).trim();
  if (!inner || inner.includes('*')) return s;
  return inner;
}

/** Apply {@link sanitizeJobTitleField} to `title` and every `titleByLocale`. */
function sanitizeJobTitlesInPlace(job) {
  let fixed = 0;
  if (typeof job.title === 'string') {
    const cleaned = sanitizeJobTitleField(job.title);
    if (cleaned !== job.title) { job.title = cleaned; fixed++; }
  }
  if (job.titleByLocale && typeof job.titleByLocale === 'object') {
    for (const [loc, v] of Object.entries(job.titleByLocale)) {
      if (typeof v !== 'string') continue;
      const cleaned = sanitizeJobTitleField(v);
      if (cleaned !== v) { job.titleByLocale[loc] = cleaned; fixed++; }
    }
  }
  return fixed;
}

/** "zurich-insurance-sede-ticino" → "Zurich Insurance Sede Ticino". */
function humanizeCompanyKey(key) {
  return String(key || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Upstream normalization applied to every crawler slice BEFORE it is written
 * to disk (the single funnel `writeJobsCrawlerSlice`). This moves location
 * hardening to write-time so corrupted `location` strings never reach the
 * assemble-time Swiss-municipality whitelist — the biggest source of dropped
 * jobs. It also backfills SAFE, non-forged metadata defaults required by the
 * JobPosting structured-data contract.
 *
 * Idempotent and additive:
 *   - `location` / `addressLocality` run through `sanitizeJobLocationField`
 *     (same logic as the assemble-time safety net, so that net becomes a
 *     no-op for slices written after this change).
 *   - `addressLocality` is backfilled from the (sanitized) `location`.
 *   - `addressRegion` defaults to the canton code.
 *
 * Deliberately does NOT invent `postalCode` or `streetAddress`: forging an HQ
 * postal code is exactly what slipped foreign jobs past the whitelist (the
 * Swatch incident). Postal-code enrichment stays in the assembler, where it is
 * derived from a city table rather than guessed. Job `id` backfill likewise
 * stays in the assembler (`buildStableId`) to avoid a second, divergent id
 * formula.
 *
 * Also deliberately does NOT default `addressCountry` / `country` to 'CH'
 * when absent (#5384): an undeclared country and a declared-Swiss one are
 * different pieces of evidence, and stamping the former as the latter at
 * persist time destroys that distinction at rest — it is unrecoverable once
 * the source listing expires (see #5380, where 898 already-expired jobs could
 * no longer be re-checked because the original absence had been overwritten).
 * The "if undeclared, treat as CH" assumption belongs at the point of
 * consumption (`job.addressCountry || 'CH'`), where it is a local, reversible
 * read-time choice, not a persisted assertion.
 *
 * @param {object[]} jobs jobs about to be persisted in a slice (mutated in place)
 * @returns {{ locationFixed: number, localityBackfilled: number, regionDefaulted: number }}
 */
export function normalizeParsedJobsForSlice(jobs) {
  let locationFixed = 0;
  let companyFixed = 0;
  let localityBackfilled = 0;
  let regionDefaulted = 0;
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;

    const localityFallback = cantonFallbackLocality(job);

    if (typeof job.location === 'string') {
      const cleaned = realignCantonOnlyLocality(
        sanitizeJobLocationField(job.location, localityFallback),
        job.canton,
      );
      if (cleaned !== job.location) {
        job.location = cleaned;
        locationFixed++;
      }
    }

    if (typeof job.company === 'string') {
      const cleanedCompany = sanitizeJobCompanyField(job.company, humanizeCompanyKey(job.companyKey));
      if (cleanedCompany !== job.company) {
        job.company = cleanedCompany;
        companyFixed++;
      }
    }

    sanitizeJobTitlesInPlace(job);
    // Guard on .trim(): an empty/whitespace addressLocality is `typeof string`
    // but carries no city, so it must fall through to the backfill branch
    // rather than persisting an empty locality (which propagates to
    // deriveCanton/deriveStreetAddress lookups that key on addressLocality).
    if (typeof job.addressLocality === 'string' && job.addressLocality.trim()) {
      const cleanedAddr = realignCantonOnlyLocality(
        sanitizeJobLocationField(job.addressLocality, localityFallback),
        job.canton,
      );
      if (cleanedAddr !== job.addressLocality) job.addressLocality = cleanedAddr;
    } else if (!String(job.addressLocality || '').trim() && typeof job.location === 'string' && job.location.trim()) {
      job.addressLocality = job.location;
      localityBackfilled++;
    }

    if (!job.addressRegion && job.canton) {
      job.addressRegion = String(job.canton).toUpperCase();
      regionDefaulted++;
    }
  }
  return { locationFixed, localityBackfilled, regionDefaulted };
}

function assemblerIdentity(job = {}) {
  return buildAssembledJobIdentity(job);
}

/**
 * Cross-job per-locale slug collision guard.
 *
 * The IT base slug (`job.slug`) is the natural owner of its (canton, slug)
 * tuple across all locales. When another job's translated locale slug
 * (`slugByLocale.en/de/fr`) coincides with someone else's IT base in the
 * same canton, that route already belongs to the base-slug owner. Resolve the
 * collision immediately with this job's stable suffix. The colliding route
 * must NEVER be recorded in `previousSlugs`: a bridge would claim another
 * live job's canonical route and is cross-job history contamination (#6784).
 *
 * A slug collision is not reliable evidence that the translated title is
 * wrong. Common retail/clinical titles routinely collide across independent
 * postings, and deterministic translation regenerates the same value. Stable
 * disambiguation preserves the useful title while making the route unique on
 * the first pass, without a delete/retranslate/bridge cycle.
 *
 * Pure: mutates the passed jobs in-place AND returns a report. Exported so
 * the gate has a unit-testable surface independent of the assembler IO.
 *
 * @param {Array<object>} jobs jobs already deduped by IT base slug
 * @returns {{ count: number, details: string[] }}
 */
export function applyPerLocaleSlugCollisionGuard(jobs) {
  const baseSlugOwners = new Map();
  for (const job of jobs) {
    const baseSlug = String(job?.slug || '').trim();
    if (!baseSlug) continue;
    const canton = String(job?.canton || 'TI').toUpperCase();
    const key = `${canton}|${baseSlug}`;
    if (!baseSlugOwners.has(key)) baseSlugOwners.set(key, assemblerIdentity(job));
  }
  let count = 0;
  const details = [];
  for (const job of jobs) {
    if (!job?.slugByLocale || typeof job.slugByLocale !== 'object') continue;
    const myId = assemblerIdentity(job);
    const myBaseSlug = String(job.slug || '').trim();
    const canton = String(job.canton || 'TI').toUpperCase();
    for (const locale of ['en', 'de', 'fr']) {
      const slug = String(job.slugByLocale[locale] || '').trim();
      if (!slug || slug === myBaseSlug) continue;
      const owner = baseSlugOwners.get(`${canton}|${slug}`);
      if (!owner || owner === myId) continue;

      const disambiguator = stableSlugHash(job) || String(job.id || '').slice(-6) || 'dup';
      job.slugByLocale[locale] = appendSlugDisambiguator(slug, disambiguator);
      count++;
      if (details.length < 10) {
        details.push(`${canton}/${locale}/${slug}: ${myId} → owned by ${owner} (disambiguated)`);
      }
    }
  }
  return { count, details };
}
const ROOT = path.resolve(__dirname, '..');

const JOBS_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const SUMMARIES_SLICES_DIR = path.join(ROOT, 'data', 'jobs-crawler-summaries', 'by-crawler');

const DATA_JOBS = path.join(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.join(ROOT, 'public', 'data', 'jobs.json');
const DATA_EXPIRED = path.join(ROOT, 'data', 'expired-jobs.json');
const PUBLIC_EXPIRED = path.join(ROOT, 'public', 'data', 'expired-jobs.json');
const DATA_META = path.join(ROOT, 'data', 'jobs-meta.json');
const DATA_SUMMARIES = path.join(ROOT, 'data', 'jobs-crawler-summaries.json');

/** Maximum number of expired jobs to keep across all crawlers. */
const EXPIRED_JOBS_CAP = 5000;

/* ── Content-addressable cache for assembled outputs ─────────────────────
 *
 * Repository runs ~96 deploys/day driven by an article-publish cron (every
 * 15 min). Inputs (slice files) only change on a handful of cron hours
 * (06:00, 12:00, 00:00, 00:20, 03:20, 08:00, 20:00 UTC) plus per-crawler
 * runs and translate-pending. Between events the inputs are stable for
 * hours → ~80 % of deploys can skip the 58 s assembly entirely.
 *
 * Cache key = assembler output-version + sha256(filePath \0 bytes \0 …) of
 * every slice file across the three input directories. The version is bumped
 * whenever assembly logic changes emitted artifacts without changing slice
 * bytes, so a stale cached `data/jobs.json` cannot bypass new normalization.
 */
const CACHE_ROOT = path.join(ROOT, '.cache', 'assemble-jobs');
const DATA_STATS = path.join(ROOT, 'data', 'jobs-stats.json');
// Runtime-served twin of DATA_STATS (gitignored). The SPA stats page fetches
// `/data/jobs-stats.json`, which Vite copies from public/. generateJobBoardStats
// writes both on a full build; the cache-HIT path must restore both too.
const PUBLIC_STATS = path.join(ROOT, 'public', 'data', 'jobs-stats.json');
const ASSEMBLE_OUTPUT_CACHE_VERSION = '2026-08-06-strip-markdown-bold-wrapper-from-job-titles-v1';

/**
 * Compute a fingerprint of all crawler-slice input files so the assembly can
 * be cached. Hashes file *contents* (sha256), not mtime+size: `actions/checkout`
 * resets mtime on every CI run, which would invalidate every cache key on every
 * deploy even when the bytes are identical. Content hashing is ~0.3s for ~47MB
 * — negligible vs. the 60s+ full assembly it replaces.
 *
 * Sorted by absolute path before hashing for cross-machine determinism.
 *
 * @returns {string} 16-char hex prefix of the sha256 fingerprint
 */
export function computeAssembleInputFingerprint() {
  const dirs = [JOBS_SLICES_DIR, EXPIRED_SLICES_DIR, SUMMARIES_SLICES_DIR];
  const files = [];
  for (const d of dirs) {
    files.push(...listSliceFiles(d));
  }
  files.sort();
  const hasher = crypto.createHash('sha256');
  hasher.update(`version:${ASSEMBLE_OUTPUT_CACHE_VERSION}`);
  hasher.update('\0');
  for (const f of files) {
    const buf = fs.readFileSync(f);
    hasher.update(f);
    hasher.update('\0');
    hasher.update(String(buf.length));
    hasher.update('\0');
    hasher.update(buf);
    hasher.update('\0');
  }
  return hasher.digest('hex').slice(0, 16);
}

/* ── I/O helpers ──────────────────────────────────────────────────────── */

function readJson(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Excludes cleanup-jobs.mjs's own scratch file (`<slice>.cleanup-tmp.json`,
// gitignored). It's written+unlinked in a try/finally, but a hard process
// kill (e.g. OOM) mid-run can skip the finally and leave it on disk for the
// rest of the SAME job — the malformed-slice guard below then hard-fails
// assembly on the assembler's own transient scratch file, not real data
// (run 28783188549: lidl-svizzera housekeeping died silently, orphaning
// lidl-svizzera.json.cleanup-tmp.json, which the next "Assemble dataset"
// step in the same job picked up as a slice and refused to parse).
export function listSliceFiles(dir) {
  // Predicato in scripts/lib/crawler-slice-files.mjs: era duplicato in tre
  // copie divergenti, e le due piu' magre non escludevano ne' `-locale-cache` ne'
  // `.cleanup-tmp` — cioe' proprio il file che ha fatto fallire questa
  // assembly nella run 28783188549.
  return listSliceFilePaths(dir);
}

/* ── Parallel slice parsing (worker pool) ─────────────────────────────────
 *
 * The assembler reads ~178 per-crawler slice files (~43 MB total) before it
 * can dedup. Sequential `readFileSync + JSON.parse` is single-threaded and
 * blocks ~10-15s of the 64s CI step. We farm the read+parse out to N workers
 * (N = max(availableParallelism(), cpus().length)) and reassemble the results
 * in the original input order on the main thread, so dedup iteration order
 * is byte-identical to the sequential path.
 *
 * Set ASSEMBLE_PARSE_WORKERS=1 to force single-threaded execution (useful when
 * profiling, or on a single-core runner where worker spawn cost would dominate).
 * ──────────────────────────────────────────────────────────────────────── */

function resolveParseWorkerCount(fileCount) {
  const override = process.env.ASSEMBLE_PARSE_WORKERS;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(1, Math.min(n, fileCount));
    }
  }
  const fromAP =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0;
  const fromCpus = os.cpus()?.length ?? 0;
  const detected = Math.max(fromAP, fromCpus, 1);
  return Math.max(1, Math.min(detected, fileCount));
}

function chunkRoundRobin(items, n) {
  const chunks = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) {
    chunks[i % n].push(items[i]);
  }
  return chunks;
}

function runParseWorker(workerUrl, paths) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { paths } });
    worker.once('message', (msg) => resolve(msg.results));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`parse-job-slices-worker exited with code ${code}`));
    });
  });
}

/**
 * Read + JSON.parse a list of slice paths in parallel using worker threads.
 *
 * Returns `{ path, parsed }[]` in the SAME order as the input `paths` array.
 * Failed paths are returned with `parsed: null` and a warning is printed —
 * mirroring the legacy `readJson(filePath, null)` "skip malformed" behavior
 * on the main thread.
 */
async function parseSlicesInParallel(paths) {
  if (paths.length === 0) return [];
  const workerCount = resolveParseWorkerCount(paths.length);
  if (workerCount <= 1) {
    // Single-threaded fallback — mirrors the original readJson(..., null) path.
    return paths.map((p) => {
      try {
        const text = fs.readFileSync(p, 'utf8');
        return { path: p, parsed: JSON.parse(text) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { path: p, parsed: null, error: msg };
      }
    });
  }
  const chunks = chunkRoundRobin(paths, workerCount);
  const workerUrl = new URL('./lib/parse-job-slices-worker.mjs', import.meta.url);
  const chunkResults = await Promise.all(chunks.map((chunk) => runParseWorker(workerUrl, chunk)));
  // Reassemble in original `paths` order. Workers preserve order within their
  // chunk, but we round-robin'd them out — index back into a path→result map.
  const byPath = new Map();
  for (const chunk of chunkResults) {
    for (const r of chunk) byPath.set(r.path, r);
  }
  return paths.map((p) => byPath.get(p) || { path: p, parsed: null, error: 'missing-from-worker' });
}

/* ── Per-crawler slice readers/writers (used by migrated crawlers) ────── */

/**
 * Read existing jobs for a company from the per-crawler slice file.
 *
 * Dedicated crawlers use this to find existing jobs for deduplication and
 * locale preservation. Falls back to data/jobs.json if the per-crawler
 * file doesn't exist (legacy path), then to an empty array.
 *
 * @param {string} crawlerKey - Normalised company key (e.g. 'dot-life', 'axpo-group')
 * @param {string} [dataJobsPath] - Optional fallback path to data/jobs.json
 * @returns {object[]} Array of existing job objects
 */
export function readExistingCrawlerJobs(crawlerKey, dataJobsPath) {
  const slicePath = path.join(JOBS_SLICES_DIR, `${crawlerKey}.json`);
  if (fs.existsSync(slicePath)) {
    const data = readJson(slicePath);
    const jobs = data?.jobs || (Array.isArray(data) ? data : []);
    if (jobs.length > 0) return jobs;
  }
  // Fallback: data/jobs.json (gitignored, only available locally)
  if (dataJobsPath && fs.existsSync(dataJobsPath)) {
    const all = readJson(dataJobsPath);
    return Array.isArray(all) ? all : [];
  }
  return [];
}

/* ── Boilerplate Guard ─────────────────────────────────────────────────
 *
 * Detects when a crawler's detail-page parser silently fails, causing
 * buildXxxLocalizedContent to emit generic boilerplate instead of real
 * job descriptions. Runs inside writeJobsCrawlerSlice before the slice
 * is persisted.
 *
 * Detection: marker phrases (Condition A) OR low unique word count (Condition B).
 * Threshold: 50% of jobs per crawler.
 * ──────────────────────────────────────────────────────────────────── */

const BOILERPLATE_MARKER_PHRASES = [
  "è un'azienda internazionale leader",
  'collaboratori in tutto il mondo',
  'Candidati online su',
  'transizione energetica e industriale',
  'offre servizi di ingegneria',
  'Tipologie di Dati raccolti',
  'Types of Data collected',
  'Pursuant to Article 13',
];

const BOILERPLATE_MARKER_REGEX = /cerca .+ con sede a/i;

const CONTENT_HEADINGS_RE = /\b(COMPITI|PROFILO|Responsabilit[aà]|Requisiti|Qualifiche|Tasks|Requirements|Aufgaben|Anforderungen)\b/i;

const BOILERPLATE_THRESHOLD = 0.5; // 50%
const MIN_UNIQUE_WORDS = 30;

// Sample-size floor (Diakoniewerk-Neumünster incident, 2026-07-02, issue #3254):
// a low-volume dedicated crawler can have as few as 1-2 jobs ELIGIBLE for the
// boilerplate check on a given run (fresh discoveries are excluded via
// `needsRetranslation` — see detectBoilerplateDescriptions below). At n=2 a
// single genuinely-short-but-legitimate description (e.g. a synthesized
// fallback for a JS-only ATS, or a naturally terse listing) trips the 50%
// ratio the same way 25/50 boilerplate jobs would on a large crawler — the
// ratio alone can't tell "one short job" from "systemic parser break" below
// a minimum sample. Mirrors the identical floor already applied to the
// sibling thin-source guard in validateDedicatedLocaleCoverage
// (dedicated-crawler-common.mjs SYSTEMIC_MIN_TOTAL/absolute-count floor): a
// genuine parser regression manifests across MANY jobs, not one or two, so
// below this floor the signal is too weak to justify bricking the whole run.
const BOILERPLATE_MIN_ELIGIBLE = Number(process.env.JOBS_BOILERPLATE_MIN_ELIGIBLE) || 4;
const BOILERPLATE_MIN_COUNT = Number(process.env.JOBS_BOILERPLATE_MIN_COUNT) || 2;

// Anti-shrink guard thresholds (axa-svizzera incident, 2026-07-01): only
// guard crawlers with a meaningful baseline, and only trigger on a drop deep
// enough to be clearly abnormal — observed normal 15-day churn never dropped
// below ~50-70% of a crawler's own recent baseline in a single run.
const SHRINK_GUARD_MIN_BASELINE = 20;
const SHRINK_GUARD_RATIO = 0.4;

// Stricter ratio applied below SHRINK_GUARD_MIN_BASELINE. The full ratio is
// deliberately skipped down there to let small crawlers churn freely (e.g.
// 6 -> 3, a 50% drop, is normal noise for a small employer). But that same
// permissiveness let a near-total (non-zero) wipeout sail through too: a
// source degrading from 17 real jobs to 1 stray job (94% loss) is the same
// failure mode as a total wipeout, just missing the "exactly zero" edge
// (#3840, follow-up to the corner-banca incident #3838 fixed). This ratio is
// intentionally much stricter than SHRINK_GUARD_RATIO so only genuinely
// abnormal drops (>80% loss) are blocked below baseline, not ordinary churn.
const SHRINK_GUARD_SMALL_BASELINE_RATIO = 0.2;

/**
 * Whether writeJobsCrawlerSlice should refuse to persist a shrink from
 * priorCount to newCount jobs.
 *
 * The MIN_BASELINE ratio-gate below exists to avoid false positives on
 * small crawlers' natural churn swings (e.g. 6 jobs -> 3 jobs is normal
 * noise for a small employer, not a broken parser). But that same gate
 * created a blind spot: a crawler with a small baseline (<20 jobs) that
 * goes to exactly zero is a 100% wipeout — never legitimate churn — and
 * sailed through completely unguarded (corner-banca incident, 2026-07-06:
 * 17 real jobs -> 0, below MIN_BASELINE, guard never even evaluated the
 * ratio). A total wipeout is caught unconditionally, regardless of
 * baseline size, before falling back to the baseline-gated ratio check.
 *
 * Below MIN_BASELINE, a near-total (non-zero) drop is caught too, via a much
 * stricter ratio than the one used at/above baseline (#3840).
 */
export function shouldBlockShrink(priorCount, newCount) {
  if (priorCount > 0 && newCount === 0) return true;
  if (priorCount >= SHRINK_GUARD_MIN_BASELINE) {
    return newCount < priorCount * SHRINK_GUARD_RATIO;
  }
  return priorCount > 0 && newCount < priorCount * SHRINK_GUARD_SMALL_BASELINE_RATIO;
}

/* ── Evidence-based shrink acceptance (issue #5016 / #5017) ─────────────
 *
 * The shrink guard above is a *refusal*: it keeps the prior slice on disk and
 * throws. That is right when the source degraded, but it had no counterpart
 * for the opposite (and equally real) case — the employer genuinely closed
 * most of its vacancies. In that state the guard bricks the crawler forever:
 * every run trips it, throws, fails the workflow step, re-files the
 * "Crawler Failure" issue, and — because the group workflow only runs
 * housekeeping and commit when the crawl step SUCCEEDED — the slice freezes
 * with jobs that no longer exist at the source. Those dead jobs keep their
 * live job pages instead of being archived into the expired soft-landing
 * path, so the guard designed to prevent silent content loss starts causing
 * silent content ROT.
 *
 * Observed on grace-la-margna: 14 winter-season postings expired at the end
 * of July 2026, hotelcareer.com has listed exactly 1 open position on every
 * run since (runs 30814154182, 30905340681, 30955742385 all discovered the
 * same single "Restaurant Supervisor (m/w)" posting), the independent board
 * catererglobal.com shows 0, and the crawler has failed 10 runs in a row.
 *
 * The fix is NOT a lower threshold: the threshold is untouched. It is a
 * *proof requirement*. Before a shrink is accepted, every job the new payload
 * drops must be shown to be gone at its own source URL, using the same
 * fail-open validator housekeeping already uses (`validateJobUrl`) and
 * counting ONLY its `definitive` verdicts — HTTP 404/410, redirect to a
 * generic listing, an ATS "position closed" marker, or an explicit
 * "no longer available" phrase. Anything ambiguous (timeout, 403/429, bot
 * challenge, auth wall, network error) is reported as still-alive, so a
 * blocked or degraded source can never masquerade as a legitimate shrink —
 * which is exactly the failure mode the guard exists to catch.
 */

/** Identity used to diff prior vs new slice jobs. */
function shrinkJobKey(job) {
  return resolveJobDiffKey(job) || `title:${String(job?.title || '').trim().toLowerCase()}`;
}

/**
 * Probe the jobs a shrinking write would drop and decide whether the source
 * itself corroborates the drop.
 *
 * Pure orchestration around an injectable validator so it is unit-testable
 * without network access.
 *
 * @param {object[]} priorJobs  Jobs currently persisted in the slice.
 * @param {object[]} newJobs    Jobs this run wants to persist.
 * @param {object} [options]
 * @param {(jobs: Array<{id: string, url: string}>, opts?: object) => Promise<Array<{id?: string, valid: boolean, definitive?: boolean, reason: string}>>} [options.validate]
 *   Defaults to the shared `validateJobUrls`.
 * @param {number} [options.concurrency]
 * @param {number} [options.timeoutMs]
 * @param {(job: object) => boolean} [options.isTargetJob]
 *   The crawler's own company predicate (e.g. `isFustJob`). A disappeared job
 *   that fails it needs no network probe: its own stored `company` field
 *   already proves it was never legitimately this crawler's job (shared
 *   multi-brand medium contamination — e.g. a `company: "Coop Genossenschaft"`
 *   entry stamped `companyKey: "fust"` before the source got a proper
 *   per-company filter, #5975). Self-corroborated, zero network cost.
 * @returns {Promise<{corroborated: boolean, checked: number, dead: number, alive: number, unverifiable: number, evidence: Array<{url: string, reason: string}>, survivors: Array<{url: string, reason: string}>}>}
 */
export async function verifyShrinkAgainstSource(priorJobs, newJobs, options = {}) {
  const validate = options.validate || validateJobUrls;
  const isTargetJob = options.isTargetJob;
  const keptKeys = new Set((newJobs || []).map(shrinkJobKey));
  const disappeared = (priorJobs || []).filter((job) => !keptKeys.has(shrinkJobKey(job)));

  // Nothing disappeared. Two very different situations produce this, and only
  // one of them is safe:
  //   (a) pure dedup — the prior slice held the same job twice, every key
  //       survives, no content is lost. Corroborated, nothing to probe.
  //   (b) the caller diffed the WRONG arrays — e.g. `newJobs` is a pre-filter
  //       snapshot while the count that tripped the guard came from a filtered
  //       one. Then "nothing disappeared" is vacuously true and accepting it
  //       would wave a real drop through with zero evidence.
  // The caller can pass `expectedNewCount` (the count the guard actually
  // measured) to tell them apart: if the array we diffed is not the array that
  // was measured, we refuse rather than guess.
  const expectedNewCount = options.expectedNewCount;
  if (Number.isFinite(expectedNewCount) && (newJobs || []).length !== expectedNewCount) {
    return {
      corroborated: false,
      checked: 0,
      dead: 0,
      alive: 0,
      unverifiable: (priorJobs || []).length,
      evidence: [],
      survivors: [],
      disappearedJobs: [],
      reason: `array-mismatch: diffed ${(newJobs || []).length} jobs but the guard measured ${expectedNewCount}`,
    };
  }
  if (disappeared.length === 0) {
    return { corroborated: true, checked: 0, dead: 0, alive: 0, unverifiable: 0, evidence: [], survivors: [], disappearedJobs: [] };
  }

  // Off-target: a job the crawler's own predicate already rejects is
  // corroborated straight from the record it held, no network round-trip
  // involved. It still needs no PROBE budget for that reason, but it must not
  // bypass the VOLUME cap below: `isTargetJob` misclassifying real drops as
  // off-target (e.g. a recruiting-agency `company` value) would otherwise let
  // an unbounded mass-expiry through at zero cost and zero human look.
  const offTarget = isTargetJob ? disappeared.filter((job) => !isTargetJob(job)) : [];
  const onTarget = isTargetJob ? disappeared.filter((job) => isTargetJob(job)) : disappeared;

  // Bound the probe budget. A legitimately huge drop is possible, but probing
  // it unbounded inside the crawl step is not: at DEFAULT_CONCURRENCY=10 and a
  // 7s timeout the worst case grows linearly. The same cap also bounds
  // `offTarget`, which needs no network probe but still needs a volume limit:
  // above the cap we REFUSE (the guard stands, prior slice kept) rather than
  // accept on partial evidence — the conservative direction, and the drop can
  // still be applied deliberately via SKIP_SHRINK_GUARD=1 after a human look.
  const maxProbes = Number(process.env.SHRINK_VERIFY_MAX_PROBES) || options.maxProbes || 500;
  if (disappeared.length > maxProbes) {
    return {
      corroborated: false,
      checked: onTarget.length,
      dead: 0,
      alive: 0,
      unverifiable: disappeared.length,
      evidence: [],
      survivors: [],
      disappearedJobs: disappeared,
      reason: `probe-budget-exceeded: ${disappeared.length} disappearing jobs (${onTarget.length} on-target, ${offTarget.length} off-target) > cap ${maxProbes}`,
    };
  }

  // A job with no URL can never be proven dead — treat it as still-alive so
  // the shrink stays blocked rather than accepted on absent evidence.
  const probeable = onTarget.filter((job) => typeof job?.url === 'string' && job.url.trim());
  const unverifiable = onTarget.length - probeable.length;

  const results = probeable.length
    ? await validate(
        probeable.map((job) => ({ id: shrinkJobKey(job), url: job.url })),
        { concurrency: options.concurrency, timeoutMs: options.timeoutMs },
      )
    : [];

  const evidence = offTarget.map((job) => ({ url: job?.url || '', reason: 'off-target-company' }));
  const survivors = [];
  results.forEach((result, i) => {
    const url = probeable[i]?.url || '';
    // ONLY a definitive dead verdict is evidence. `valid: false` without
    // `definitive` never occurs today, but treating it as non-evidence keeps
    // this correct if the validator gains softer signals later.
    if (result && result.valid === false && result.definitive === true) {
      evidence.push({ url, reason: result.reason });
    } else {
      survivors.push({ url, reason: result?.reason || 'unknown' });
    }
  });

  return {
    corroborated: unverifiable === 0 && survivors.length === 0 && evidence.length === disappeared.length,
    checked: onTarget.length,
    dead: evidence.length,
    alive: survivors.length,
    unverifiable,
    evidence,
    survivors,
    // Full job objects (slug + locale data intact) so an accepted shrink can
    // archive them into the expired soft-landing slice instead of leaving
    // their indexed URLs to 404.
    disappearedJobs: disappeared,
  };
}

/**
 * Async wrapper around `writeJobsCrawlerSlice` that gives a genuinely-shrunk
 * source a way through the guard, with proof.
 *
 * Behaviour is identical to calling `writeJobsCrawlerSlice` directly except
 * when the guard would block: then it probes the disappearing jobs and, only
 * if EVERY one of them is provably gone at its own source URL, retries the
 * write with the guard bypassed for that single write. Otherwise the original
 * guard error is rethrown unchanged, so a degraded scrape still fails loudly
 * and still keeps the prior slice.
 *
 * @param {string} crawlerKey
 * @param {object[]} jobs
 * @param {object} [options] Passed through to `writeJobsCrawlerSlice`; also
 *   accepts `validate` / `concurrency` / `timeoutMs` for the probe.
 */
export async function writeJobsCrawlerSliceVerified(crawlerKey, jobs, options = {}) {
  const { validate, concurrency, timeoutMs, isTargetJob, ...writeOptions } = options;
  try {
    writeJobsCrawlerSlice(crawlerKey, jobs, writeOptions);
    return { written: true, shrinkAccepted: false };
  } catch (err) {
    if (!String(err?.message || '').startsWith('[shrink-guard]')) throw err;

    // Use the arrays the guard ACTUALLY measured, not this function's `jobs`
    // argument. writeJobsCrawlerSlice reassigns `jobs` internally
    // (quarantineBoilerplateJobs returns a new filtered array) and hardens it,
    // so a quarantine-driven shrink is invisible in the caller's array: diffing
    // against it would find nothing disappeared and wave the write through with
    // no evidence at all. Without the attached payload we cannot know what was
    // measured, so we refuse instead of guessing.
    const measured = err?.shrinkGuard;
    if (!measured || !Array.isArray(measured.finalJobs) || !Array.isArray(measured.priorJobs)) {
      console.error(
        `  🚫 ${crawlerKey}: shrink guard tripped without a measurement payload — cannot verify, keeping the prior slice.`,
      );
      throw err;
    }
    const priorJobs = measured.priorJobs;
    console.log(
      `  🔬 ${crawlerKey}: shrink guard tripped (${measured.priorCount} → ${measured.newCount}) — probing the disappearing job(s) against the source before deciding.`,
    );
    const verdict = await verifyShrinkAgainstSource(priorJobs, measured.finalJobs, {
      validate,
      concurrency,
      timeoutMs,
      expectedNewCount: measured.newCount,
      isTargetJob,
    });

    if (!verdict.corroborated) {
      console.error(
        `  🚫 ${crawlerKey}: shrink NOT corroborated — ${verdict.alive} of ${verdict.checked} disappearing job(s) are still live at the source` +
          (verdict.unverifiable ? `, ${verdict.unverifiable} have no URL to probe` : '') +
          (verdict.reason ? ` [${verdict.reason}]` : '') +
          `. Keeping the prior slice (guard stands).`,
      );
      for (const s of verdict.survivors.slice(0, 5)) {
        console.error(`     ↳ still live: ${s.url} (${s.reason})`);
      }
      throw err;
    }

    console.warn(
      `  ✅ ${crawlerKey}: shrink CORROBORATED — all ${verdict.dead} disappearing job(s) are provably gone at the source. Accepting the smaller slice.`,
    );
    for (const e of verdict.evidence.slice(0, 10)) {
      console.warn(`     ↳ gone: ${e.url} (${e.reason})`);
    }

    // SEO continuity: a job leaving the slice without an expired entry turns
    // its indexed URL into a hard 404 instead of an enriched soft-landing
    // page (docs/CRAWLERS.md → "Slug Lifecycle & SEO Continuity"). The
    // template pipeline already archives `diff.removedJobs` at its own step;
    // archiving here as well is idempotent (the archive merges by slug) and
    // closes the same gap for bespoke runners that have no such step.
    const archived = archiveRemovedJobsToSlice(verdict.disappearedJobs, crawlerKey);
    if (archived > 0) {
      console.warn(`  📦 Archived ${archived} expired job(s) → data/jobs/expired/by-crawler/${crawlerKey}.json (soft-landing pages preserved).`);
    }

    writeJobsCrawlerSlice(crawlerKey, jobs, { ...writeOptions, skipShrinkGuard: true });
    return { written: true, shrinkAccepted: true, verdict, archived };
  }
}

/**
 * Decide whether a raw `inferAnyCanton()` result may be used to fill/correct
 * a job's canton. `inferAnyCanton` scans all 26 Swiss cantons (BFS-backed),
 * not just TARGET_CANTONS — the funnel's set of cantons that actually have a
 * live `/cerca-lavoro-<canton>/` URL section (currently all 26, but this is a
 * configured subset, not a given). Filling a job with an off-target canton
 * would silently turn a recognizable orphan-empty job into a harder-to-spot
 * orphan-non-target (canton set, but no URL section to place it in) — worse
 * than leaving it empty. Returns `rawInferred` unchanged if accepted, or
 * `null` if it must be rejected (caller keeps the existing/empty canton).
 * Exported for unit testing.
 *
 * @param {string|null|undefined} rawInferred - raw inferAnyCanton() output.
 * @returns {string|null}
 */
export function acceptInferredCantonForFill(rawInferred) {
  if (!rawInferred) return null;
  return TARGET_CANTONS.includes(rawInferred) ? rawInferred : null;
}

/**
 * A canton-only label ("Ticino", "TI") location string names the canton
 * itself, not a real municipality — it carries no more precision than the
 * canton field it would be overriding. Good enough to FILL an empty canton
 * (see the fill-from-inference comment below — UBS roles posted with
 * location "Ticino" self-heal from canton=""), but not precise enough to
 * OVERRIDE an already-assigned, DIFFERENT canton the crawler recorded.
 *
 * Without this guard, a job whose location field is forged/corrupted to the
 * literal canton name — while its own `canton` field is correct — gets the
 * correct value silently clobbered by this low-precision text match, then
 * frozen there forever by the pin ledger (issue #4570: ETA SA/Swatch Group
 * jobs correctly tagged canton=SO by the crawler, but with
 * location="Ticino", were overwritten to canton=TI here). Exported for unit
 * testing.
 *
 * @param {string} existingCanton - job's canton BEFORE this fix step.
 * @param {string} locationText - job.addressLocality || job.location.
 * @returns {boolean} true if an inferred-from-location canton must be
 *   ignored (not applied) because it's only a bare canton-name match against
 *   a job that already has a different canton on record.
 */
export function isWeakCantonOnlyLabelOverride(existingCanton, locationText) {
  return Boolean(existingCanton) && isCantonOnlyLabel(String(locationText || '').trim());
}

/**
 * Reconcile a job's canton with the canton PIN ledger, and say what the ledger
 * must hold afterwards.
 *
 * The ledger exists to stop the URL section (`/cerca-lavoro-<canton>/<slug>/`)
 * drifting between builds as `inferAnyCanton`'s municipality DB grows. That is
 * a tie-break job: it is only ever the *best available* signal when the record
 * carries no canton of its own.
 *
 * It used to be more than that — the pin won over the job's own `canton`
 * whenever `inferAnyCanton(city)` came back empty, which is the normal outcome
 * for any city BFS doesn't list as a municipality (a hamlet, a resort, a
 * "Remote" placeholder). `Obbürgen` (a village inside Stansstad, NW) is exactly
 * that: Bürgenstock Hotels AG records canton NW on all 39 postings, BFS cannot
 * resolve "Obbürgen", a stale TI pin therefore overwrote NW on every build, and
 * — because a wrong pin was never rewritten — it could never heal (#4838).
 * Measured across `data/jobs/by-crawler/`: **1,188 jobs** in 100+ employers were
 * being relabelled this way, plus 455 where inference already beat the pin but
 * the stale value stayed in the ledger and would take over again the moment the
 * location text degraded.
 *
 * Precedence, highest first — four branches once the job contradicts the pin,
 * decided by WHO contradicts it and how (see inline comments below for the
 * measurements behind each one):
 *   1. crawler-heal — the crawler has spoken, is on-funnel, and disagrees with
 *      the pin: the crawler wins (#4838, galenica). Per-job evidence beats a
 *      stale ledger even when a BFS inference disagrees with the crawler too
 *      — see the trade-off note on that branch below.
 *   2. off-funnel guard — the crawler wrote a non-funnel value ("CH"): never
 *      unlocks the freeze, regardless of what the inference says.
 *   3. freeze on silent/agreeing crawler — the crawler offers no evidence
 *      against the pin, and a lone BFS inference is not per-job evidence on
 *      its own (it re-derives from a municipality DB that grows over time):
 *      freeze to the pin.
 *   4. inference-wins-on-a-third-value — UNLESS a confident inference
 *      converges on a value neither the pin NOR the crawler agree with, in
 *      which case the crawler's agreement with the pin is not independent
 *      confirmation (Jegensdorf) and the inference wins.
 *
 * When the job's own resolved canton contradicts the ledger the ledger is
 * REWRITTEN, so the correction is durable instead of being re-applied (and
 * re-lost) every build. Re-sectioning an already-indexed URL is covered by the
 * cross-canton relocation bridge (#3144, `activeDriftRealPathByCompat` in
 * build-plugins/jobsSeoPagesPlugin.ts), which serves the legacy path as a
 * canonical bridge to the live page.
 *
 * Exported for unit testing.
 *
 * @param {object} args
 * @param {string} args.jobCanton      job's canton AFTER the inference fill step.
 * @param {string|null} args.inferredCanton  accepted `inferAnyCanton` result, or null.
 * @param {string|undefined} args.pinnedCanton  ledger value for this identity.
 * @param {string|undefined} args.crawlerCanton  the crawler's OWN canton field,
 *   captured BEFORE the inference fill step overwrote `jobCanton` — provenance
 *   the branches above need to tell a stale pin (crawler may heal) from a
 *   drifting inference (crawler may not). `undefined` (vs. `''`) means the
 *   caller cannot supply provenance at all; see the note on `crawlerHasSpoken`.
 * @returns {{canton: string, pin: string, outcome: 'pin-frozen'|'pin-agrees'|'pin-corrected'|'pin-added'|'unpinned'}}
 *   `canton` = the canton to emit; `pin` = the value the ledger must hold
 *   (`''` means "do not record a pin for this identity").
 */
export function resolveCantonAgainstPin({ jobCanton, inferredCanton, pinnedCanton, crawlerCanton }) {
  const raw = String(jobCanton || '').toUpperCase().trim();
  const inferred = String(inferredCanton || '').toUpperCase().trim();
  const pinned = String(pinnedCanton || '').toUpperCase().trim();
  // Provenance of the contested canton. `jobCanton` arrives AFTER the inference
  // fill step, so on its own it cannot say whether the value is the crawler's
  // per-job evidence or a BFS guess — and only the former may rewrite a pin.
  // Omitting `crawlerCanton` keeps the pre-#6xxx behaviour (every contradiction
  // rewrites the ledger) — distinct from PASSING an empty string, which means
  // "the crawler was asked and had nothing", a real input the branches below
  // must be able to see.
  const crawlerHasSpoken = crawlerCanton !== undefined;
  const crawlerRaw = String(crawlerCanton || '').toUpperCase().trim();
  const crawler = isTargetCanton(crawlerRaw) ? crawlerRaw : '';
  // A value was WRITTEN but is off-funnel (e.g. "CH", 3 live records) is a
  // different signal than the field being empty: it is proof the crawler's
  // canton detection misfired for this record, not merely silent. Kept
  // distinct from `!crawler` below on purpose.
  const crawlerOffFunnel = crawlerRaw !== '' && !crawler;
  // "A canton of our own" means one the funnel actually serves. A crawler that
  // records the COUNTRY code (`canton: "CH"` — 3 live records) or any other
  // off-funnel value has no URL section to be placed in, so it must neither
  // overrule the ledger nor be written INTO it: doing so would turn a job the
  // pin was placing correctly into an orphan-non-target, the exact outcome
  // `acceptInferredCantonForFill` already prevents on the inference path. Same
  // guard, other input.
  const job = isTargetCanton(raw) ? raw : '';

  if (!pinned) {
    // Only pin a NON-EMPTY canton backed by a confident city inference: pinning
    // "" would freeze the job mis-placed forever, and pinning an unverified
    // value would re-create the stale ledger this function exists to drain.
    if (inferred && job) return { canton: job, pin: job, outcome: 'pin-added' };
    // Nothing better to offer: hand back the value unchanged rather than
    // blanking it — an off-funnel canton with no pin is a crawler bug for the
    // location audit to surface, not something to silently erase here.
    return { canton: raw, pin: '', outcome: 'unpinned' };
  }
  if (!job) {
    // No canton of our own — the pin is the only signal there is. Freeze to it:
    // this is the URL-stability guarantee the ledger was built for.
    return { canton: pinned, pin: pinned, outcome: 'pin-frozen' };
  }
  if (job === pinned) return { canton: job, pin: pinned, outcome: 'pin-agrees' };
  // The job contradicts the ledger. WHO contradicts it, and how, decides the
  // outcome.
  //
  // The crawler's own canton is normally per-job evidence: it comes from the
  // posting or the parser config, so it does not change between builds. When
  // it disagrees with the pin, the pin is usually the stale one — that is
  // #4838 (Obbürgen frozen to a TI pin) and the galenica identity collision
  // (220 non-TI jobs on TI) — and it must heal the ledger.
  //
  // This wins unconditionally over `inferred`, even when `inferred` disagrees
  // with the crawler too — deliberately, not an oversight (test "heals with
  // the CRAWLER value, not `job`, when inference has overwritten job.canton to
  // a THIRD value", tests/canton-pin-crawler-authority.test.ts): #6318 was
  // exactly the opposite bug, a BFS guess overriding a crawler's specific,
  // stable, per-job evidence (Obbürgen, crawler=NW) — letting `inferred` win
  // here whenever it forms a "third value" would silently reopen that
  // regression. Review finding (PR #6364) asked whether the SAME skepticism
  // that protects the agree branch below (a same-crawler self-inconsistency,
  // Jegensdorf) should gate this branch too. Measured 2026-08-24 on the real
  // assembled dataset (25,997 active jobs; instrumented this branch, forced a
  // full non-cached run): of the jobs where this branch fires, exactly ONE has
  // a confident `inferred` that diverges from BOTH crawler and pin —
  // jobs.galenica.com job.id=12692413, city "Seewen" (crawler=SZ, pin=BL
  // stale from the galenica identity collision, inferred=SO). That is not a
  // demonstrated-unreliable crawler like coop-ticino/Jegensdorf (which stamps
  // FIVE different cantons on the identical location, provably self-
  // inconsistent evidence in THIS dataset) — Seewen is a genuinely ambiguous
  // town name shared by a SZ and an SO municipality, so there is no dataset
  // evidence either value is wrong. Given the volume (1 of 25,997) and the
  // absence of the kind of self-inconsistency that justified the agree-branch
  // guard, adding the same guard here would trade a proven, tested fix
  // (#4838/#6318) for an unproven one on a single ambiguous case — not taken.
  // If canton-url-drift-monitor.yml (added alongside this fix) ever shows this
  // branch producing real misclassifications, re-measure from there.
  if (crawlerHasSpoken && !crawlerOffFunnel && crawler && crawler !== pinned) {
    return { canton: crawler, pin: crawler, outcome: 'pin-corrected' };
  }

  // An off-funnel crawler value ("CH", 3 live records) is proof of a crawler
  // bug, not evidence: it must never unlock the freeze, regardless of what
  // the inference says. Pre-existing guard, kept exactly as it was.
  if (crawlerHasSpoken && crawlerOffFunnel) {
    return { canton: pinned, pin: pinned, outcome: 'pin-frozen' };
  }

  // Here the crawler either never spoke, or spoke and AGREES with the pin —
  // either way it offers no evidence AGAINST the pin. A BFS inference is not
  // per-job evidence on its own (it is a lookup of a `location` string the
  // crawler re-extracts every run, against a municipality DB that grows), so
  // when it merely agrees or is silent, freeze:
  //
  // Measured 2026-08-24 on data/all-known-job-slugs (5 of 32 shards, 44,919
  // slugs common to 2026-08-17 and 2026-08-24): 387 slugs — 0.86%/week —
  // changed section, ~10,500 already-indexed URLs per week across the 4
  // locales. Of the 330 with a municipality named in the slug to check
  // against, only 108 moved TOWARDS that municipality's canton: 154 moved
  // away and 68 were lateral, so the churn is noise, not convergence. GSC
  // reported 188,160 URLs in "Page with redirect" on 2026-08-21, ~75% of
  // them job detail pages whose section had moved.
  if (crawlerHasSpoken && (!inferred || inferred === pinned)) {
    return { canton: pinned, pin: pinned, outcome: 'pin-frozen' };
  }

  // But when a confident inference converges on a THIRD value that neither
  // the pin NOR the crawler agree with, freezing anyway is unsafe. Verified
  // 2026-08-24 (tests/canton-ti-misclassification-guard.test.ts, on the real
  // assembled dataset): 5 coopjobs.ch postings at "Jegensdorf" (BE) carried a
  // stale TI pin that a crawler-stamped "TI" merely repeated — "the crawler
  // agrees with the pin" is not independent confirmation when the SAME
  // crawler stamps FIVE different cantons (BE/SG/TI/ZH…) on other postings at
  // the identical location, which is what this dataset shows for Interdiscount
  // postings scraped by coop-ticino. A same-crawler stamp that merely repeats
  // a pin is weaker evidence than a location match that is otherwise
  // unambiguous. Confirmed by diffing against origin/main on the SAME
  // assembled dataset: main passes this guard (2/2); an earlier draft of this
  // fix that froze unconditionally whenever job and crawler agreed did not
  // (5 offenders).
  //
  // This does give up some of the drift protection above whenever the crawler
  // happens to agree with a pin that turns out to be wrong — but the
  // give-up is bounded: a crawler canton is present on 99.6% of live jobs
  // (30,219 of 30,332, data/jobs/by-crawler/*.json, 2026-08-24), so
  // "crawler-canton" being wrong (as opposed to merely absent) is the
  // exception, not the rule this branch has to defend against on every job.
  // A wrong URL section is a redirect; a wrong canton here is a plain
  // misclassification live in production (wrong addressRegion in the
  // JobPosting, AGENTS.md Non-Negotiable #3) — correctness outranks URL
  // stability when the two are in direct conflict, and canton-url-drift-monitor.yml
  // (added alongside this fix) watches whether this trade gives the churn
  // back; if it does, its issue links straight back here.
  return { canton: job, pin: job, outcome: 'pin-corrected' };
}

const SWISS_PC_RE = /^\d{4}$/;

/** BFS valid Swiss postal-code range. */
export function isSwissPostalCode(pc) {
  const s = String(pc || '').trim();
  if (!SWISS_PC_RE.test(s)) return false;
  const n = +s;
  return n >= 1000 && n <= 9658;
}

/**
 * Rescue guard for a job whose primary locality (`addressLocality`/
 * `location`) is neither a known Swiss city nor a canton-only label —
 * likely garbage text (e.g. a company name leaking through a free-text
 * intake field instead of a real location). Trusts the job's own
 * structured `canton` field (not user free text — set/defaulted upstream,
 * e.g. publisher intake) the same way a canton-only label gets a second
 * chance: a Swiss postal code on record, or a real Swiss city named in
 * the description/haystack text. Exported for unit testing.
 *
 * @param {string} canton
 * @param {string|number|null|undefined} postalCode
 * @param {string} haystack - job description text (all locales) + street.
 * @returns {boolean}
 */
export function acceptBadLocalityViaCanton(canton, postalCode, haystack) {
  if (!isTargetCanton(canton)) return false;
  if (isSwissPostalCode(postalCode)) return true;
  return Boolean(rescueSwissCityFromText(haystack));
}

/**
 * Detect boilerplate descriptions in a set of jobs.
 *
 * @param {object[]} jobs       - Array of job objects
 * @param {string}   crawlerKey - Company key for logging
 * @returns {{ boilerplateJobs: Array<{slug:string, title:string, reason:string, totalWords:number, uniqueWords:number}>, totalJobs:number, boilerplateCount:number, ratio:number }}
 */
export function detectBoilerplateDescriptions(jobs, crawlerKey) {
  const boilerplateJobs = [];
  let eligibleCount = 0;

  for (const job of jobs) {
    if (job.needsRetranslation) continue;
    eligibleCount++;

    // Parser health is measured on the SOURCE text the parser produced.
    // descriptionByLocale.it is only a proxy: a job crawled from a German/
    // French source with SKIP_AI_TRANSLATION=1 has a real source description
    // but an empty IT locale until translate-pending fills it — that is a
    // translation backlog, not a parser failure. Falling back to the
    // source-language description keeps the guard's purpose (catch parsers
    // that silently emit nothing/boilerplate) without hard-failing whole
    // CH-wide crawls on untranslated-yet jobs (Coop 95% false-positive,
    // run 27381349097).
    const desc =
      String(job.descriptionByLocale?.it || '').trim() ||
      String(job.descriptionByLocale?.[job.sourceLang || 'it'] || '').trim() ||
      String(job.description || '').trim();
    if (!desc) {
      boilerplateJobs.push({
        slug: job.slug || job.title || 'unknown',
        title: job.title || '',
        reason: 'empty_description',
        totalWords: 0,
        uniqueWords: 0,
      });
      continue;
    }

    const totalWords = desc.split(/\s+/).filter(Boolean).length;

    // Condition A: >=2 marker phrases AND no content headings
    let markerCount = 0;
    for (const phrase of BOILERPLATE_MARKER_PHRASES) {
      if (desc.includes(phrase)) markerCount++;
    }
    if (BOILERPLATE_MARKER_REGEX.test(desc)) markerCount++;

    const hasContentHeadings = CONTENT_HEADINGS_RE.test(desc);

    if (markerCount >= 2 && !hasContentHeadings) {
      boilerplateJobs.push({
        slug: job.slug || job.title || 'unknown',
        title: job.title || '',
        reason: 'marker_phrases',
        totalWords,
        uniqueWords: totalWords, // not computed for marker match
      });
      continue;
    }

    // Condition B: low unique content after removing marker substrings
    let cleaned = desc;
    for (const phrase of BOILERPLATE_MARKER_PHRASES) {
      cleaned = cleaned.replaceAll(phrase, '');
    }
    cleaned = cleaned.replace(BOILERPLATE_MARKER_REGEX, '');
    const uniqueWords = cleaned.split(/\s+/).filter(w => w.length > 0).length;

    if (uniqueWords < MIN_UNIQUE_WORDS) {
      boilerplateJobs.push({
        slug: job.slug || job.title || 'unknown',
        title: job.title || '',
        reason: 'low_unique_words',
        totalWords,
        uniqueWords,
      });
    }
  }

  const ratio = eligibleCount > 0 ? boilerplateJobs.length / eligibleCount : 0;

  return {
    boilerplateJobs,
    totalJobs: eligibleCount,
    boilerplateCount: boilerplateJobs.length,
    ratio,
  };
}

/**
 * Whether a detectBoilerplateDescriptions() report represents a SYSTEMIC
 * boilerplate failure — i.e. a signal reliable enough to hard-fail the
 * crawler run — as opposed to one or two naturally-short descriptions on a
 * low-volume crawler crossing the ratio threshold by chance.
 *
 * Requires BOTH the ratio to meet BOILERPLATE_THRESHOLD AND an absolute
 * sample-size floor (>= BOILERPLATE_MIN_ELIGIBLE eligible jobs and
 * >= BOILERPLATE_MIN_COUNT boilerplate jobs). See the floor constants above
 * for rationale (issue #3254).
 *
 * @param {{ratio:number, boilerplateCount:number, totalJobs:number}} report
 * @returns {boolean}
 */
export function isSystemicBoilerplateFailure(report) {
  return (
    report.ratio >= BOILERPLATE_THRESHOLD &&
    report.boilerplateCount >= BOILERPLATE_MIN_COUNT &&
    report.totalJobs >= BOILERPLATE_MIN_ELIGIBLE
  );
}

/**
 * Remove confirmed-boilerplate jobs from the array about to be persisted.
 *
 * Mirrors the sibling thin-source quarantine in dedicated-crawler-common.mjs
 * (validateDedicatedLocaleCoverage's `quarantineSlugs`/non-systemic path,
 * L4248-4265): below the systemic floor the guard must not hard-fail the
 * run (see isSystemicBoilerplateFailure), but confirmed marker-phrase
 * boilerplate must still never reach the committed dataset. GDPR/privacy-
 * notice boilerplate (BOILERPLATE_MARKER_PHRASES, e.g. "Pursuant to
 * Article 13") easily runs past 50 words, long enough to sail past the
 * build's <50-word sitemap/noindex filter — the only other safety net — so
 * warn-and-keep would let it publish and get indexed indefinitely on a
 * permanently low-volume crawler.
 *
 * ONLY quarantines reason === 'marker_phrases' (Condition A). Condition B
 * (`low_unique_words`, <30 words) is deliberately EXCLUDED: it's the exact
 * pattern this guard's own sample-size floor exists to protect (issue
 * #3254, Diakoniewerk "Berufsbildnerin" — a legitimate naturally-short
 * description from a JS-only ATS detail page that lands on either side of
 * the 30-word threshold run to run). Condition B jobs are by construction
 * <30 words, already below the build's <50-word noindex/sitemap-exclude
 * filter, so quarantining them adds zero SEO protection while silently and
 * permanently dropping real short listings with no GitHub issue filed.
 *
 * @param {object[]} jobs
 * @param {Array<{slug:string, reason:string}>} boilerplateJobs - bpReport.boilerplateJobs
 * @returns {object[]} jobs with the marker-phrase boilerplate entries dropped
 */
export function quarantineBoilerplateJobs(jobs, boilerplateJobs) {
  const markerPhraseJobs = (boilerplateJobs || []).filter(bj => bj.reason === 'marker_phrases');
  if (markerPhraseJobs.length === 0) return jobs;
  const quarantineSlugs = new Set(markerPhraseJobs.map(bj => bj.slug));
  return jobs.filter(j => !quarantineSlugs.has(j?.slug || j?.title || 'unknown'));
}

/**
 * Create or update a GitHub Issue for a boilerplate guard failure.
 * Best-effort: failures are logged but do not suppress the guard error.
 */
function _createBoilerplateGuardIssue(crawlerKey, report) {
  try {
    // Check for existing open issue. execFileSync passes argv directly to gh
    // (no shell), so job titles/slugs embedded in the body below can't be
    // interpreted as shell syntax (backticks, $(), etc. — see shrink-guard sibling).
    const searchResult = execFileSync(
      'gh',
      ['issue', 'list', '--label', 'parser-broken', '--state', 'open', '--search', crawlerKey, '--json', 'number,title', '--limit', '5'],
      { encoding: 'utf8', timeout: 15000 },
    ).trim();

    const existing = JSON.parse(searchResult || '[]');
    const existingIssue = existing.find(i => i.title?.includes(`[parser-health] ${crawlerKey}`));

    const dateStr = new Date().toISOString();
    const ratioPercent = Math.round(report.ratio * 100);

    if (existingIssue) {
      // Add comment to existing issue
      execFileSync(
        'gh',
        [
          'issue',
          'comment',
          String(existingIssue.number),
          '--body',
          `Updated: ${dateStr} — still detecting ${report.boilerplateCount}/${report.totalJobs} boilerplate jobs.`,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      console.log(`📋 Updated existing issue #${existingIssue.number}`);
    } else {
      // Create new issue
      const jobsTable = report.boilerplateJobs
        .slice(0, 20)
        .map((j, i) => `| ${i + 1} | ${j.title} | ${j.slug} | ${j.uniqueWords} | ${j.reason} |`)
        .join('\n');

      const body = `## Parser Health Alert

**Crawler:** ${crawlerKey}
**Boilerplate ratio:** ${ratioPercent}% (${report.boilerplateCount}/${report.totalJobs} jobs)
**Threshold:** 50%
**Run:** ${dateStr}

### Affected jobs

| # | Job title | Slug | Unique words | Reason |
|---|-----------|------|-------------|--------|
${jobsTable}

### Investigation checklist

- [ ] Check if the source site changed its HTML structure
- [ ] Review the parser at \`scripts/lib/${crawlerKey}-job-parser.mjs\`
- [ ] Compare parser selectors with current page structure
- [ ] Fix the parser and re-run: \`node scripts/update-${crawlerKey}-jobs.mjs\``;

      execFileSync(
        'gh',
        [
          'issue',
          'create',
          '--title',
          `[parser-health] ${crawlerKey}: ${report.boilerplateCount}/${report.totalJobs} jobs have boilerplate-only descriptions`,
          '--label',
          'parser-broken',
          '--label',
          'automated',
          '--body',
          body,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      console.log(`📋 Created new GitHub Issue for ${crawlerKey}`);
    }
  } catch (err) {
    console.warn(`⚠️  [boilerplate-guard] GitHub Issue creation failed: ${err.message}`);
  }
}

function _createShrinkGuardIssue(crawlerKey, report) {
  try {
    // execFileSync passes argv directly to gh (no shell), so a job title or
    // slug containing backticks/$() can't be executed as a shell command
    // (this is what previously caused "Permission denied" on a script path
    // embedded in the markdown body, see issues #3544/#3468).
    const searchResult = execFileSync(
      'gh',
      ['issue', 'list', '--label', 'parser-broken', '--state', 'open', '--search', crawlerKey, '--json', 'number,title', '--limit', '5'],
      { encoding: 'utf8', timeout: 15000 },
    ).trim();

    const existing = JSON.parse(searchResult || '[]');
    const existingIssue = existing.find(i => i.title?.includes(`[parser-health] ${crawlerKey}`));

    const dateStr = new Date().toISOString();
    const ratioPercent = Math.round(report.ratio * 100);

    if (existingIssue) {
      execFileSync(
        'gh',
        [
          'issue',
          'comment',
          String(existingIssue.number),
          '--body',
          `Updated: ${dateStr} — slice shrunk again: ${report.newCount}/${report.priorCount} jobs (${ratioPercent}% of prior).`,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      console.log(`📋 Updated existing issue #${existingIssue.number}`);
    } else {
      const body = `## Parser Health Alert — silent data loss

**Crawler:** ${crawlerKey}
**Shrink:** ${report.newCount}/${report.priorCount} jobs (${ratioPercent}% of prior baseline)
**Threshold:** below ${Math.round(SHRINK_GUARD_RATIO * 100)}% of a baseline of ${SHRINK_GUARD_MIN_BASELINE}+ jobs
**Run:** ${dateStr}

The write was refused — the prior slice on disk was kept, no data was lost.

### Investigation checklist

- [ ] Check if the source site returned a degraded/error page or empty pagination
- [ ] Review the parser at \`scripts/lib/${crawlerKey}-job-parser.mjs\`
- [ ] Compare parser selectors with current page structure
- [ ] If the shrink is legitimate (real listing count drop), re-run with \`SKIP_SHRINK_GUARD=1 node scripts/update-${crawlerKey}-jobs.mjs\``;

      execFileSync(
        'gh',
        [
          'issue',
          'create',
          '--title',
          `[parser-health] ${crawlerKey}: slice would shrink to ${ratioPercent}% of prior (${report.newCount}/${report.priorCount})`,
          '--label',
          'parser-broken',
          '--label',
          'automated',
          '--body',
          body,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      console.log(`📋 Created new GitHub Issue for ${crawlerKey}`);
    }
  } catch (err) {
    console.warn(`⚠️  [shrink-guard] GitHub Issue creation failed: ${err.message}`);
  }
}

/**
 * Cross-locale NEAR-duplicate title detector (#3509).
 *
 * A failed/partial AI translation can return the source-language title almost
 * verbatim (e.g. a FR title that is 90% Italian with only a trailing noun
 * translated). The exact-equality duplicate check misses it, the wrong-language
 * word list rarely covers domain-specific vocabulary, and the page then serves
 * a source-language <title>/H1/JSON-LD title next to a localized
 * description+slug.
 *
 * Heuristic: accent-normalized significant tokens (len ≥ 4); when ≥70% of the
 * source-title tokens survive verbatim in the candidate title AND the source
 * title has ≥5 significant tokens, the "translation" is still the source text.
 * Short titles are deliberately excluded — brand/proper-noun tokens dominate
 * them (legitimately untranslated) and the exact-equality rule already covers
 * the fully-identical case.
 *
 * @param {string} candidate - Localized title under test (locale ≠ sourceLang)
 * @param {string} source    - Source-language title
 * @returns {boolean}
 */
export function isNearDuplicateLocalizedTitle(candidate, source) {
  const tokens = (text) => String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  const src = [...new Set(tokens(source))];
  if (src.length < 5) return false;
  const cand = new Set(tokens(candidate));
  const shared = src.filter((w) => cand.has(w)).length;
  return shared / src.length >= 0.7;
}

/**
 * Write a per-crawler jobs slice.
 *
 * Migrated crawlers call this instead of writing directly to data/jobs.json.
 * The assembler reads these slices and merges them into the global file.
 *
 * @param {string} crawlerKey   - Normalised company key (e.g. 'coop', 'galenica')
 * @param {object[]} jobs       - Array of job objects discovered in this run
 * @param {object} [options]
 * @param {boolean} [options.preserveExistingSlugs] - Re-pin active slug fields
 *   and their history after every writer hardening pass. Use only when a
 *   metadata correction must not rename already-published vacancy URLs.
 * @param {boolean} [options.skipShrinkGuard] - Bypass the anti-shrink guard
 *   for THIS write only. Reserved for callers that have already verified,
 *   deterministically, that a shrink (including to zero) is a real
 *   correction rather than a degraded/failed scrape — e.g. a brand-identity
 *   re-filter that found real content this run but confirmed none of it
 *   belongs to this company (see scripts/update-swatchgroup-jobs.mjs,
 *   issue #4866). Do not use to paper over an actual parser regression.
 */
export function writeJobsCrawlerSlice(crawlerKey, jobs, options = {}) {
  if (!crawlerKey || typeof crawlerKey !== 'string') {
    throw new TypeError('writeJobsCrawlerSlice: crawlerKey must be a non-empty string');
  }
  if (!Array.isArray(jobs)) {
    throw new TypeError('writeJobsCrawlerSlice: jobs must be an array');
  }

  // ── Upstream normalization (write-time) ───────────────────────────────
  // Harden location + backfill safe metadata defaults BEFORE any downstream
  // gate so corrupted location strings never reach the assemble-time Swiss
  // whitelist (the biggest dropper). Idempotent with the assemble-time net.
  const norm = normalizeParsedJobsForSlice(jobs);
  if (norm.locationFixed > 0 || norm.localityBackfilled > 0 || norm.regionDefaulted > 0) {
    console.log(`  🧭 Upstream normalize: location cleaned ${norm.locationFixed}, addressLocality backfilled ${norm.localityBackfilled}, addressRegion defaulted ${norm.regionDefaulted}`);
  }

  // Quality gate: flag jobs where any locale has content in the wrong language.
  // Checks: (1) wrong-language words in titles/slugs, (2) cross-locale title duplicates.
  const _LANG_WORDS = {
    it: new Set('assemblaggio,imballo,imballaggio,collaudo,edile,cantiere,geometra,impiegato,impiegata,responsabile,tecnico,tecnica,ingegnere,manutenzione,magazzino,produzione,qualita,logistica,vendita,pulizia,operaio,operaia,conduttore,conduttrice,contabile,elettricista,meccanico,meccanica,direttore,direttrice,gestione,amministrazione,segretario,segretaria,cuoco,cuoca,cameriere,cameriera,operatore,operatrice,educatore,educatrice,infermiere,infermiera,fisioterapista,caporeparto,servizio,ricercatore,ricercatrice,architetto,laboratorio,metrologia,saldatore,fresatore,tornitore,verniciatore,falegname,muratore,idraulico,giardiniere,autista,magazziniere,addetto,addetta,apprendista,collaboratore,collaboratrice,specialista,descrizione,mansioni,requisiti,candidato,principali'.split(',')),
    de: new Set('mitarbeiter,mitarbeitende,aufgaben,bewerbung,bewerben,arbeitsort,anfallenden,unternehmen,lernender,lehrjahr,detailhandel,kassieren,filiale,filialen,qualifikationsverfahren,ferien,ausbildung,angebot,beschreibung,stellenangebot,verantwortungsvolles,einsatzbereitschaft,teamgeist,karriere,arbeitsbeginn,pensum,vollzeit,teilzeit,berufserfahrung,anforderungen,voraussetzungen,leistung,entlohnung,schulung,weiterbildung,pflegefachfrau,pflegefachmann,systemgastronomie,diatkoch'.split(',')),
    fr: new Set('responsable,candidature,postuler,emploi,salaire,formation,recrutement,disponibilite,competences,qualifications,experience,horaires,contrat,entreprise,taches,principales,description,auxiliaire'.split(',')),
    // English words that are distinctively English and should not appear in IT/DE/FR job titles
    en: new Set('responsibilities,requirements,qualifications,applications,deadline,teamwork,fulltime,parttime,employment,vacancy,benefits,workplace,colleagues,onboarding,outstanding,performance,accountability'.split(',')),
  };
  const _getWords = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(w => w.length > 5);
  // For title checks: flag if ≥2 wrong-language words found.
  // For slug checks: stricter threshold (≥3) because slugs are short and share more tokens.
  const _hasWrongLangWords = (text, locale, threshold = 2) => {
    const words = _getWords(text);
    for (const [lang, wordSet] of Object.entries(_LANG_WORDS)) {
      if (lang === locale) continue;
      if (words.filter(w => wordSet.has(w)).length >= threshold) return true;
    }
    return false;
  };
  let flagged = 0;
  // #3509 throttle: the near-duplicate detector uncovers a LARGE latent
  // backlog (measured 2026-07-04: ~1.5k jobs across 268 slices whose non-source
  // titles are still mostly source-language text). Flagging them all at once
  // would drop ~6% of job URLs from the sitemap in one deploy and swamp the
  // relocalize queue (RELOCALIZE_MAX_JOBS defaults to 200/day). Cap near-dup
  // flags per slice write so the backlog drains gradually (cap x staggered
  // crawler runs/day inflow, close to the relocalize drain rate) while NEW
  // partial translations are still caught within a few runs. Exact-duplicate
  // and wrong-language-word flags stay uncapped (existing behavior). Override
  // for a deliberate owner-driven backfill: NEAR_DUP_TITLE_FLAG_CAP=<n>.
  const nearDupFlagCap = Number.parseInt(process.env.NEAR_DUP_TITLE_FLAG_CAP || '3', 10);
  let nearDupFlagged = 0;
  for (const job of jobs) {
    // Skip already-flagged and jobs the pipeline gave up on (relocalize sets
    // localeMismatchSuppressed after repeated failed retranslation runs) —
    // re-flagging suppressed jobs is what kept the backlog looping.
    if (job.needsRetranslation || job.localeMismatchSuppressed) continue;
    const sl = job.sourceLang || 'it';
    const titles = job.titleByLocale || {};
    let needsFlag = false;
    for (const locale of ['it', 'en', 'de', 'fr']) {
      if (!titles[locale]) continue;
      // Cross-locale duplicate: title identical to source-language title
      if (locale !== sl && titles[locale] === titles[sl]) { needsFlag = true; break; }
      // Cross-locale NEAR-duplicate (#3509): a partially-translated title keeps
      // most source-language tokens verbatim (observed: FR title 90% Italian
      // with only the trailing lab name translated) — the exact-equality check
      // above misses it and the page ships a source-language <title>/H1/
      // JSON-LD title next to a localized description+slug.
      if (locale !== sl && nearDupFlagged < nearDupFlagCap
        && isNearDuplicateLocalizedTitle(titles[locale], titles[sl])) {
        needsFlag = true; nearDupFlagged++; break;
      }
      // Wrong-language words in title
      if (_hasWrongLangWords(titles[locale], locale)) { needsFlag = true; break; }
      // Wrong-language words in slug
      if (locale !== 'it' && _hasWrongLangWords((job.slugByLocale?.[locale] || '').replace(/-/g, ' '), locale, 3)) { needsFlag = true; break; }
    }
    if (needsFlag) { job.needsRetranslation = true; flagged++; }
  }
  if (flagged > 0) console.log(`🔍 Quality gate: flagged ${flagged} jobs with wrong-language content${nearDupFlagged > 0 ? ` (${nearDupFlagged} near-duplicate titles, cap ${nearDupFlagCap}/run)` : ''}`);

  // Boilerplate guard: detect parsers that silently fell back to generic descriptions.
  if (!process.env.SKIP_BOILERPLATE_GUARD) {
    const bpReport = detectBoilerplateDescriptions(jobs, crawlerKey);
    const systemic = isSystemicBoilerplateFailure(bpReport);

    if (bpReport.boilerplateCount > 0 && !systemic) {
      for (const bj of bpReport.boilerplateJobs) {
        console.log(`[boilerplate-guard] ${bj.slug}: ${bj.reason} (${bj.uniqueWords} unique words)`);
      }
      if (bpReport.ratio >= BOILERPLATE_THRESHOLD) {
        console.warn(
          `⚠️  [boilerplate-guard] ${crawlerKey}: ${bpReport.boilerplateCount}/${bpReport.totalJobs} jobs (${(bpReport.ratio * 100).toFixed(0)}%) meet the boilerplate ratio, ` +
          `but the eligible sample is below the reliability floor (needs >=${BOILERPLATE_MIN_ELIGIBLE} eligible jobs and >=${BOILERPLATE_MIN_COUNT} boilerplate jobs to be a systemic signal) — not failing the run. ` +
          `A genuine parser regression shows up across many jobs, not one or two naturally-short ones.`
        );
      }
      // Non-systemic: quarantine the marker-phrase boilerplate jobs from the
      // slice rather than only warning (mirrors dedicated-crawler-common.mjs's
      // quarantineSlugs on its non-systemic path — see quarantineBoilerplateJobs
      // above, which deliberately excludes low_unique_words). The good jobs
      // (including legitimate naturally-short low_unique_words ones) still
      // commit unchanged.
      const beforeQuarantine = jobs.length;
      jobs = quarantineBoilerplateJobs(jobs, bpReport.boilerplateJobs);
      if (jobs.length < beforeQuarantine) {
        console.warn(
          `🧹 [boilerplate-guard] ${crawlerKey} quarantined ${beforeQuarantine - jobs.length} marker-phrase boilerplate job(s) from the slice (${beforeQuarantine} → ${jobs.length}) — never persisted/indexed.`
        );
      }
    }

    if (systemic) {
      console.error(`\n🚨 Boilerplate guard FAILED for ${crawlerKey}`);
      console.error(`   ${bpReport.boilerplateCount}/${bpReport.totalJobs} jobs (${(bpReport.ratio * 100).toFixed(0)}%) have boilerplate-only descriptions\n`);
      console.error('   Affected jobs:');
      for (const bj of bpReport.boilerplateJobs) {
        console.error(`   - ${bj.title} [${bj.reason}, ${bj.uniqueWords} unique words]`);
      }
      _createBoilerplateGuardIssue(crawlerKey, bpReport);
      throw new Error(`[boilerplate-guard] ${crawlerKey}: ${bpReport.boilerplateCount}/${bpReport.totalJobs} jobs (${(bpReport.ratio * 100).toFixed(0)}%) have boilerplate-only descriptions — threshold is ${(BOILERPLATE_THRESHOLD * 100).toFixed(0)}%`);
    }
  }

  const hardened = hardenJobsWithStructuredSalary(jobs);

  // ── Truncated "St" locality heal (issue #1158) ────────────────────────
  // A bare "St"/"St." addressLocality is a textContent artifact (e.g.
  // "St. Moritz" split on the period). It must never reach the committed
  // by-crawler slice / JSON-LD. hardenJobsRichResultsData heals the AGGREGATE
  // data/jobs.json, but each crawler's slice is written here from its own
  // payload and bypassed that pass — so new crawls kept re-leaking bare "St"
  // (corpus-invariant guard, repeated main-red). Heal per-record (HQ/URL/slug)
  // + same-site consensus before the slice is persisted; records with no
  // recoverable signal keep the bare token and are surfaced as a warning.
  const stHeal = healTruncatedStLocalities(hardened.jobs);
  if (stHeal.healed > 0) {
    console.log(`  🏙️  St-locality heal: recovered full city for ${stHeal.healed} truncated "St"/"St." job(s)`);
  }
  if (stHeal.deferred > 0) {
    console.warn(`  ⚠️  St-locality: ${stHeal.deferred} job(s) left bare "St"/"St." (no recoverable signal — manual review)`);
  }

  // Per-locale safety net: only strip a previousSlug if it matches the SAME
  // locale's active slug. Cross-locale matches are preserved for bridge pages.
  for (const job of hardened.jobs) {
    cleanPreviousSlugsPerLocale(job);
  }

  // ── Description structure normalization ───────────────────────────────
  // Parsers that wrap their HTML stripping in a `normalizeSpace`-style helper
  // collapse the `\n` markers that `stripHtml` produced for `<li>` items
  // (`\n• `) into single spaces, leaving inline bullets like "... • foo • bar"
  // that the audit's `hasStructuredContent` (`/^\s*[-•*]\s/m`) cannot detect.
  // Centralizing the bullet-recovery step here means every crawler benefits
  // without each parser having to remember to call it. Applied to both the
  // source description and every locale-specific translation. Idempotent.
  // Apply both normalization passes: cleanCrawlerArtifacts (drops empty bolds,
  // separator lines, dedups paragraphs) runs FIRST so the bullet-recovery step
  // sees clean line boundaries. Both are idempotent.
  for (const job of hardened.jobs) {
    if (typeof job.description === 'string' && job.description) {
      let normalized = cleanCrawlerArtifacts(job.description);
      normalized = normalizeDescriptionBullets(normalized);
      if (normalized !== job.description) job.description = normalized;
    }
    if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
      for (const [locale, text] of Object.entries(job.descriptionByLocale)) {
        if (typeof text !== 'string' || !text) continue;
        let normalized = cleanCrawlerArtifacts(text);
        normalized = normalizeDescriptionBullets(normalized);
        if (normalized !== text) job.descriptionByLocale[locale] = normalized;
      }
    }
  }

  // ── firstSeenAt backfill ──────────────────────────────────────────────
  // Carry forward firstSeenAt from existing slice; fall back to crawledAt
  // (the original discovery time) for genuinely new jobs.
  fs.mkdirSync(JOBS_SLICES_DIR, { recursive: true });
  const slicePath = path.join(JOBS_SLICES_DIR, `${crawlerKey}.json`);
  const existingSlice = fs.existsSync(slicePath) ? readJson(slicePath) : null;
  const existingFirstSeen = new Map();
  // ── postedDate churn guard (#1720 item 4) ─────────────────────────────
  // Listing-only parsers without a source date set `postedDate: new Date()…`
  // on every run (decathlon, implenia, liebherr + ~90 siblings). Without a
  // carry-forward the JobPosting.datePosted "ringiovanisce" each crawl —
  // a misleading freshness signal for Google Jobs and pure diff noise on the
  // dataset. Capture the prior slice's postedDate per stable identity and,
  // for jobs that already existed, keep the EARLIER of (prior, new) so a
  // re-crawl never moves datePosted forward. A genuinely-newer source date
  // (parser read a real value) is still respected because we only pin DOWN,
  // never up; brand-new jobs keep their fresh date untouched. Centralized
  // here (not in 90 parsers) so the whole class is fixed by-construction.
  const existingPostedDate = new Map();
  for (const ej of (existingSlice?.jobs || [])) {
    const identity = buildStableJobIdentity(ej);
    if (!identity) continue;
    if (ej.firstSeenAt) existingFirstSeen.set(identity, ej.firstSeenAt);
    if (ej.postedDate) existingPostedDate.set(identity, ej.postedDate);
  }
  const now = new Date().toISOString();
  for (const job of hardened.jobs) {
    const identity = buildStableJobIdentity(job);
    if (!job.firstSeenAt) {
      job.firstSeenAt = (identity && existingFirstSeen.get(identity)) || job.crawledAt || now;
    }
    if (identity && job.postedDate) {
      const prior = existingPostedDate.get(identity);
      // Pin to the earliest known posting date for the same job (date-only
      // lexicographic compare is correct for ISO YYYY-MM-DD strings).
      if (prior && String(prior).slice(0, 10) < String(job.postedDate).slice(0, 10)) {
        job.postedDate = prior;
      }
    }
  }

  // ── prev-slug safety net (FRO-prev-slug-attribution, 2026-05-20) ───────
  // Even with the writer fixes (shared-jobs-crawler.ensureLocaleFields →
  // addPreviousSlugForLocale, pre-AI captureLostSlugs), a missed mutation
  // site or future regression could drop a historical slug. Compare the
  // jobs we are about to persist against the prior slice on disk and
  // restore any previousSlugs the new payload would otherwise lose.
  if (existingSlice && Array.isArray(existingSlice.jobs) && existingSlice.jobs.length > 0) {
    const drift = trackSlugHistoryDrift(existingSlice.jobs, hardened.jobs);
    if (drift.mergedSlugs > 0) {
      console.log(`  🛟 prev-slug safety-net: restored ${drift.mergedSlugs} slugs across ${drift.driftCount} jobs from prior slice`);
    }
  }

  // ── Anti-shrink guard (axa-svizzera incident, 2026-07-01) ──────────────
  // A crawler whose mergeJobs() only keeps discoveredJobs.map(...) (the
  // pattern shared by ~74 update-*.mjs scripts) silently drops any existing
  // job not rediscovered this run — no floor, no threshold. A source page
  // returning a degraded/error result (broken pagination, changed markup)
  // still exits 0. Observed: axa-svizzera 152→5 jobs in one run. Centralized
  // here (not in 90 parsers) so the whole class is fixed by-construction.
  if (!process.env.SKIP_SHRINK_GUARD && !options.skipShrinkGuard && existingSlice && Array.isArray(existingSlice.jobs)) {
    const priorCount = existingSlice.jobs.length;
    const newCount = hardened.jobs.length;
    if (shouldBlockShrink(priorCount, newCount)) {
      const report = { crawlerKey, priorCount, newCount, ratio: newCount / priorCount };
      console.error(`\n🚨 Shrink guard FAILED for ${crawlerKey}: ${newCount}/${priorCount} jobs (${Math.round(report.ratio * 100)}% of prior) — refusing to persist, prior slice on disk kept\n`);
      _createShrinkGuardIssue(crawlerKey, report);
      const shrinkErr = new Error(`[shrink-guard] ${crawlerKey}: slice would shrink from ${priorCount} to ${newCount} jobs (${Math.round(report.ratio * 100)}% of prior) — refusing to write, source likely returned degraded results. Override with SKIP_SHRINK_GUARD=1 if this is a legitimate drop.`);
      // Carry the EXACT arrays the guard measured. `jobs` is reassigned inside
      // this function (`quarantineBoilerplateJobs` returns a new filtered
      // array, it does not mutate the caller's), so the caller's own `jobs`
      // argument is NOT what `newCount` counted. Any consumer that re-derives
      // the drop set from the caller's array would miss a quarantine-driven
      // shrink entirely and see an empty diff — i.e. "nothing disappeared" —
      // which is vacuously true and would wave the write through with zero
      // evidence. Attaching the measured arrays makes that class impossible.
      shrinkErr.shrinkGuard = {
        crawlerKey,
        priorCount,
        newCount,
        priorJobs: existingSlice.jobs,
        finalJobs: hardened.jobs,
      };
      throw shrinkErr;
    }
  }

  const finalJobs = options.preserveExistingSlugs && Array.isArray(existingSlice?.jobs)
    ? restoreExistingSlugIdentity(existingSlice.jobs, hardened.jobs).jobs
    : hardened.jobs;
  const payload = {
    crawlerKey,
    assembledAt: new Date().toISOString(),
    jobs: finalJobs,
  };
  writeJson(slicePath, payload);
  const hardeningSuffix = hardened.updated > 0 ? `, salary hardened ${hardened.updated}` : '';
  console.log(`📂 Wrote jobs slice: data/jobs/by-crawler/${crawlerKey}.json (${hardened.total} jobs${hardeningSuffix})`);
}

/**
 * Write a per-crawler summary slice.
 *
 * Migrated crawlers call this so each run's summary is isolated and
 * can be assembled without clobbering concurrent writes.
 *
 * @param {object} summaryEntry - Summary entry object (key, label, generatedAt, ...)
 */
export function writeSummaryCrawlerSlice(summaryEntry) {
  _summaryWritten = true;
  if (!summaryEntry?.key || typeof summaryEntry.key !== 'string') {
    throw new TypeError('writeSummaryCrawlerSlice: summaryEntry.key must be a non-empty string');
  }

  // Strip heavy locale/description data from job lists — summaries should only
  // contain metadata (title, slug, company, url) for monitoring, not full translations.
  // Compute per-job quality score BEFORE stripping (needs description/locale fields).
  const HEAVY_FIELDS = ['descriptionByLocale', 'titleByLocale', 'slugByLocale', 'description', 'baseSalary', 'previousSlugs', 'previousSlugsByLocale', 'requirementsByLocale', 'requirements'];
  const stripJob = (job) => {
    if (!job || typeof job !== 'object') return job;
    // Compute quality score while full data is still available
    if (computeJobQualityScore) {
      try {
        const qs = computeJobQualityScore(job);
        job = { ...job, _qualityScore: qs.total, _qualityBreakdown: qs.breakdown };
      } catch { /* skip quality on error */ }
    }
    const slim = {};
    for (const [k, v] of Object.entries(job)) {
      if (!HEAVY_FIELDS.includes(k)) slim[k] = v;
    }
    return slim;
  };
  const stripped = { ...summaryEntry };
  for (const listKey of ['newJobs', 'updatedJobs', 'removedJobs', 'unchangedJobs']) {
    if (Array.isArray(stripped[listKey])) {
      stripped[listKey] = stripped[listKey].map(stripJob);
    }
  }

  fs.mkdirSync(SUMMARIES_SLICES_DIR, { recursive: true });
  const slicePath = path.join(SUMMARIES_SLICES_DIR, `${summaryEntry.key}.json`);
  writeJson(slicePath, stripped);
  console.log(`📂 Wrote summary slice: data/jobs-crawler-summaries/by-crawler/${summaryEntry.key}.json`);
}

/* ── Assembly logic ───────────────────────────────────────────────────── */

/**
 * Assemble per-crawler job slices into data/jobs.json.
 *
 * **Hybrid mode (transition period):**
 * While only some crawlers are migrated to per-crawler slices, the assembler
 * operates in hybrid mode:
 *   1. Start with the existing monolithic data/jobs.json as the baseline.
 *   2. Remove all jobs that belong to migrated crawlers (those with slices).
 *   3. Add all jobs from the per-crawler slices.
 *
 * This preserves all non-migrated crawler jobs in the global file while
 * replacing migrated crawlers' sections with slice-derived content.
 *
 * **Full mode (after all crawlers are migrated):**
 * When every crawler writes a slice, the baseline is effectively empty
 * and the global file is fully assembled from slices only.
 *
 * Returns the assembled jobs array, or null if no slices exist.
 */
async function assembleJobs() {
  const sliceFiles = listSliceFiles(JOBS_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler job slices found — data/jobs.json left unchanged.');
    return null;
  }

  // Parse all slices in parallel (read+JSON.parse only — dedup stays sequential
  // below, in the same alphabetical input order, so output is byte-identical
  // to the legacy single-threaded path).
  const parsed = await parseSlicesInParallel(sliceFiles);
  const slices = [];
  const malformed = [];
  for (const { path: slicePath, parsed: slice, error } of parsed) {
    if (!slice || !Array.isArray(slice.jobs)) {
      const reason = error ? ` (${error})` : '';
      malformed.push(`${path.basename(slicePath)}${reason}`);
      continue;
    }
    slices.push(slice);
    console.log(`  📄 ${path.basename(slicePath)}: ${slice.jobs.length} jobs (assembledAt: ${slice.assembledAt || '?'})`);
  }
  if (malformed.length > 0) {
    // Hard-fail: silently dropping slices has caused production incidents
    // (see incident 2026-05-21 — 92 slices skipped, ~3.5k jobs lost).
    // Run `node scripts/recover-conflict-marker-slices.mjs` if these contain
    // unresolved git merge markers.
    const list = malformed.map((m) => `  - ${m}`).join('\n');
    throw new Error(
      `Refusing to assemble: ${malformed.length} malformed slice(s) detected.\n${list}\n` +
      `Resolve before re-running (do not silently skip — see CLAUDE.md rule #1).`,
    );
  }

  if (slices.length === 0) return null;

  // Collect the set of crawlerKeys that have been migrated
  const migratedKeys = new Set(slices.map((s) => s.crawlerKey).filter(Boolean));

  // Baseline: existing monolithic jobs.json, minus jobs from migrated crawlers
  const existing = readJson(DATA_JOBS, []);
  const baseline = Array.isArray(existing)
    ? existing.filter((job) => {
        const key = String(job.companyKey || '').toLowerCase();
        return !migratedKeys.has(key);
      })
    : [];

  if (migratedKeys.size < (existing.length > 0 ? 1 : 0)) {
    console.log(`  🔄 Hybrid mode: keeping ${baseline.length} jobs from non-migrated crawlers`);
  }

  // Collect all slice jobs, tag with assembledAt for dedup
  const allTagged = [];
  for (const slice of slices) {
    for (const job of slice.jobs) {
      allTagged.push({ job, assembledAt: slice.assembledAt || '' });
    }
  }

  // Deduplicate slice jobs: last-write wins (newest assembledAt per identity)
  // — EXCEPT for `needsRetranslation`, which is merged per-record instead of
  // being decided by whichever copy has the newest timestamp (#5645).
  //
  // WHY THE EXCEPTION. The same job is routinely committed by several crawlers
  // (measured on b10e8eed: 931 slugs present in more than one by-crawler
  // slice). `mark-locale-mismatched-jobs.mjs` marks every copy, but a crawler
  // that re-crawls one of those slices afterwards rebuilds its records from
  // scratch — without the flag — and gives that slice a fresher `assembledAt`.
  // Taking that copy whole is exactly the "keep one side" resolution that
  // corpus PR #329 had to abandon on an append-only registry: it does not lose
  // an update, it DELETES a record's state. Same commit, same measurement: 223
  // slugs whose committed copies disagree on `needsRetranslation`, 25 of them
  // with the mark only on the copy that loses this very race — 25 marks thrown
  // away on every assembly, re-detected and re-written by the next marker run,
  // forever. That is the #5637 failure re-entering through the dedup.
  const { winners: sliceJobs, marksCarried, collapsed } = dedupeByIdentityPreservingMarks(
    allTagged,
    assemblerIdentity
  );
  if (marksCarried > 0) {
    console.log(
      `  🔁 Duplicate-identity merge: carried ${marksCarried} needsRetranslation mark(s) `
        + `onto the surviving copy (${collapsed} duplicate record(s) collapsed)`
    );
  }

  // Merge baseline + slice jobs
  // Deduplicate across them: slice jobs take precedence over baseline
  const sliceIdentities = new Set(sliceJobs.map(assemblerIdentity));
  const baselineFiltered = baseline.filter((job) => !sliceIdentities.has(assemblerIdentity(job)));
  const merged = [...baselineFiltered, ...sliceJobs];

  // Stable sort: newest postedDate first, then stable by identity string
  const sorted = merged.sort((a, b) => {
    const dateA = String(a.postedDate || '').slice(0, 10);
    const dateB = String(b.postedDate || '').slice(0, 10);
    if (dateB > dateA) return 1;
    if (dateA > dateB) return -1;
    // Tiebreak: stable by assembler identity
    const idA = assemblerIdentity(a) || '';
    const idB = assemblerIdentity(b) || '';
    return idA.localeCompare(idB);
  });

  // ── Final slug dedup pass ────────────────────────────────────────────
  // The URL-based identity dedup above handles most duplicates, but
  // different URLs (or baseline entries from pre-migration data) can map
  // to the same slug. Since slugs are used as the unique page identifier
  // by the build system, we must guarantee no duplicate slugs.
  // Keep the first occurrence (newest postedDate thanks to sort above).
  // Two records with DIFFERENT identities can still share a slug (37 such
  // slugs on b10e8eed). Dropping one of them here has the same consequence as
  // the identity dedup above, so it gets the same per-record treatment: the
  // discarded copy's `needsRetranslation` is carried onto the kept one instead
  // of leaving with it.
  const keptBySlug = new Map();
  let slugDupeCount = 0;
  let slugDupeMarksCarried = 0;
  const deduped = sorted.filter((job) => {
    const slug = String(job.slug || '').trim();
    if (!slug) return true; // keep slugless jobs (shouldn't happen, but safe)
    const kept = keptBySlug.get(slug);
    if (kept) {
      slugDupeCount++;
      slugDupeMarksCarried += carryForwardMarks(kept, job);
      return false;
    }
    keptBySlug.set(slug, job);
    return true;
  });

  if (slugDupeCount > 0) {
    console.log(`  🧹 Slug dedup: removed ${slugDupeCount} entries with duplicate slugs (${deduped.length} remaining)`);
    if (slugDupeMarksCarried > 0) {
      console.log(`     ↳ carried ${slugDupeMarksCarried} needsRetranslation mark(s) onto the kept copy`);
    }
  }

  // ── Per-locale slug collision guard (translator-hallucination defense) ─
  // The dedup above protects only the master IT base slug (`job.slug`).
  // It misses the case where one job's translated `slugByLocale[en|de|fr]`
  // (derived from a hallucinated AI title) equals ANOTHER job's IT base slug.
  // Example incident 2026-05-26: axpo-group-3b351c9ebffe's EN title was
  // hallucinated as "Projektmanager (m/w/d)" → slug
  // `projektmanager-m-w-d-kernkraftwerk-leibstadt-ag-leibstadt` which
  // exactly matched axpo-group-b16db3a9513c's IT base slug. Both jobs
  // emit at /en/find-jobs-aargau/projektmanager-.../ and the resulting
  // canonical drift failed `audit:sitemap-canonicals` and blocked deploy.
  const collisionReport = applyPerLocaleSlugCollisionGuard(deduped);
  if (collisionReport.count > 0) {
    console.log(`  🧹 Per-locale slug collisions resolved: ${collisionReport.count} (translator hallucination guard)`);
    for (const d of collisionReport.details) console.log(`     • ${d}`);
  }

  // ── Defensive location sanitization ─────────────────────────────────
  // Per-crawler parsers occasionally leak description-body text into the
  // `location`/`addressLocality` field when the source page inlines the
  // "Location: …" label inside a paragraph (no newline before the next
  // sentence). This shared cleanup catches those records before they
  // contaminate downstream artifacts (slug, canton, <title> tag, schema).
  // The first known root-cause fix was alten-job-parser.mjs (2026-04-28);
  // this layer is the safety net for the other 177 parsers until each one
  // is hardened.
  let sanitizedLoc = 0;
  for (const job of deduped) {
    const localityFallback = cantonFallbackLocality(job);
    const cleanedLoc = realignCantonOnlyLocality(
      sanitizeJobLocationField(job.location, localityFallback),
      job.canton,
    );
    const cleanedAddr = realignCantonOnlyLocality(
      sanitizeJobLocationField(job.addressLocality, localityFallback),
      job.canton,
    );
    if (cleanedLoc !== job.location) {
      job.location = cleanedLoc;
      sanitizedLoc++;
    }
    if (cleanedAddr !== job.addressLocality) {
      job.addressLocality = cleanedAddr;
    }
  }
  // Same shape, for markdown left wrapped around a whole title by the
  // translation pipeline. Needed HERE and not only in the write-time funnel
  // because the affected slices are already on disk: without this net the
  // 0-tolerance audit:no-literal-markdown gate stays red until every crawler
  // happens to re-run.
  let sanitizedTitles = 0;
  for (const job of deduped) sanitizedTitles += sanitizeJobTitlesInPlace(job);
  if (sanitizedTitles > 0) {
    console.log(`  🧼 Title sanitize: stripped a markdown bold wrapper from ${sanitizedTitles} job title(s)`);
  }

  if (sanitizedLoc > 0) {
    console.log(`  🧼 Location sanitize: cleaned ${sanitizedLoc} job(s) with leaked body text in location field`);
  }

  // ── Filter out foreign jobs ─────────────────────────────────────────
  // Jobs in explicitly foreign locations (London, Luxembourg, Singapore, etc.)
  // should not appear on the Swiss job board. Filter them out at assembly time
  // so they never reach the frontend or static page generation.
  const beforeForeignFilter = deduped.length;
  const foreignFiltered = deduped.filter((job) => {
    const loc = String(job.addressLocality || job.location || '');
    return !isLocationExplicitlyForeign(loc);
  });
  const foreignCount = beforeForeignFilter - foreignFiltered.length;
  if (foreignCount > 0) {
    console.log(`  🌍 Foreign location filter: excluded ${foreignCount} non-Swiss jobs (${foreignFiltered.length} remaining)`);
  }

  // ── Swiss-municipality whitelist (BFS) ─────────────────────────────
  // The blacklist above only catches jobs whose location *string* names a
  // known foreign city. Swatch Group's Italian retail jobs slipped through
  // because the crawler hardcoded `location: "Ticino"`, `postalCode: "6500"`,
  // `addressCountry: "CH"` (all forged HQ defaults) while the actual city
  // ("Forte dei Marmi, 55042") only appeared in the description body.
  //
  // Two-stage validation:
  //   1. Negative signal first: if the description body contains explicit
  //      foreign markers (5-digit postal codes — Italian/DE/FR format —
  //      next to a country word like "Italy/Italia/Italie"), drop. This
  //      overrides any potentially-forged metadata fields.
  //   2. Positive signal: primary location must resolve to a known Swiss
  //      municipality (BFS dataset, 2,110 entries + aliases). A canton-only
  //      label ("Ticino", "TI") needs a Swiss anchor: Swiss postal code on
  //      the record OR a known Swiss city of ≥4 chars in description.
  // Match: 5-digit ZIP within ~30 chars of an unambiguous foreign-country
  // word. Avoids false positives on lone numbers in tax/salary text.
  const FOREIGN_ADDRESS_RE = /\b\d{5}\b[\s\S]{0,40}?\b(?:Italy|Italia|Italie|Italien|France|Frankreich|Francia|Germany|Deutschland|Allemagne|Germania|Austria|Österreich|Autriche|Spagna|España|Spain|Espagne|Portugal|United Kingdom|UK\b|Belgium|Belgio|Belgien|Belgique|Netherlands|Nederland|Pays-Bas)\b/i;
  let droppedBadSwissCity = 0;
  let droppedCantonOnlyNoCity = 0;
  let droppedForeignAddress = 0;
  let swissValidated = foreignFiltered.filter((job) => {
    const haystack = `${job.description || ''} ${job.descriptionByLocale?.it || ''} ${job.descriptionByLocale?.en || ''} ${job.descriptionByLocale?.de || ''} ${job.descriptionByLocale?.fr || ''} ${job.streetAddress || ''}`;

    // (1) Strong negative: description body explicitly states a foreign
    // address (5-digit ZIP next to a non-Swiss country name). Drop even
    // if metadata fields claim Switzerland — those are likely forged.
    if (FOREIGN_ADDRESS_RE.test(haystack)) {
      droppedForeignAddress++;
      return false;
    }

    const primaryLoc = String(job.addressLocality || job.location || '').trim();
    if (!primaryLoc) return false; // no location at all → drop

    // (2) Strong positive: primary location names a known Swiss city.
    if (isKnownSwissCity(primaryLoc)) return true;

    // (3) Canton-only labels need a Swiss anchor.
    if (isCantonOnlyLabel(primaryLoc)) {
      if (isSwissPostalCode(job.postalCode)) return true;
      // Look for a real Swiss city in the description. rescueSwissCityFromText
      // is the single source of truth for description scanning: it applies both
      // the ≥4-char rule and the everyday-word blocklist. Calling the raw
      // findSwissCityInText here used to bypass the blocklist, which is exactly
      // how "alle"/"rolle" descriptions anchored non-Swiss postings.
      if (rescueSwissCityFromText(haystack)) return true;
      droppedCantonOnlyNoCity++;
      return false;
    }

    // (4) primaryLoc is neither a known city nor a canton-only label —
    // likely garbage (e.g. a company name leaking through a free-text
    // intake field instead of a real location). Give the structured
    // `canton` field the same second chance as a canton-only label.
    if (acceptBadLocalityViaCanton(job.canton, job.postalCode, haystack)) {
      // Sanitize: never ship the garbage primaryLoc verbatim — it would
      // leak into the JobPosting schema, sitemap slug, and search/filter
      // UI (e.g. Hirslanden Arbeitsort leak: "Bern - Futsal Minerva…
      // Besetzung per: 1").
      //
      // Order matters. Prefer a city recovered from primaryLoc ITSELF: the
      // field usually still contains the true city with a suffix that stopped
      // isKnownSwissCity from matching the whole string ("Geneva, Switzerland",
      // "Baden, Aargau", "Luzern / hybrid", "2540 Grenchen Phone"). The
      // description is a much weaker signal and is only consulted when the
      // locality yields nothing — reaching for it first is what published
      // Geneva postings as Root (LU) and Baden postings as Alle (JU).
      //
      // No blocklist on primaryLoc: an explicit locality field naming "Rolle"
      // or "Fully" is a location the author typed on purpose. The blocklist
      // exists for free-text description scanning only.
      const rescuedCity = swissCityFromLocationField(primaryLoc)
        || rescueSwissCityFromText(haystack);
      if (rescuedCity) {
        job.addressLocality = rescuedCity;
        job.location = rescuedCity;
      }
      return true;
    }

    // Neither a known Swiss city, canton-only label, nor an anchored
    // canton — likely a non-Swiss locality that escaped the explicit-
    // foreign blacklist (e.g. small Italian town).
    droppedBadSwissCity++;
    return false;
  });
  const totalDropped = droppedBadSwissCity + droppedCantonOnlyNoCity + droppedForeignAddress;
  if (totalDropped > 0) {
    console.log(`  🇨🇭 Swiss whitelist: excluded ${totalDropped} jobs (${droppedBadSwissCity} unknown locality, ${droppedCantonOnlyNoCity} canton-only without anchor, ${droppedForeignAddress} foreign address in description; ${swissValidated.length} remaining)`);
  }

  // ── Publisher supersedes crawled (anti double-listing) ───────────────
  // Runs AFTER the foreign + Swiss-municipality filters: a publisher record that
  // those filters would drop must NOT supersede (and bridge onto) a crawled twin
  // that survives — that would orphan the already-indexed crawled URL. See
  // scripts/lib/publisher-supersede.mjs.
  {
    const before = swissValidated.length;
    const res = supersedeCrawledByPublisher(swissValidated);
    swissValidated = res.jobs;
    if (res.superseded > 0) {
      console.log(`  🏷️  Publisher supersede: dropped ${res.superseded} crawled duplicate(s) of employer-published ads (${before} → ${swissValidated.length})`);
    }
  }

  // ── Canton validation — fix mismatches using BFS data ──────────────
  // Some crawlers assign HQ canton instead of the actual city's canton.
  // Use inferAnyCanton (backed by 2,110 BFS municipalities) to correct.
  //
  // ── Canton PIN ledger (drift kill) ─────────────────────────────────
  // The canton drives the URL SECTION (/cerca-lavoro-<canton>/<slug>/). It was
  // re-derived every build, so it flipped whenever inferAnyCanton's municipality
  // DB grew or job.location text varied between crawls → the previously-emitted
  // (and Google-indexed) URL orphaned → 404. This is the #1 source of residual
  // Cloudflare 404s (canton drift). The pin freezes each job's canton, keyed by
  // its URL-first stable identity, the first time the location yields a CONFIDENT
  // canton (inferred != null). Murky-location jobs stay flexible until their city
  // resolves, then pin. Once pinned, the pin always wins — the URL section can
  // never drift again. Recovery of ALREADY-orphaned URLs lives on the
  // emit/resolver side (build-plugins/searchConsoleCompat.ts).
  const cantonPinsPath = path.join(ROOT, 'data', 'job-canton-pins.json');
  let cantonPins = {};
  try { cantonPins = JSON.parse(fs.readFileSync(cantonPinsPath, 'utf-8')) || {}; }
  catch { cantonPins = {}; }
  let cantonPinsFrozen = 0;
  let cantonPinsAdded = 0;
  let cantonPinsCorrected = 0;

  let cantonFixes = 0;
  let cantonFilled = 0;
  let lowercaseFixes = 0;
  let cantonOffTargetSkipped = 0;
  // Issue #2772 item 2: self-heal (fill above) only re-pins a canton when the
  // location signal is still inferable at assemble time. A job whose city text
  // disappeared from the crawl entirely (canton "" AND no location text at all)
  // can never self-heal — it stays orphaned silently, indistinguishable in the
  // logs from a job that simply never had a canton fixed yet. Track and surface
  // this residual explicitly so it's visible/countable instead of silent.
  let cantonEmptyNoSignal = 0;
  const cantonEmptyNoSignalSamples = [];
  for (const job of swissValidated) {
    // Fix lowercase canton codes
    if (job.canton && job.canton !== job.canton.toUpperCase()) {
      job.canton = job.canton.toUpperCase();
      lowercaseFixes++;
    }
    // The crawler's own canton, captured BEFORE the inference fill step below
    // overwrites it. resolveCantonAgainstPin needs the provenance to tell a
    // stale pin (which the crawler may heal) from a drifting inference (which
    // it may not) — see the precedence note there.
    const crawlerCanton = job.canton || '';
    const city = String(job.addressLocality || job.location || '').trim();
    const hasCity = city.length >= 2 && city !== 'CH';
    const rawInferred = hasCity ? inferAnyCanton(city) : null;
    // Guard: only accept the inference if it lands in a canton the funnel
    // actually serves (has a URL section). Otherwise leave the canton as-is
    // (empty stays empty — recognizable — rather than silently becoming an
    // off-funnel orphan-non-target). See acceptInferredCantonForFill above.
    const inferred = acceptInferredCantonForFill(rawInferred);
    if (rawInferred && !inferred) {
      cantonOffTargetSkipped++;
      console.warn(`  🚧 Canton off-target: inferred "${rawInferred}" for "${city}" has no funnel URL section — left as-is for triage (${job.url || job.id || '?'})`);
    }
    if (!job.canton && !hasCity) {
      cantonEmptyNoSignal++;
      if (cantonEmptyNoSignalSamples.length < 10) {
        cantonEmptyNoSignalSamples.push(job.url || job.id || job.slug || '(no id)');
      }
    }
    // Apply the inferred canton whenever it differs from the stored one —
    // INCLUDING when the stored canton is empty. The old `&& job.canton` guard
    // skipped empty-canton jobs, so a job with a perfectly inferable location
    // (e.g. UBS roles posted with location "Ticino") kept canton="" and was then
    // FROZEN empty by the pin ledger below → permanently mis-placed / orphaned.
    // Filling from inference is always safe (an empty canton is never intended).
    // EXCEPT when the only evidence is a bare canton-name label overriding an
    // already-different, non-empty canton — see isWeakCantonOnlyLabelOverride
    // (#4570).
    if (inferred && job.canton !== inferred && !isWeakCantonOnlyLabelOverride(job.canton, city)) {
      if (job.canton) cantonFixes++;
      else cantonFilled++;
      job.canton = inferred;
      if (job.addressRegion && job.addressRegion.length === 2) {
        job.addressRegion = inferred;
      }
    }
    // Freeze/restore via the pin ledger so an already-indexed URL never migrates
    // sections. The freeze applies to EVERY job (even one whose city dropped out
    // of this crawl); a NEW pin is recorded only with a confident inferred canton.
    const pinId = buildStableJobIdentity(job);
    if (pinId) {
      // Precedence + ledger self-healing live in resolveCantonAgainstPin: the
      // pin fills a canton the job does not have, and is REWRITTEN whenever the
      // job resolved one of its own that contradicts it. buildStableJobIdentity
      // keys on the apply URL, which COLLIDES when a crawler reuses one listing
      // URL across postings (galenica ships every role as
      // https://jobs.galenica.com/it/jobs): a single early TI pin froze 220
      // non-TI jobs (Bern/Vaud/ZH…) onto the TI section — wrong canton, wrong
      // addressRegion, buried in sitemap-jobs-ticino (the 2026-06
      // max-bfs-depth regression). Same shape as #4838's Obbürgen freeze; both
      // are resolved by treating per-job evidence as authoritative over the
      // ledger.
      const pinned = cantonPins[pinId];
      const decision = resolveCantonAgainstPin({
        jobCanton: job.canton,
        inferredCanton: inferred,
        pinnedCanton: pinned,
        crawlerCanton,
      });
      if (decision.canton !== job.canton) {
        job.canton = decision.canton;
        if (job.addressRegion && job.addressRegion.length === 2) job.addressRegion = decision.canton;
      }
      if (decision.pin && cantonPins[pinId] !== decision.pin) cantonPins[pinId] = decision.pin;
      if (decision.outcome === 'pin-frozen') cantonPinsFrozen++;
      else if (decision.outcome === 'pin-corrected') cantonPinsCorrected++;
      else if (decision.outcome === 'pin-added') cantonPinsAdded++;
    }
  }
  try {
    fs.writeFileSync(cantonPinsPath, JSON.stringify(cantonPins) + '\n', 'utf-8');
  } catch (e) {
    console.warn(`  ⚠️  Canton pins: failed to persist ledger (${e?.message || e})`);
  }
  if (cantonFixes > 0 || cantonFilled > 0 || lowercaseFixes > 0) {
    console.log(`  🏔️  Canton validation: fixed ${cantonFixes} mismatches, filled ${cantonFilled} empty, ${lowercaseFixes} lowercase codes`);
  }
  if (cantonOffTargetSkipped > 0) {
    console.log(`  🚧 Canton off-target: skipped ${cantonOffTargetSkipped} inferred-but-off-funnel canton(s) (left as-is — see warnings above for triage)`);
  }
  if (cantonPinsFrozen > 0 || cantonPinsAdded > 0 || cantonPinsCorrected > 0) {
    console.log(`  📌 Canton pins: froze ${cantonPinsFrozen} canton-less job(s) to the pinned canton, added ${cantonPinsAdded}, corrected ${cantonPinsCorrected} (job's own canton overrode a contradicting pin — ledger rewritten) (ledger ${Object.keys(cantonPins).length})`);
  }
  if (cantonEmptyNoSignal > 0) {
    // #2772 item 2: these jobs cannot self-heal next assemble either — their
    // location signal is gone, not just currently unresolved — so they need
    // manual triage (bad crawler field mapping) rather than silently persisting.
    console.warn(`  ⚠️  Canton no-signal orphans: ${cantonEmptyNoSignal} job(s) with empty canton AND no location text at all (cannot self-heal) — sample: ${cantonEmptyNoSignalSamples.join(', ')}`);
  }

  // ── Backfill empty description from descriptionByLocale ────────────
  // Some crawlers (skip_ai_translation=1 mode) write jobs with empty
  // description but populated descriptionByLocale. The build plugin
  // needs description for its validity filter, so backfill from Italian.
  let backfilledDescs = 0;
  for (const job of swissValidated) {
    if (!job.description && job.descriptionByLocale) {
      const fallback = job.descriptionByLocale.it || job.descriptionByLocale.de || job.descriptionByLocale.en || job.descriptionByLocale.fr || '';
      if (fallback) {
        job.description = fallback;
        backfilledDescs++;
      }
    }
  }
  if (backfilledDescs > 0) {
    console.log(`  📝 Backfilled ${backfilledDescs} empty descriptions from descriptionByLocale`);
  }

  // ── Backfill missing IDs ─────────────────────────────────────────────
  // Some crawlers write slices without job IDs. Assign a stable hash-based
  // ID so cleanup-jobs.mjs and the build system can identify them.
  let backfilledIds = 0;
  for (const job of swissValidated) {
    if (!job.id) {
      job.id = buildStableId(job);
      backfilledIds++;
    }
  }
  if (backfilledIds > 0) {
    console.log(`  🆔 Backfilled ${backfilledIds} missing job IDs (of ${swissValidated.length} total)`);
  }

  // ── Fixture-data filter ─────────────────────────────────────────────
  // Drop test/dev fixture jobs (e.g. "Fixture Corp SA" seed records used
  // for local builds when per-crawler slices aren't available). Without
  // this gate, fixture jobs end up persisted into data/jobs.json and
  // downstream consumers (newsletter, jobsSeoPagesPlugin, GSC orphan
  // tracking) propagate them to production. See scripts/lib/fixture-data-filter.mjs.
  const cleaned = filterFixtureJobs(swissValidated, 'assemble-jobs-dataset');

  return hardenJobsWithStructuredSalary(cleaned).jobs;
}

/**
 * Assemble all per-crawler summary slices into data/jobs-crawler-summaries.json.
 * Returns the assembled store or null if no slices exist.
 */
function assembleSummaries() {
  const sliceFiles = listSliceFiles(SUMMARIES_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler summary slices found — data/jobs-crawler-summaries.json left unchanged.');
    return null;
  }

  // Collect all slice entries
  const sliceEntries = [];
  const malformedSummary = [];
  for (const slicePath of sliceFiles) {
    const entry = readJson(slicePath, null);
    if (!entry || typeof entry.key !== 'string') {
      malformedSummary.push(path.basename(slicePath));
      continue;
    }
    sliceEntries.push(entry);
  }
  if (malformedSummary.length > 0) {
    throw new Error(
      `Refusing to assemble crawler summaries: ${malformedSummary.length} malformed slice(s):\n` +
      malformedSummary.map((m) => `  - ${m}`).join('\n') +
      `\nResolve before re-running.`,
    );
  }

  // Merge with existing global summaries: slice entries take precedence over
  // entries from the monolithic store (the slice is the source of truth).
  const existingStore = readCrawlerSummaryStore(DATA_SUMMARIES, { allowMissing: true });
  const sliceKeys = new Set(sliceEntries.map((e) => e.key));

  // Keep existing entries that have NOT been migrated to per-crawler slices
  const legacyEntries = existingStore.summaries.filter((s) => !sliceKeys.has(s.key));

  // ── FRO-585: Enrich summary entries with quality scores from job slices ──
  const jobSliceFiles = listSliceFiles(JOBS_SLICES_DIR);
  const jobsByCrawler = new Map();
  for (const slicePath of jobSliceFiles) {
    const slice = readJson(slicePath, null);
    if (slice && Array.isArray(slice.jobs) && slice.crawlerKey) {
      jobsByCrawler.set(slice.crawlerKey, slice.jobs);
    }
  }

  for (const entry of sliceEntries) {
    const crawlerJobs = jobsByCrawler.get(entry.key);

    // Always set activeJobCount from the actual job slice — the source of truth.
    // summary.total only reflects the last crawl run and is 0 on earlyExit.
    entry.activeJobCount = crawlerJobs ? crawlerJobs.length : 0;

    if (crawlerJobs && crawlerJobs.length > 0) {
      const qualityAggregate = computeCrawlerQualityAggregate(crawlerJobs, entry.key);
      entry.qualityScore = {
        avgScore: qualityAggregate.avgScore,
        breakdown: qualityAggregate.breakdown,
        jobCount: qualityAggregate.jobCount,
        lastUpdated: qualityAggregate.lastUpdated,
        worstJobs: qualityAggregate.worstJobs,
      };
    }
  }

  // Most-recently-generated entries first
  const sortedSliceEntries = [...sliceEntries].sort((a, b) => {
    const tA = a.generatedAt || '';
    const tB = b.generatedAt || '';
    return tB.localeCompare(tA);
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    summaries: [...sortedSliceEntries, ...legacyEntries].slice(0, 120),
  };

  return payload;
}

/* ── Expired jobs assembly ─────────────────────────────────────────────── */

/**
 * Assemble all per-crawler expired job slices into data/expired-jobs.json.
 * Each slice is an array of expired job entries with slugs as unique keys.
 * Returns the assembled array, or null if no slices exist.
 */
function assembleExpiredJobs() {
  const sliceFiles = listSliceFiles(EXPIRED_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler expired job slices found — data/expired-jobs.json left unchanged.');
    return null;
  }

  // Keyed by companyKey+slug, not bare slug — this aggregates EVERY
  // crawler's expired slice into one Map, and two companies' jobs sharing a
  // computed slug would silently drop one company's expired-job record here
  // (same collision class fixed in scatter-jobs-to-slices.mjs /
  // reconcile-job-slugs.mjs for issue #3734).
  const expiredKey = (entry) => `${entry.companyKey || ''}::${entry.slug}`;
  const bySlug = new Map();
  let totalSliceEntries = 0;
  const malformedExpired = [];

  for (const slicePath of sliceFiles) {
    const entries = readJson(slicePath, null);
    if (!Array.isArray(entries)) {
      malformedExpired.push(path.basename(slicePath));
      continue;
    }
    totalSliceEntries += entries.length;
    for (const entry of entries) {
      if (!entry.slug) continue;
      const key = expiredKey(entry);
      const existing = bySlug.get(key);
      // Keep the most recently expired entry for each slug
      if (!existing || (entry.expiredAt || '') >= (existing.expiredAt || '')) {
        bySlug.set(key, entry);
      }
    }
  }
  if (malformedExpired.length > 0) {
    throw new Error(
      `Refusing to assemble expired slices: ${malformedExpired.length} malformed:\n` +
      malformedExpired.map((m) => `  - ${m}`).join('\n') +
      `\nResolve before re-running.`,
    );
  }

  // Also merge any existing aggregated expired-jobs.json (from deploy-time cleanup)
  const existingAgg = readJson(DATA_EXPIRED, []);
  if (Array.isArray(existingAgg)) {
    for (const entry of existingAgg) {
      if (!entry.slug) continue;
      const key = expiredKey(entry);
      const existing = bySlug.get(key);
      if (!existing || (entry.expiredAt || '') >= (existing.expiredAt || '')) {
        bySlug.set(key, entry);
      }
    }
  }

  // Sort by expiredAt descending, cap at EXPIRED_JOBS_CAP
  let assembled = [...bySlug.values()]
    .sort((a, b) => (b.expiredAt || '').localeCompare(a.expiredAt || ''));
  if (assembled.length > EXPIRED_JOBS_CAP) {
    assembled = assembled.slice(0, EXPIRED_JOBS_CAP);
  }

  console.log(`  📄 ${sliceFiles.length} expired slices: ${totalSliceEntries} entries → ${assembled.length} unique slugs`);
  return assembled;
}

/* ── Auto slug-history tracking ────────────────────────────────────── */

/**
 * Compare the just-assembled active jobs against the PRIOR snapshot of
 * `data/jobs.json` (captured before assembly began). For each job whose
 * stable identity matches a prior entry but whose slug or per-locale slug
 * differs from before, append the OLD slug(s) into the active job's
 * `previousSlugs` / `previousSlugsByLocale`. This closes the upstream
 * gap that previously fed the GSC 404 cohort:
 *   - Translation drift (re-translated title produces a new locale slug)
 *   - Tail-hash mutation (`-ncbhm0` → `-9yar0z` between crawls)
 *   - Source-side rename (employer edits the title on the source ATS)
 *
 * Without this step, downstream consumers (jobsSeoPagesPlugin's
 * previousSlugs bridge, sitemap entries, GSC orphan ingestion) never
 * learn about the old slug → cold visits 404 until the next manual
 * GSC CSV import + bridge plugin run.
 *
 * Side-effect: mutates active job entries in place.
 * Returns: { driftCount, mergedSlugs }.
 */
export function trackSlugHistoryDrift(priorJobs, activeJobs) {
  if (!Array.isArray(priorJobs) || priorJobs.length === 0) {
    return { driftCount: 0, mergedSlugs: 0 };
  }

  // Index prior jobs by stable identity (URL-first, with buildStableJobIdentity fallback).
  const priorByIdentity = new Map();
  for (const pj of priorJobs) {
    const id = assemblerIdentity(pj);
    if (!id) continue;
    // Last-write-wins on duplicates (shouldn't happen in a well-formed jobs.json).
    priorByIdentity.set(id, pj);
  }

  let driftCount = 0;
  let mergedSlugs = 0;

  for (const job of activeJobs) {
    const id = assemblerIdentity(job);
    if (!id) continue;
    const prior = priorByIdentity.get(id);
    if (!prior) continue;

    // Snapshot "already known" values BEFORE mutation, so carry-forward below
    // doesn't re-add values that are already the job's current active slug
    // (per-locale or master) or already tracked anywhere.
    const knownNew = new Set();
    if (job.slug) knownNew.add(String(job.slug));
    for (const s of Object.values(job.slugByLocale || {})) if (s) knownNew.add(String(s));
    for (const s of (job.previousSlugs || [])) if (s) knownNew.add(String(s));
    if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
      for (const arr of Object.values(job.previousSlugsByLocale)) {
        for (const s of (arr || [])) if (s) knownNew.add(String(s));
      }
    }

    let driftedThisJob = false;

    // Flat + per-locale slug drift → journaled capture (addPreviousSlugForLocale),
    // same helper the per-crawl write path uses.
    const lost = captureLostSlugs(job, prior.slugByLocale || {}, prior.slug || '', 20);
    if (lost.length > 0) {
      for (const s of lost) knownNew.add(String(s));
      mergedSlugs += lost.length;
      driftedThisJob = true;
    }

    // Also carry forward any previousSlugs from the prior entry that aren't
    // already on the current entry (defensive: keeps the history monotonically
    // growing even if a crawler slice rewrites the record from scratch).
    for (const s of (prior.previousSlugs || [])) {
      const sStr = String(s || '');
      if (!sStr || knownNew.has(sStr)) continue;
      addPreviousSlugForLocale(job, 'it', sStr, DEFAULT_PREV_SLUG_CAP, 'trackSlugHistoryDrift/carry-forward-flat');
      knownNew.add(sStr);
      mergedSlugs++;
      driftedThisJob = true;
    }
    if (prior.previousSlugsByLocale && typeof prior.previousSlugsByLocale === 'object') {
      for (const [locale, arr] of Object.entries(prior.previousSlugsByLocale)) {
        for (const s of (arr || [])) {
          const sStr = String(s || '');
          if (!sStr) continue;
          // FRO-prev-slug-attribution: do NOT short-circuit on knownNew here —
          // an entry may already be in the flat array (from the block above)
          // but still missing from the locale bucket. Bridge-page emission
          // routes through previousSlugsByLocale[locale] preferentially, so
          // we must hydrate the locale bucket even when flat already has it.
          // Dedup per-locale instead.
          const bucket = (job.previousSlugsByLocale && job.previousSlugsByLocale[locale]) || [];
          if (bucket.includes(sStr)) continue;
          addPreviousSlugForLocale(job, locale, sStr, DEFAULT_PREV_SLUG_CAP, 'trackSlugHistoryDrift/carry-forward-locale');
          knownNew.add(sStr);
          mergedSlugs++;
          driftedThisJob = true;
        }
      }
    }

    if (driftedThisJob) driftCount++;
  }

  return { driftCount, mergedSlugs };
}

/* ── Ghost expired reconciliation ──────────────────────────────────── */

/**
 * Cross-reference expired jobs against active jobs to find "ghosts" —
 * expired entries that refer to jobs still active under a different slug
 * (due to title retranslation). Removes ghosts from expired, merges their
 * old slugs into previousSlugs on the matching active job, and updates
 * the per-crawler slices on disk.
 *
 * Matched on title+company+location, NOT title+company alone: high-volume
 * retail/multi-site employers (Coop, Migros, ...) post the SAME generic
 * title (e.g. "Verkäufer:in Food") at dozens-to-hundreds of distinct store
 * locations under one company name. A title+company-only key collapses all
 * of those DIFFERENT real postings onto whichever active job happens to be
 * "first" in iteration order, so an expired job from Store A gets treated as
 * a "ghost" of an unrelated still-active posting at Store B and its slugs get
 * merged onto the wrong job's previousSlugs — cross-job contamination (issue
 * #4602: 669 misattributed slugs across 24 slices, concentrated in
 * coop-ticino.json at 441/24 where "Verkäufer:in Food"||"Coop Genossenschaft"
 * alone matched 198 postings across 128 distinct locations). Location doesn't
 * change on a same-posting retranslation, so adding it as a third key segment
 * keeps the intended match (title+company unchanged, slug changed) while
 * rejecting the false-positive collisions across different store locations.
 *
 * Returns { cleanedExpired, ghostCount, mergedSlugs }.
 */
export function reconcileGhostExpired(activeJobs, expiredJobs) {
  if (!activeJobs?.length || !expiredJobs?.length) {
    return { cleanedExpired: expiredJobs || [], ghostCount: 0, mergedSlugs: 0 };
  }

  // Build active lookup: title+company+location → first matching job
  const activeByTCL = Object.create(null);
  for (const j of activeJobs) {
    const key = `${(j.title || '').toLowerCase().trim()}||${(j.company || '').toLowerCase().trim()}||${(j.location || '').toLowerCase().trim()}`;
    if (!activeByTCL[key]) activeByTCL[key] = j;
  }

  // Build set of all active slugs (current + previous)
  const activeSlugSet = new Set();
  for (const j of activeJobs) {
    if (j.slugByLocale) Object.values(j.slugByLocale).forEach(s => activeSlugSet.add(s));
    if (j.previousSlugs) j.previousSlugs.forEach(s => activeSlugSet.add(s));
    if (j.previousSlugsByLocale && typeof j.previousSlugsByLocale === 'object') {
      for (const arr of Object.values(j.previousSlugsByLocale)) {
        if (Array.isArray(arr)) arr.forEach(s => activeSlugSet.add(s));
      }
    }
  }

  const ghostIds = new Set();
  let mergedSlugs = 0;

  for (const ej of expiredJobs) {
    const expSlugs = ej.slugByLocale ? Object.values(ej.slugByLocale) : [];
    const hasSlugOverlap = expSlugs.some(s => activeSlugSet.has(s));
    const key = `${(ej.title || '').toLowerCase().trim()}||${(ej.company || '').toLowerCase().trim()}||${(ej.location || '').toLowerCase().trim()}`;
    const match = activeByTCL[key];

    // Ghost: slug overlap + title match, or exact same IT slug
    const sameItSlug = match && (ej.slugByLocale?.it === match.slugByLocale?.it);
    if (!match || (!hasSlugOverlap && !sameItSlug)) continue;

    // Mark as ghost
    ghostIds.add(ej.slug || ej.id || JSON.stringify(ej.slugByLocale));

    // Merge expired slugs into active job's previousSlugs (journaled + capped,
    // matching the write path everywhere else — see addPreviousSlugForLocale).
    const existingSlugs = new Set([
      ...(match.slugByLocale ? Object.values(match.slugByLocale) : []),
      ...(match.previousSlugs || []),
    ]);
    let addedCount = 0;
    if (ej.slugByLocale && typeof ej.slugByLocale === 'object') {
      for (const [locale, s] of Object.entries(ej.slugByLocale)) {
        if (!s || existingSlugs.has(s)) continue;
        addPreviousSlugForLocale(match, locale, s, DEFAULT_PREV_SLUG_CAP, 'assemble-jobs-dataset.reconcileGhostExpired');
        existingSlugs.add(s);
        addedCount++;
      }
    }
    for (const s of (ej.previousSlugs || [])) {
      if (!s || existingSlugs.has(s)) continue;
      addPreviousSlugForLocale(match, 'it', s, DEFAULT_PREV_SLUG_CAP, 'assemble-jobs-dataset.reconcileGhostExpired');
      existingSlugs.add(s);
      addedCount++;
    }
    mergedSlugs += addedCount;
  }

  // Filter out ghosts
  const cleanedExpired = expiredJobs.filter(ej => {
    const id = ej.slug || ej.id || JSON.stringify(ej.slugByLocale);
    return !ghostIds.has(id);
  });

  const ghostCount = ghostIds.size;

  // Update per-crawler expired slices on disk — remove ONLY the detected
  // ghosts. The previous implementation kept an entry only if it appeared in
  // `cleanedSlugSet` (derived from the EXPIRED_JOBS_CAP-capped `expiredJobs`),
  // which silently DROPPED every long-tail entry beyond the 5000-most-recent
  // cap from the slices whenever any ghost existed. That re-capped the slices
  // and defeated the uncapped slice-content coverage the soft-landing build
  // plugin relies on (jobsSeoPagesPlugin reads the slices directly to render
  // orphan pages past the cap — e.g. the USI André Corboz PhD page). Filtering
  // by `ghostIds` removes the ghosts and nothing else, so cap-excluded
  // long-tail entries survive in the slices.
  if (ghostCount > 0) {
    const sliceFiles = listSliceFiles(EXPIRED_SLICES_DIR);
    for (const fp of sliceFiles) {
      const slice = readJson(fp, null);
      if (!Array.isArray(slice)) continue;
      const cleaned = slice.filter(ej => {
        const id = ej.slug || ej.id || JSON.stringify(ej.slugByLocale);
        return !ghostIds.has(id);
      });
      if (cleaned.length < slice.length) {
        writeJson(fp, cleaned);
      }
    }
  }

  return { cleanedExpired, ghostCount, mergedSlugs };
}

/* ── Meta generation ──────────────────────────────────────────────────── */

/**
 * Generate data/jobs-meta.json from the assembled jobs array.
 */
function generateMeta(jobCount) {
  const existing = readJson(DATA_META, {});
  return {
    ...existing,
    lastUpdated: new Date().toISOString(),
    totalJobs: jobCount,
    sources: {
      ...(existing.sources || {}),
      arbeitSwiss: 0,
      ubs: 0,
      migros: 0,
      tutti: 0,
      remotive: 0,
      findwork: 0,
      curatedTicino: jobCount,
    },
  };
}

/* ── Main assembly entry point ────────────────────────────────────────── */

/**
 * Run the full assembly pipeline.
 *
 * @param {object} [options]
 * @param {boolean} [options.withStats=false] - Whether to regenerate job board stats after assembly
 */

// ── FRO-585: Firestore persistence for crawler quality scores ──────────
const QUALITY_SCORES_COLLECTION = 'crawler-quality-scores';

async function persistQualityScoresToFirestore(summaries) {
  const entriesWithScores = summaries.filter((s) => s.qualityScore);
  if (entriesWithScores.length === 0) return;

  try {
    const adminMod = await import('firebase-admin');
    const admin = adminMod.default || adminMod;
    if (!admin.apps.length) {
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.log('ℹ️  [QualityScores] No GOOGLE_APPLICATION_CREDENTIALS — skipping Firestore persistence');
        return;
      }
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
    const db = admin.firestore();
    const now = new Date().toISOString();

    // Chunk the write so it scales past the Firestore 500-op batch cap (one
    // entry per crawler slug — grows with crawler count; a single commit() over
    // >500 would throw and persist nothing that run).
    await commitInChunks(db, entriesWithScores, (batch, entry) => {
      const docRef = db.collection(QUALITY_SCORES_COLLECTION).doc(entry.key);
      batch.set(docRef, {
        slug: entry.key,
        avgScore: entry.qualityScore.avgScore,
        breakdown: entry.qualityScore.breakdown,
        jobCount: entry.qualityScore.jobCount,
        lastUpdated: now,
        worstJobs: (entry.qualityScore.worstJobs || []).slice(0, 5),
      }, { merge: true });
    });
    console.log(`☁️  [QualityScores] Persisted ${entriesWithScores.length} crawler quality scores to Firestore`);
  } catch (err) {
    // Non-fatal: quality scores are also in the summary JSON
    console.warn(`⚠️  [QualityScores] Firestore persistence failed (non-fatal): ${err?.message || err}`);
  }
}

export async function assembleJobsDataset({ withStats = false } = {}) {
  // In slice-only mode crawlers skip assembly — it runs during deploy instead.
  if (String(process.env.CRAWLER_SLICE_ONLY || '0') === '1') {
    console.log('📦 Slice-only mode: skipping assembly (will run at deploy time)');
    return;
  }

  // --- Content-addressable cache lookup ---
  // Skip the 58 s assembly when the slice fingerprint matches a previous run.
  // Inputs change on a few cron hours per day; between those events, ~80 % of
  // deploys feed identical bytes through the same pipeline.
  const inputFingerprint = computeAssembleInputFingerprint();
  const cacheKey = `${inputFingerprint}_${withStats ? 'stats' : 'nostats'}`;
  const cacheDir = path.join(CACHE_ROOT, cacheKey);
  const manifestPath = path.join(cacheDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    const t0 = Date.now();
    const restorePairs = [
      [path.join(cacheDir, 'jobs.json'), DATA_JOBS],
      [path.join(cacheDir, 'jobs.json'), PUBLIC_JOBS],
      [path.join(cacheDir, 'expired-jobs.json'), DATA_EXPIRED],
      [path.join(cacheDir, 'expired-jobs.json'), PUBLIC_EXPIRED],
      [path.join(cacheDir, 'jobs-meta.json'), DATA_META],
      [path.join(cacheDir, 'jobs-crawler-summaries.json'), DATA_SUMMARIES],
    ];
    if (withStats) {
      restorePairs.push([path.join(cacheDir, 'jobs-stats.json'), DATA_STATS]);
      restorePairs.push([path.join(cacheDir, 'jobs-stats.json'), PUBLIC_STATS]);
    }
    // Verify the snapshot is complete BEFORE writing anything; a partial
    // snapshot (e.g. previous run was without --stats) must fall through to
    // a full miss rather than half-restoring outputs.
    const allPresent = restorePairs.every(([src]) => fs.existsSync(src));
    if (allPresent) {
      for (const [src, dst] of restorePairs) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        // Preserve the source mtime/atime — left over from when the
        // build-plugin cache existed and hashed these files. Cheap to
        // keep; harmless now that the plugin cache is gone.
        const srcStat = fs.statSync(src);
        fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(2);
      console.log(`✅ assemble-jobs cache HIT (key=${cacheKey.slice(0, 12)}..., restored ${restorePairs.length} files in ${dt}s)`);
      return;
    }
    console.log(`⚠️  assemble-jobs cache partial (key=${cacheKey.slice(0, 12)}..., missing snapshot files) — running full assembly`);
  } else {
    console.log(`⚠️  assemble-jobs cache MISS (key=${cacheKey.slice(0, 12)}...) — running full assembly`);
  }

  console.log('🔧 Assembling jobs dataset from per-crawler slices...');

  // Snapshot the prior data/jobs.json BEFORE assembly overwrites it. Used
  // by trackSlugHistoryDrift() to detect translation/hash drift on
  // re-crawl and auto-populate previousSlugs[ByLocale] so the slug-bridge
  // pipeline keeps every historical URL resolving on next deploy.
  const priorJobsSnapshot = readJson(DATA_JOBS, []);

  // --- Jobs ---
  const assembled = await assembleJobs();
  if (assembled !== null) {
    // --- Auto slug-history tracking (translation/hash drift) ---
    const drift = trackSlugHistoryDrift(priorJobsSnapshot, assembled);
    if (drift.driftCount > 0) {
      console.log(`  🧭 Slug-history drift tracked: ${drift.driftCount} jobs with changed slug, ${drift.mergedSlugs} historical slugs preserved in previousSlugs[ByLocale]`);
    }

    // Jobs with partially-populated localized descriptions are not fully
    // translated yet. Keep them out of strict completeness gates until the
    // translate-pending pipeline fills the missing locales.
    let partialDescriptionFlags = 0;
    for (const job of assembled) {
      // Skip ONLY needsRetranslation — the SAME exemption the completeness test
      // applies (tests/job-locale-completeness.test.ts skips needsRetranslation
      // only). Do NOT also skip localeMismatchSuppressed: relocalize-pending-
      // jobs.mjs can `delete needsRetranslation` then set
      // localeMismatchSuppressed=true, leaving a {suppressed, flag-absent,
      // missing-description} job that this guard would skip → never flagged →
      // test-red AND indexed (jobsSeoPagesPlugin excludes only
      // needsRetranslation===true). Aligning the skip-set to the test (matching
      // the titleByLocale guard below) closes that latent class. NOTE (PR #1990):
      // needsTranslation() now prioritises needsRetranslation first, so suppressed
      // re-flagged jobs DO re-enter the translate pool. The give-up counter cannot
      // advance (per-crawler files lack needsRetranslation post-gaveup → 'noop').
      if (job.needsRetranslation) continue;
      const descriptions = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
        ? job.descriptionByLocale
        : {};
      const missingDescription = ['it', 'en', 'de', 'fr']
        .some((locale) => !String(descriptions[locale] || '').trim());
      if (missingDescription) {
        job.needsRetranslation = true;
        partialDescriptionFlags++;
      }
    }
    if (partialDescriptionFlags > 0) {
      console.log(`  🌍 Locale completeness: flagged ${partialDescriptionFlags} jobs with partial descriptionByLocale`);
    }

    // Same contract for titleByLocale: an unflagged job is treated as
    // fully-translated and indexed in all 4 locales, and
    // tests/job-locale-completeness.test.ts holds it to full titleByLocale
    // coverage. A job whose titleByLocale lost a locale (e.g. de/en/fr present,
    // `it` dropped — Coop / Two-Spice prospective slices, the #1920 deadlock
    // class) can pass the descriptionByLocale guard above (its descriptions are
    // complete) yet still be title-incomplete, turning the test red and getting
    // indexed with a source-language title fallback. Mirror the description
    // guard so it is flagged out of the indexable set until translate-pending
    // fills the missing locale; render already falls back to `job.title`.
    // NOTE: skip ONLY needsRetranslation here, NOT localeMismatchSuppressed.
    // The completeness test exempts only needsRetranslation jobs, so a
    // localeMismatchSuppressed job with an incomplete title (the pipeline gave
    // up reconciling its locales but never set needsRetranslation) would stay
    // test-red. Flagging it needsRetranslation is the truthful state and routes
    // it out of the indexable set; translate-pending may retry, and if it
    // re-suppresses, the flag persists — stable across re-assembly.
    let partialTitleFlags = 0;
    for (const job of assembled) {
      if (job.needsRetranslation) continue;
      const titles = job.titleByLocale && typeof job.titleByLocale === 'object'
        ? job.titleByLocale
        : {};
      const missingTitle = ['it', 'en', 'de', 'fr']
        .some((locale) => !String(titles[locale] || '').trim());
      if (missingTitle) {
        job.needsRetranslation = true;
        partialTitleFlags++;
      }
    }
    if (partialTitleFlags > 0) {
      console.log(`  🌍 Locale completeness: flagged ${partialTitleFlags} jobs with partial titleByLocale`);
    }

    // --- slugByLocale completeness backfill ---
    // Fixed-translation jobs (needsRetranslation:false) MUST expose a slug for
    // every locale. Some legacy crawlers populate only the source-language slug
    // even after the i18n pipeline has run. Backfill missing entries from any
    // available slug so router lookups + sitemap-jobs entries never 404.
    let slugBackfilled = 0;
    for (const job of assembled) {
      if (job.needsRetranslation) continue;
      const sbl = job.slugByLocale && typeof job.slugByLocale === 'object'
        ? job.slugByLocale
        : (job.slugByLocale = {});
      // Pick the best fallback: existing slug, else any populated locale.
      const fallback = String(job.slug || '').trim()
        || String(sbl.it || sbl.de || sbl.en || sbl.fr || '').trim();
      if (!fallback) continue;
      for (const locale of ['it', 'en', 'de', 'fr']) {
        if (!String(sbl[locale] || '').trim()) {
          sbl[locale] = fallback;
          slugBackfilled++;
        }
      }
    }
    if (slugBackfilled > 0) {
      console.log(`  🧷 slugByLocale backfill: filled ${slugBackfilled} missing locale entries from canonical slug`);
    }

    writeJson(DATA_JOBS, assembled, { compact: true });
    fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
    writeJson(PUBLIC_JOBS, assembled, { compact: true });
    console.log(`✅ data/jobs.json assembled: ${assembled.length} jobs from ${listSliceFiles(JOBS_SLICES_DIR).length} slices`);

    // --- PostalCode enrichment (ensures 100% postalCode for JobPosting schema) ---
    const plzPath = path.join(ROOT, 'data', 'swiss-postal-codes.json');
    if (fs.existsSync(plzPath)) {
      const plz = JSON.parse(fs.readFileSync(plzPath, 'utf-8'));
      const cantonCapitals = { TI: '6500', GR: '7000', VS: '1950', ZH: '8001', BE: '3001', SG: '9000', LU: '6003', AG: '5000', SO: '4500', BL: '4001', BS: '4001', AR: '9100', AI: '9050', GL: '8750', SH: '8200', TG: '8500', ZG: '6300', SZ: '6430', NW: '6370', OW: '6060', UR: '6460', FR: '1700', NE: '2000', JU: '2800', VD: '1003', GE: '1201' };
      let postalFilled = 0;
      for (const job of assembled) {
        if (job.postalCode) continue;
        const loc = (job.addressLocality || job.location || '').trim();
        if (!loc) continue;
        if (plz[loc]) { job.postalCode = plz[loc]; postalFilled++; continue; }
        const parts = loc.split(/[,·\-/]/).map(s => s.trim()).filter(Boolean);
        let found = false;
        for (const p of parts) { if (plz[p]) { job.postalCode = plz[p]; postalFilled++; found = true; break; } }
        if (found) continue;
        const m = loc.match(/\b(\d{4})\b/);
        if (m && !(Number(m[1]) >= 2020 && Number(m[1]) <= 2039)) { job.postalCode = m[1]; postalFilled++; continue; }
        const canton = (job.canton || '').toUpperCase();
        if (canton && cantonCapitals[canton]) { job.postalCode = cantonCapitals[canton]; postalFilled++; }
      }
      if (postalFilled > 0) {
        writeJson(DATA_JOBS, assembled, { compact: true });
        writeJson(PUBLIC_JOBS, assembled, { compact: true });
        console.log(`  📮 PostalCode enrichment: filled ${postalFilled}/${assembled.length} jobs`);
      }
    }

    // --- Quality score enrichment (persisted for frontend sorting) ---
    let qsChanged = 0;
    for (const job of assembled) {
      const { total } = computeJobQualityScore(job);
      if (job.qualityScore !== total) { qsChanged++; }
      job.qualityScore = total;
    }
    if (qsChanged > 0) {
      writeJson(DATA_JOBS, assembled, { compact: true });
      writeJson(PUBLIC_JOBS, assembled, { compact: true });
      console.log(`  📊 Quality score: computed for ${assembled.length} jobs (${qsChanged} changed)`);
    }

    // --- Meta (derived from assembled jobs) ---
    const meta = generateMeta(assembled.length);
    writeJson(DATA_META, meta);
    console.log(`✅ data/jobs-meta.json generated: ${assembled.length} total jobs`);
  }

  // --- Expired jobs ---
  const expiredJobs = assembleExpiredJobs();
  if (expiredJobs !== null) {
    // --- Ghost reconciliation: remove expired entries that match active jobs ---
    if (assembled) {
      const { cleanedExpired, ghostCount, mergedSlugs } = reconcileGhostExpired(assembled, expiredJobs);
      if (ghostCount > 0) {
        console.log(`  👻 Ghost reconciliation: removed ${ghostCount} ghost expired entries, merged ${mergedSlugs} slugs into active previousSlugs`);
        // Write back active jobs with merged previousSlugs
        writeJson(DATA_JOBS, assembled, { compact: true });
        writeJson(PUBLIC_JOBS, assembled, { compact: true });
      }
      writeJson(DATA_EXPIRED, cleanedExpired);
      fs.mkdirSync(path.dirname(PUBLIC_EXPIRED), { recursive: true });
      writeJson(PUBLIC_EXPIRED, cleanedExpired);
      console.log(`✅ data/expired-jobs.json assembled: ${cleanedExpired.length} expired jobs`);

      // --- Orphan + Expired slug reconciliation (Jaccard similarity) ---
      try {
        const { reconcileOrphanSlugs, reconcileExpiredSlugs } = await import('./reconcile-job-slugs.mjs');

        // Reconcile orphan slugs → merge into active jobs' previousSlugs
        const orphanFile = path.join(ROOT, 'data', 'orphan-indexed-job-slugs.json');
        if (fs.existsSync(orphanFile)) {
          const orphanSlugs = JSON.parse(fs.readFileSync(orphanFile, 'utf8'));
          // Sharded ledger (#4248); returns [] when absent, which is what the
          // previous `fs.existsSync ? parse : {}` degraded to for a missing file.
          const enrichedData = readOrphanEnriched(ROOT);
          // reconcile* mutano `assembled` in place (aggiungono previousSlugs);
          // NON scrivono slice (l'opzione `writeSlices` non è implementata in
          // reconcile-job-slugs.mjs — vi si legge solo { dryRun, verbose, max }).
          // La persistenza canonica è il writeJson sotto, gated su mergedCount.
          const orphanResult = reconcileOrphanSlugs(assembled, orphanSlugs, enrichedData, { dryRun: false });
          if (orphanResult.mergedCount > 0) {
            console.log(`  🔗 Orphan reconciliation: ${orphanResult.mergedCount} slugs merged into active jobs' previousSlugs`);
            writeJson(DATA_JOBS, assembled, { compact: true });
            writeJson(PUBLIC_JOBS, assembled, { compact: true });
          }
        }

        // Reconcile expired slugs → merge into active jobs' previousSlugs
        const expResult = reconcileExpiredSlugs(assembled, cleanedExpired, { dryRun: false });
        if (expResult.mergedCount > 0) {
          console.log(`  🔗 Expired reconciliation: ${expResult.mergedCount} slugs merged into active jobs' previousSlugs`);
          writeJson(DATA_JOBS, assembled, { compact: true });
          writeJson(PUBLIC_JOBS, assembled, { compact: true });
          writeJson(DATA_EXPIRED, cleanedExpired);
          writeJson(PUBLIC_EXPIRED, cleanedExpired);
        }
      } catch (err) {
        console.warn(`  ⚠️ Slug reconciliation skipped: ${err.message}`);
      }
    } else {
      writeJson(DATA_EXPIRED, expiredJobs);
      fs.mkdirSync(path.dirname(PUBLIC_EXPIRED), { recursive: true });
      writeJson(PUBLIC_EXPIRED, expiredJobs);
      console.log(`✅ data/expired-jobs.json assembled: ${expiredJobs.length} expired jobs`);
    }
  }

  // --- Summaries ---
  const summaryStore = assembleSummaries();
  if (summaryStore !== null) {
    writeCrawlerSummaryStore(DATA_SUMMARIES, summaryStore);
    console.log(`✅ data/jobs-crawler-summaries.json assembled: ${summaryStore.summaries.length} crawler entries`);

    // FRO-585: Persist quality scores to Firestore
    await persistQualityScoresToFirestore(summaryStore.summaries);
  }

  // --- Stats (optional) ---
  if (withStats) {
    const { generateJobBoardStats } = await import('./generate-job-board-stats.mjs');
    const result = generateJobBoardStats();
    console.log(`📈 Stats regenerated: ${result.summary.totals.activeJobs} active jobs`);
  }

  // --- Snapshot to cache for next run ---
  // Wrapped in try/catch — cache write failures must never fail the deploy;
  // worst case the next run pays the 58 s assembly cost again.
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    const snapshotPairs = [
      [DATA_JOBS, 'jobs.json'],
      [DATA_EXPIRED, 'expired-jobs.json'],
      [DATA_META, 'jobs-meta.json'],
      [DATA_SUMMARIES, 'jobs-crawler-summaries.json'],
    ];
    if (withStats) {
      snapshotPairs.push([DATA_STATS, 'jobs-stats.json']);
    }
    let snapshotted = 0;
    for (const [src, name] of snapshotPairs) {
      if (fs.existsSync(src)) {
        const dstPath = path.join(cacheDir, name);
        fs.copyFileSync(src, dstPath);
        // Preserve source mtime in the snapshot so subsequent HIT restores
        // can replay the exact mtime — see the HIT-path utimesSync above.
        const srcStat = fs.statSync(src);
        fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime);
        snapshotted++;
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify({
      inputFingerprint,
      withStats,
      snapshotAt: new Date().toISOString(),
      fileCount: snapshotted,
    }, null, 2));
    console.log(`💾 assemble-jobs cached ${snapshotted} files at .cache/assemble-jobs/${cacheKey.slice(0, 12)}...`);

    // Prune sibling subdirs (older fingerprint entries) so the GH Actions
    // cache that wraps CACHE_ROOT doesn't accumulate stale snapshots over
    // time. Each cron run that touches a slice file changes the
    // inputFingerprint → new cacheKey → previously-saved subdir becomes
    // dead weight inside the tarball. Without this prune, the assemble-jobs
    // cache POST grew from ~5 small JSONs (~37 MB raw) to 540 MB compressed
    // on cold deploys (observed in run 25581472175). Mirrors the cluster-pages
    // fix (deploy 25593562039 / commit ca7cfa3a3b). Wrapped in its own
    // try/catch so a partial prune never breaks the just-written snapshot.
    try {
      for (const entry of fs.readdirSync(CACHE_ROOT)) {
        if (entry === cacheKey) continue;
        fs.rmSync(path.join(CACHE_ROOT, entry), { recursive: true, force: true });
      }
    } catch (pruneErr) {
      console.warn(`⚠️  assemble-jobs sibling-prune failed (non-fatal): ${pruneErr.message}`);
    }
  } catch (err) {
    console.warn(`⚠️  assemble-jobs cache snapshot failed (non-fatal): ${err.message}`);
  }

  console.log('✅ Assembly complete.');
}

/* ── CLI entry point ──────────────────────────────────────────────────── */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const withStats = process.argv.includes('--stats');
  assembleJobsDataset({ withStats })
    .then(() => {
      // Some optional SDKs imported during assembly can leave idle handles
      // open in CI. The CLI contract is done once artifacts are written.
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Assembly failed:', err?.message || err);
      process.exit(1);
    });
}
