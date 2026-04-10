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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEmptyCrawlerSummaryStore,
  readCrawlerSummaryStore,
  writeCrawlerSummaryStore,
} from './lib/crawler-summary-store.mjs';
import { buildStableJobIdentity } from './lib/job-identity.mjs';
import { hardenJobsWithStructuredSalary } from './lib/structured-salary.mjs';
import { computeCrawlerQualityAggregate, computeJobQualityScore, buildStableId, cleanPreviousSlugsPerLocale } from './lib/dedicated-crawler-common.mjs';

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

  const hardened = hardenJobsWithStructuredSalary(jobs);

  // Per-locale safety net: only strip a previousSlug if it matches the SAME
  // locale's active slug. Cross-locale matches are preserved for bridge pages.
  for (const job of hardened.jobs) {
    cleanPreviousSlugsPerLocale(job);
  }

  fs.mkdirSync(JOBS_SLICES_DIR, { recursive: true });
  const slicePath = path.join(JOBS_SLICES_DIR, `${crawlerKey}.json`);
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
function assembleJobs() {
  const sliceFiles = listSliceFiles(JOBS_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler job slices found — data/jobs.json left unchanged.');
    return null;
  }

  // Load all slices
  const slices = [];
  for (const slicePath of sliceFiles) {
    const slice = readJson(slicePath, null);
    if (!slice || !Array.isArray(slice.jobs)) {
      console.warn(`⚠️  Skipping malformed slice: ${path.basename(slicePath)}`);
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

  // ── Backfill empty description from descriptionByLocale ────────────
  // Some crawlers (skip_ai_translation=1 mode) write jobs with empty
  // description but populated descriptionByLocale. The build plugin
  // needs description for its validity filter, so backfill from Italian.
  let backfilledDescs = 0;
  for (const job of deduped) {
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
  for (const job of deduped) {
    if (!job.id) {
      job.id = buildStableId(job);
      backfilledIds++;
    }
  }
  if (backfilledIds > 0) {
    console.log(`  🆔 Backfilled ${backfilledIds} missing job IDs (of ${deduped.length} total)`);
  }

  return hardenJobsWithStructuredSalary(deduped).jobs;
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
      adzuna: 0,
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
  console.log('🔧 Assembling jobs dataset from per-crawler slices...');

  // --- Jobs ---
  const assembled = assembleJobs();
  if (assembled !== null) {
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
