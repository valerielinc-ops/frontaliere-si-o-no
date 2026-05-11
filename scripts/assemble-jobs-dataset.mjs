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
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createEmptyCrawlerSummaryStore,
  readCrawlerSummaryStore,
  writeCrawlerSummaryStore,
} from './lib/crawler-summary-store.mjs';
import { buildStableJobIdentity } from './lib/job-identity.mjs';
import { hardenJobsWithStructuredSalary } from './lib/structured-salary.mjs';
import { normalizeDescriptionBullets } from './lib/crawler-template.mjs';
import { computeCrawlerQualityAggregate, computeJobQualityScore, buildStableId, cleanPreviousSlugsPerLocale, isLocationExplicitlyForeign } from './lib/dedicated-crawler-common.mjs';
import { inferAnyCanton, isKnownSwissCity, isCantonOnlyLabel, findSwissCityInText } from './lib/target-swiss-locations.mjs';
import { filterFixtureJobs } from './lib/fixture-data-filter.mjs';

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
 */
export function registerCrawlerSummaryGuard(key, label) {
  process.on('exit', (code) => {
    if (_summaryWritten) return;
    try {
      writeSummaryCrawlerSlice({
        key,
        label: label || key,
        generatedAt: new Date().toISOString(),
        total: 0,
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

/* ── Assembler-specific identity ──────────────────────────────────────── */

/**
 * Build a deduplication key for the assembler.
 *
 * Unlike buildStableJobIdentity (which normalises URLs by stripping the hash),
 * we preserve the full raw URL including hash fragments. This is essential for
 * crawlers like Galenica that use hash-fragment URLs to distinguish individual
 * job positions (e.g. /it/jobs/#job.id=12345).
 *
 * Fallback chain: raw URL → slug → title+company+location
 */
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
 *   2. Cut at the first sentence boundary (`.`, `;`, newline).
 *   3. Strip a leading `:` / whitespace left over from `Location:Ticino`.
 *   4. Trim.
 *   5. If the value still smells like prose (>60 char OR contains tell-tale
 *      body-content keywords), fall back to "Ticino" — by-crawler files are
 *      Ticino-targeted, so the canton label is a safe, audit-friendly default.
 */
function sanitizeJobLocationField(rawValue) {
  if (typeof rawValue !== 'string') return rawValue;
  const original = rawValue;
  let s = original
    .replace(/^.*?Location\s*[:.]?\s*/i, '')
    .split(/[\n.;]/)[0]
    .replace(/^[\s:]+/, '')
    .trim();
  if (s.length > 60 || /\b(availability|offer you|requirements|inspektionen|home ?office|company address|posizione esclusivamente|ottima conoscenza|befristet)\b/i.test(s)) {
    return 'Ticino';
  }
  return s === '' ? original : s;
}

function assemblerIdentity(job = {}) {
  const rawUrl = String(job.url || '').trim().toLowerCase().replace(/\/+$/, '');
  if (rawUrl) return `url:${rawUrl}`;

  // Delegate to the shared identity for non-URL fallbacks
  return buildStableJobIdentity(job);
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
 * Cache key = sha256(filePath \0 size \0 mtimeMs \0 …) of every slice file
 * across the three input directories. We use stat metadata (cheap) instead
 * of hashing 50 MB of file contents (~5× slower) — mtime+size is good
 * enough because slice files are only touched by deterministic writes
 * from `writeJson`, never random concurrent edits.
 */
const CACHE_ROOT = path.join(ROOT, '.cache', 'assemble-jobs');
const DATA_STATS = path.join(ROOT, 'data', 'jobs-stats.json');

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
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      files.push(path.join(d, f));
    }
  }
  files.sort();
  const hasher = crypto.createHash('sha256');
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listSliceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== '.gitkeep' && !f.includes('-cache'))
    .map((f) => path.join(dir, f))
    .sort(); // lexicographic — deterministic order
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
];

const BOILERPLATE_MARKER_REGEX = /cerca .+ con sede a/i;

const CONTENT_HEADINGS_RE = /\b(COMPITI|PROFILO|Responsabilit[aà]|Requisiti|Qualifiche|Tasks|Requirements|Aufgaben|Anforderungen)\b/i;

const BOILERPLATE_THRESHOLD = 0.5; // 50%
const MIN_UNIQUE_WORDS = 30;

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

    const desc = String(job.descriptionByLocale?.it || '').trim();
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
 * Create or update a GitHub Issue for a boilerplate guard failure.
 * Best-effort: failures are logged but do not suppress the guard error.
 */
function _createBoilerplateGuardIssue(crawlerKey, report) {
  try {
    // Check for existing open issue
    const searchResult = execSync(
      `gh issue list --label parser-broken --state open --search "${crawlerKey}" --json number,title --limit 5`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();

    const existing = JSON.parse(searchResult || '[]');
    const existingIssue = existing.find(i => i.title?.includes(`[parser-health] ${crawlerKey}`));

    const dateStr = new Date().toISOString();
    const ratioPercent = Math.round(report.ratio * 100);

    if (existingIssue) {
      // Add comment to existing issue
      execSync(
        `gh issue comment ${existingIssue.number} --body "Updated: ${dateStr} — still detecting ${report.boilerplateCount}/${report.totalJobs} boilerplate jobs."`,
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

      execSync(
        `gh issue create --title "[parser-health] ${crawlerKey}: ${report.boilerplateCount}/${report.totalJobs} jobs have boilerplate-only descriptions" --label parser-broken --label automated --body ${JSON.stringify(body)}`,
        { encoding: 'utf8', timeout: 15000 },
      );
      console.log(`📋 Created new GitHub Issue for ${crawlerKey}`);
    }
  } catch (err) {
    console.warn(`⚠️  [boilerplate-guard] GitHub Issue creation failed: ${err.message}`);
  }
}

/**
 * Write a per-crawler jobs slice.
 *
 * Migrated crawlers call this instead of writing directly to data/jobs.json.
 * The assembler reads these slices and merges them into the global file.
 *
 * @param {string} crawlerKey   - Normalised company key (e.g. 'coop', 'galenica')
 * @param {object[]} jobs       - Array of job objects discovered in this run
 */
export function writeJobsCrawlerSlice(crawlerKey, jobs) {
  if (!crawlerKey || typeof crawlerKey !== 'string') {
    throw new TypeError('writeJobsCrawlerSlice: crawlerKey must be a non-empty string');
  }
  if (!Array.isArray(jobs)) {
    throw new TypeError('writeJobsCrawlerSlice: jobs must be an array');
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
  for (const job of jobs) {
    if (job.needsRetranslation) continue;
    const sl = job.sourceLang || 'it';
    const titles = job.titleByLocale || {};
    let needsFlag = false;
    for (const locale of ['it', 'en', 'de', 'fr']) {
      if (!titles[locale]) continue;
      // Cross-locale duplicate: title identical to source-language title
      if (locale !== sl && titles[locale] === titles[sl]) { needsFlag = true; break; }
      // Wrong-language words in title
      if (_hasWrongLangWords(titles[locale], locale)) { needsFlag = true; break; }
      // Wrong-language words in slug
      if (locale !== 'it' && _hasWrongLangWords((job.slugByLocale?.[locale] || '').replace(/-/g, ' '), locale, 3)) { needsFlag = true; break; }
    }
    if (needsFlag) { job.needsRetranslation = true; flagged++; }
  }
  if (flagged > 0) console.log(`🔍 Quality gate: flagged ${flagged} jobs with wrong-language content`);

  // Boilerplate guard: detect parsers that silently fell back to generic descriptions.
  if (!process.env.SKIP_BOILERPLATE_GUARD) {
    const bpReport = detectBoilerplateDescriptions(jobs, crawlerKey);
    if (bpReport.boilerplateCount > 0 && bpReport.ratio < BOILERPLATE_THRESHOLD) {
      for (const bj of bpReport.boilerplateJobs) {
        console.log(`[boilerplate-guard] ${bj.slug}: ${bj.reason} (${bj.uniqueWords} unique words)`);
      }
    }
    if (bpReport.ratio >= BOILERPLATE_THRESHOLD) {
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
  for (const job of hardened.jobs) {
    if (typeof job.description === 'string' && job.description) {
      const normalized = normalizeDescriptionBullets(job.description);
      if (normalized !== job.description) job.description = normalized;
    }
    if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
      for (const [locale, text] of Object.entries(job.descriptionByLocale)) {
        if (typeof text !== 'string' || !text) continue;
        const normalized = normalizeDescriptionBullets(text);
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
  for (const ej of (existingSlice?.jobs || [])) {
    if (ej.firstSeenAt) {
      const identity = buildStableJobIdentity(ej);
      if (identity) existingFirstSeen.set(identity, ej.firstSeenAt);
    }
  }
  const now = new Date().toISOString();
  for (const job of hardened.jobs) {
    if (!job.firstSeenAt) {
      const identity = buildStableJobIdentity(job);
      job.firstSeenAt = existingFirstSeen.get(identity) || job.crawledAt || now;
    }
  }

  const payload = {
    crawlerKey,
    assembledAt: new Date().toISOString(),
    jobs: hardened.jobs,
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
  for (const { path: slicePath, parsed: slice, error } of parsed) {
    if (!slice || !Array.isArray(slice.jobs)) {
      const reason = error ? ` (${error})` : '';
      console.warn(`⚠️  Skipping malformed slice: ${path.basename(slicePath)}${reason}`);
      continue;
    }
    slices.push(slice);
    console.log(`  📄 ${path.basename(slicePath)}: ${slice.jobs.length} jobs (assembledAt: ${slice.assembledAt || '?'})`);
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
  const byIdentity = new Map();
  for (const tagged of allTagged) {
    const identity = assemblerIdentity(tagged.job);
    if (!identity) continue;
    const existing = byIdentity.get(identity);
    if (!existing || tagged.assembledAt >= existing.assembledAt) {
      byIdentity.set(identity, tagged);
    }
  }

  const sliceJobs = [...byIdentity.values()].map((t) => t.job);

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
  const seenSlugs = new Set();
  let slugDupeCount = 0;
  const deduped = sorted.filter((job) => {
    const slug = String(job.slug || '').trim();
    if (!slug) return true; // keep slugless jobs (shouldn't happen, but safe)
    if (seenSlugs.has(slug)) {
      slugDupeCount++;
      return false;
    }
    seenSlugs.add(slug);
    return true;
  });

  if (slugDupeCount > 0) {
    console.log(`  🧹 Slug dedup: removed ${slugDupeCount} entries with duplicate slugs (${deduped.length} remaining)`);
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
    const cleanedLoc = sanitizeJobLocationField(job.location);
    const cleanedAddr = sanitizeJobLocationField(job.addressLocality);
    if (cleanedLoc !== job.location) {
      job.location = cleanedLoc;
      sanitizedLoc++;
    }
    if (cleanedAddr !== job.addressLocality) {
      job.addressLocality = cleanedAddr;
    }
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
  const SWISS_PC_RE = /^\d{4}$/;
  // Match: 5-digit ZIP within ~30 chars of an unambiguous foreign-country
  // word. Avoids false positives on lone numbers in tax/salary text.
  const FOREIGN_ADDRESS_RE = /\b\d{5}\b[\s\S]{0,40}?\b(?:Italy|Italia|Italie|Italien|France|Frankreich|Francia|Germany|Deutschland|Allemagne|Germania|Austria|Österreich|Autriche|Spagna|España|Spain|Espagne|Portugal|United Kingdom|UK\b|Belgium|Belgio|Belgien|Belgique|Netherlands|Nederland|Pays-Bas)\b/i;
  const isSwissPostalCode = (pc) => {
    const s = String(pc || '').trim();
    if (!SWISS_PC_RE.test(s)) return false;
    const n = +s;
    return n >= 1000 && n <= 9658; // BFS valid Swiss postal-code range
  };
  let droppedBadSwissCity = 0;
  let droppedCantonOnlyNoCity = 0;
  let droppedForeignAddress = 0;
  const swissValidated = foreignFiltered.filter((job) => {
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
      // Look for a Swiss city of ≥4 chars in description (avoids false
      // positives like "Sales" — a real FR commune — matching "Sales
      // Assistant" in English titles).
      const found = findSwissCityInText(haystack);
      if (found && found.length >= 4) return true;
      droppedCantonOnlyNoCity++;
      return false;
    }

    // Neither a known Swiss city nor a canton — likely a non-Swiss locality
    // that escaped the explicit-foreign blacklist (e.g. small Italian town).
    droppedBadSwissCity++;
    return false;
  });
  const totalDropped = droppedBadSwissCity + droppedCantonOnlyNoCity + droppedForeignAddress;
  if (totalDropped > 0) {
    console.log(`  🇨🇭 Swiss whitelist: excluded ${totalDropped} jobs (${droppedBadSwissCity} unknown locality, ${droppedCantonOnlyNoCity} canton-only without anchor, ${droppedForeignAddress} foreign address in description; ${swissValidated.length} remaining)`);
  }

  // ── Canton validation — fix mismatches using BFS data ──────────────
  // Some crawlers assign HQ canton instead of the actual city's canton.
  // Use inferAnyCanton (backed by 2,110 BFS municipalities) to correct.
  let cantonFixes = 0;
  let lowercaseFixes = 0;
  for (const job of swissValidated) {
    // Fix lowercase canton codes
    if (job.canton && job.canton !== job.canton.toUpperCase()) {
      job.canton = job.canton.toUpperCase();
      lowercaseFixes++;
    }
    const city = String(job.addressLocality || job.location || '').trim();
    if (!city || city.length < 2 || city === 'CH') continue;
    const inferred = inferAnyCanton(city);
    if (inferred && job.canton && job.canton !== inferred) {
      job.canton = inferred;
      if (job.addressRegion && job.addressRegion.length === 2) {
        job.addressRegion = inferred;
      }
      cantonFixes++;
    }
  }
  if (cantonFixes > 0 || lowercaseFixes > 0) {
    console.log(`  🏔️  Canton validation: fixed ${cantonFixes} mismatches, ${lowercaseFixes} lowercase codes`);
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
  for (const slicePath of sliceFiles) {
    const entry = readJson(slicePath, null);
    if (!entry || typeof entry.key !== 'string') {
      console.warn(`⚠️  Skipping malformed summary slice: ${path.basename(slicePath)}`);
      continue;
    }
    sliceEntries.push(entry);
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

  const bySlug = new Map();
  let totalSliceEntries = 0;

  for (const slicePath of sliceFiles) {
    const entries = readJson(slicePath, null);
    if (!Array.isArray(entries)) {
      console.warn(`⚠️  Skipping malformed expired slice: ${path.basename(slicePath)}`);
      continue;
    }
    totalSliceEntries += entries.length;
    for (const entry of entries) {
      if (!entry.slug) continue;
      const existing = bySlug.get(entry.slug);
      // Keep the most recently expired entry for each slug
      if (!existing || (entry.expiredAt || '') >= (existing.expiredAt || '')) {
        bySlug.set(entry.slug, entry);
      }
    }
  }

  // Also merge any existing aggregated expired-jobs.json (from deploy-time cleanup)
  const existingAgg = readJson(DATA_EXPIRED, []);
  if (Array.isArray(existingAgg)) {
    for (const entry of existingAgg) {
      if (!entry.slug) continue;
      const existing = bySlug.get(entry.slug);
      if (!existing || (entry.expiredAt || '') >= (existing.expiredAt || '')) {
        bySlug.set(entry.slug, entry);
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
function trackSlugHistoryDrift(priorJobs, activeJobs) {
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

    // Capture every old slug variant that exists on the prior entry but
    // is missing on the current one (including prior previousSlugs that
    // might have been dropped during a baseline filter — defensive).
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

    // Flat slug drift → push old `slug` into previousSlugs (legacy flat list).
    if (prior.slug && !knownNew.has(String(prior.slug))) {
      if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
      job.previousSlugs.push(String(prior.slug));
      knownNew.add(String(prior.slug));
      mergedSlugs++;
      driftedThisJob = true;
    }

    // Per-locale slug drift → push old `slugByLocale[locale]` into
    // `previousSlugsByLocale[locale]` (per-locale tracking). Preserves the
    // 4-locale bridge so any locale entry-point keeps resolving.
    if (prior.slugByLocale && typeof prior.slugByLocale === 'object') {
      for (const [locale, oldSlug] of Object.entries(prior.slugByLocale)) {
        if (!oldSlug) continue;
        const oldStr = String(oldSlug);
        if (knownNew.has(oldStr)) continue;
        if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') {
          job.previousSlugsByLocale = {};
        }
        if (!Array.isArray(job.previousSlugsByLocale[locale])) {
          job.previousSlugsByLocale[locale] = [];
        }
        job.previousSlugsByLocale[locale].push(oldStr);
        knownNew.add(oldStr);
        mergedSlugs++;
        driftedThisJob = true;
      }
    }

    // Also carry forward any previousSlugs from the prior entry that aren't
    // already on the current entry (defensive: keeps the history monotonically
    // growing even if a crawler slice rewrites the record from scratch).
    for (const s of (prior.previousSlugs || [])) {
      const sStr = String(s || '');
      if (!sStr || knownNew.has(sStr)) continue;
      if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
      job.previousSlugs.push(sStr);
      knownNew.add(sStr);
      mergedSlugs++;
    }
    if (prior.previousSlugsByLocale && typeof prior.previousSlugsByLocale === 'object') {
      for (const [locale, arr] of Object.entries(prior.previousSlugsByLocale)) {
        for (const s of (arr || [])) {
          const sStr = String(s || '');
          if (!sStr || knownNew.has(sStr)) continue;
          if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') {
            job.previousSlugsByLocale = {};
          }
          if (!Array.isArray(job.previousSlugsByLocale[locale])) {
            job.previousSlugsByLocale[locale] = [];
          }
          job.previousSlugsByLocale[locale].push(sStr);
          knownNew.add(sStr);
          mergedSlugs++;
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
 * Returns { cleanedExpired, ghostCount, mergedSlugs }.
 */
function reconcileGhostExpired(activeJobs, expiredJobs) {
  if (!activeJobs?.length || !expiredJobs?.length) {
    return { cleanedExpired: expiredJobs || [], ghostCount: 0, mergedSlugs: 0 };
  }

  // Build active lookup: title+company → first matching job
  const activeByTC = Object.create(null);
  for (const j of activeJobs) {
    const key = `${(j.title || '').toLowerCase().trim()}||${(j.company || '').toLowerCase().trim()}`;
    if (!activeByTC[key]) activeByTC[key] = j;
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
    const key = `${(ej.title || '').toLowerCase().trim()}||${(ej.company || '').toLowerCase().trim()}`;
    const match = activeByTC[key];

    // Ghost: slug overlap + title match, or exact same IT slug
    const sameItSlug = match && (ej.slugByLocale?.it === match.slugByLocale?.it);
    if (!match || (!hasSlugOverlap && !sameItSlug)) continue;

    // Mark as ghost
    ghostIds.add(ej.slug || ej.id || JSON.stringify(ej.slugByLocale));

    // Merge expired slugs into active job's previousSlugs
    const existingSlugs = new Set([
      ...(match.slugByLocale ? Object.values(match.slugByLocale) : []),
      ...(match.previousSlugs || []),
    ]);
    const newSlugs = [
      ...expSlugs.filter(s => s && !existingSlugs.has(s)),
      ...(ej.previousSlugs || []).filter(s => s && !existingSlugs.has(s)),
    ];
    const uniqueNew = [...new Set(newSlugs)];

    if (uniqueNew.length > 0) {
      if (!match.previousSlugs) match.previousSlugs = [];
      match.previousSlugs.push(...uniqueNew);
      mergedSlugs += uniqueNew.length;
    }
  }

  // Filter out ghosts
  const cleanedExpired = expiredJobs.filter(ej => {
    const id = ej.slug || ej.id || JSON.stringify(ej.slugByLocale);
    return !ghostIds.has(id);
  });

  const ghostCount = ghostIds.size;

  // Update per-crawler expired slices on disk
  if (ghostCount > 0) {
    const cleanedSlugSet = new Set();
    for (const ej of cleanedExpired) {
      if (ej.slug) cleanedSlugSet.add(ej.slug);
      if (ej.id) cleanedSlugSet.add(ej.id);
      if (ej.slugByLocale) Object.values(ej.slugByLocale).forEach(s => cleanedSlugSet.add(s));
    }

    const sliceFiles = listSliceFiles(EXPIRED_SLICES_DIR);
    for (const fp of sliceFiles) {
      const slice = readJson(fp, null);
      if (!Array.isArray(slice)) continue;
      const cleaned = slice.filter(ej => {
        if (ej.id && cleanedSlugSet.has(ej.id)) return true;
        if (ej.slug && cleanedSlugSet.has(ej.slug)) return true;
        const slugs = ej.slugByLocale ? Object.values(ej.slugByLocale) : [];
        return slugs.some(s => cleanedSlugSet.has(s));
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
    const batch = db.batch();
    const now = new Date().toISOString();

    for (const entry of entriesWithScores) {
      const docRef = db.collection(QUALITY_SCORES_COLLECTION).doc(entry.key);
      batch.set(docRef, {
        slug: entry.key,
        avgScore: entry.qualityScore.avgScore,
        breakdown: entry.qualityScore.breakdown,
        jobCount: entry.qualityScore.jobCount,
        lastUpdated: now,
        worstJobs: (entry.qualityScore.worstJobs || []).slice(0, 5),
      }, { merge: true });
    }

    await batch.commit();
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

    writeJson(DATA_JOBS, assembled);
    fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
    writeJson(PUBLIC_JOBS, assembled);
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
        writeJson(DATA_JOBS, assembled);
        writeJson(PUBLIC_JOBS, assembled);
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
      writeJson(DATA_JOBS, assembled);
      writeJson(PUBLIC_JOBS, assembled);
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
        writeJson(DATA_JOBS, assembled);
        writeJson(PUBLIC_JOBS, assembled);
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
        const enrichedFile = path.join(ROOT, 'data', 'orphan-enriched-data.json');
        if (fs.existsSync(orphanFile)) {
          const orphanSlugs = JSON.parse(fs.readFileSync(orphanFile, 'utf8'));
          const enrichedData = fs.existsSync(enrichedFile)
            ? JSON.parse(fs.readFileSync(enrichedFile, 'utf8'))
            : {};
          const orphanResult = reconcileOrphanSlugs(assembled, orphanSlugs, enrichedData, { dryRun: false, writeSlices: true });
          if (orphanResult.merged > 0) {
            console.log(`  🔗 Orphan reconciliation: ${orphanResult.merged} slugs merged into active jobs' previousSlugs`);
            writeJson(DATA_JOBS, assembled);
            writeJson(PUBLIC_JOBS, assembled);
          }
        }

        // Reconcile expired slugs → merge into active jobs' previousSlugs
        const expResult = reconcileExpiredSlugs(assembled, cleanedExpired, { dryRun: false, writeSlices: true });
        if (expResult.merged > 0) {
          console.log(`  🔗 Expired reconciliation: ${expResult.merged} slugs merged into active jobs' previousSlugs`);
          writeJson(DATA_JOBS, assembled);
          writeJson(PUBLIC_JOBS, assembled);
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
  assembleJobsDataset({ withStats }).catch((err) => {
    console.error('❌ Assembly failed:', err?.message || err);
    process.exit(1);
  });
}
