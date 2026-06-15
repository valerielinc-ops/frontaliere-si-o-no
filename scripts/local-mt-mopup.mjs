#!/usr/bin/env node
/**
 * local-mt-mopup.mjs — IN-PROCESS, $0, no-external-API translation MOP-UP tier.
 *
 * Runs AFTER the cascade-based "Phase 2: Translate pending jobs"
 * (relocalize-pending-jobs.mjs) in translate-pending.yml. The cascade burns
 * premium/public-LibreTranslate quota first; whatever it leaves incomplete this
 * step finishes with an unlimited self-hosted engine — Argos Translate loaded as
 * a direct Python library (no HTTP server, no healthcheck race; see
 * scripts/local-mt-translate.py for the engine rationale).
 *
 * It is DECOUPLED from scripts/lib/free-translate.mjs (edited in parallel by
 * another agent) — it shells to Python and never touches the cascade.
 *
 * What it does:
 *   1. Scans data/jobs/by-crawler/*.json for jobs that still need translation,
 *      reusing the EXACT predicate semantics from relocalize-pending-jobs.mjs
 *      (imported isIncomplete + the same needsRetranslation/suppression gate).
 *   2. For each such job, computes which locale title/description fields are
 *      actually MISSING (mirroring isIncomplete's per-locale checks) and builds a
 *      translation request FROM the job's source locale.
 *   3. Runs scripts/local-mt-translate.py ONCE (models loaded once) over the
 *      whole batch via JSONL stdin/stdout.
 *   4. Merges results back into the SAME per-crawler slice files, with the same
 *      safety guards used by relocalize's syncTranslationsToCrawlerFile (never
 *      overwrite a good translation with a source copy, never write empty), then
 *      clears needsRetranslation via the imported reconcileRetranslationState
 *      ONLY when the locale actually became complete.
 *
 * Wall-clock budget: stops queuing NEW work after LOCAL_MT_TIME_BUDGET_MS
 * (default 280min) so the workflow's commit step runs before the 350min job
 * timeout. The Python call itself is bounded by the batch already assembled.
 *
 * Usage:
 *   node scripts/local-mt-mopup.mjs [--max-jobs N] [--dry-run]
 * Env:
 *   LOCAL_MT_MAX_JOBS        — cap jobs processed (default 2000; --max-jobs wins)
 *   LOCAL_MT_TIME_BUDGET_MS  — wall-clock budget (default 280*60*1000)
 *   LOCAL_MT_PYTHON          — python interpreter (default 'python3')
 *   LOCAL_MT_DRY_RUN=1       — scan + report only, no Python call, no writes
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isIncomplete, reconcileRetranslationState } from './relocalize-pending-jobs.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const PY_SCRIPT = path.join(__dirname, 'local-mt-translate.py');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;

const PYTHON = process.env.LOCAL_MT_PYTHON || 'python3';
const TIME_BUDGET_MS = Number(process.env.LOCAL_MT_TIME_BUDGET_MS) || 280 * 60 * 1000;

function parseFlag(name) {
  return process.argv.slice(2).includes(name);
}
function parseOpt(name, fallback) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const DRY_RUN = parseFlag('--dry-run') || String(process.env.LOCAL_MT_DRY_RUN || '0') === '1';
const MAX_JOBS = Number(parseOpt('--max-jobs', process.env.LOCAL_MT_MAX_JOBS)) || 2000;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Same gate relocalize-pending-jobs.mjs uses to decide a job needs work, minus
 * the cross-file sourceChangedSinceSuppression nuance which is irrelevant here
 * (we never advance the give-up counter — this is a best-effort mop-up). A job is
 * in scope when it is flagged for retranslation OR has incomplete locale
 * coverage, and is NOT currently suppressed.
 */
function needsWork(job) {
  if (job.localeMismatchSuppressed) return false;
  if (job.needsRetranslation) return true;
  return isIncomplete(job);
}

/**
 * For a job in scope, return the list of { locale, field } slots that are
 * actually missing/inadequate and should be (re)translated from the source
 * locale. Mirrors the per-locale "missing or too short" / "source copy" checks
 * in isIncomplete() at field granularity — we only fill genuinely-bad slots so
 * we never clobber a good existing translation.
 */
function missingSlots(job) {
  const srcLang = job.sourceLang || 'it';
  const tbl = job.titleByLocale || {};
  const dbl = job.descriptionByLocale || {};
  const sourceTitle = (job.title || tbl[srcLang] || '').trim();
  const sourceDesc = (job.description || dbl[srcLang] || '').trim();
  const sourceTitleLc = sourceTitle.toLowerCase();
  const sourceDescLc = sourceDesc.toLowerCase();
  const slots = [];

  for (const locale of LOCALES) {
    if (locale === srcLang) continue;
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();

    // Title missing, too short, or an untranslated copy of the source title.
    if (sourceTitle.length >= MIN_TITLE_CHARS &&
        (title.length < MIN_TITLE_CHARS || title.toLowerCase() === sourceTitleLc)) {
      slots.push({ locale, field: 'title' });
    }

    // Description missing, too short, or an untranslated copy of the source desc.
    if (sourceDesc.length >= MIN_DESC_CHARS &&
        (desc.length < MIN_DESC_CHARS || desc.toLowerCase() === sourceDescLc)) {
      slots.push({ locale, field: 'description' });
    }
  }
  return slots;
}

function normalizeCompanyKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  console.log('🔍 [local-mt] Scanning per-crawler slices for translation gaps...\n');

  if (!fs.existsSync(BY_CRAWLER_DIR)) {
    console.log('ℹ️  by-crawler dir not found — nothing to do.');
    return;
  }

  const sliceFiles = fs.readdirSync(BY_CRAWLER_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('-locale-cache'))
    .sort();

  // Build the batch: a flat list of translation requests + back-references so we
  // can write each result into the right { file, jobIndex, locale, field }.
  const requests = [];   // { id, text, from, to }
  const targets = new Map(); // id -> { file, jobIdx, locale, field }
  const jobsInScope = []; // { file, jobIdx } (deduped)
  const jobSeen = new Set();
  let scannedJobs = 0;
  let nextId = 0;

  for (const file of sliceFiles) {
    const filePath = path.join(BY_CRAWLER_DIR, file);
    const data = readJson(filePath);
    if (!data || !Array.isArray(data.jobs)) continue;

    for (let jobIdx = 0; jobIdx < data.jobs.length; jobIdx++) {
      scannedJobs++;
      const job = data.jobs[jobIdx];
      if (!needsWork(job)) continue;

      const slots = missingSlots(job);
      if (slots.length === 0) continue;

      if (jobsInScope.length >= MAX_JOBS) break;

      const srcLang = job.sourceLang || 'it';
      const tbl = job.titleByLocale || {};
      const dbl = job.descriptionByLocale || {};
      const sourceTitle = (job.title || tbl[srcLang] || '').trim();
      const sourceDesc = (job.description || dbl[srcLang] || '').trim();

      let queued = 0;
      for (const { locale, field } of slots) {
        const text = field === 'title' ? sourceTitle : sourceDesc;
        if (!text) continue;
        const id = `r${nextId++}`;
        requests.push({ id, text, from: srcLang, to: locale });
        targets.set(id, { file, jobIdx, locale, field });
        queued++;
      }
      if (queued > 0) {
        const key = `${file}#${jobIdx}`;
        if (!jobSeen.has(key)) { jobSeen.add(key); jobsInScope.push({ file, jobIdx }); }
      }
    }
    if (jobsInScope.length >= MAX_JOBS) break;
  }

  console.log(`📊 [local-mt] Scanned ${scannedJobs} jobs across ${sliceFiles.length} slices.`);
  console.log(`   ${jobsInScope.length} jobs in scope · ${requests.length} field translations queued.\n`);

  if (requests.length === 0) {
    console.log('✅ [local-mt] Nothing to mop up — all locale fields already complete.');
    return;
  }

  if (DRY_RUN) {
    console.log('🏁 [local-mt] Dry run — not invoking Python, not writing slices.');
    const sample = requests.slice(0, 5)
      .map((r) => `   ${r.from}->${r.to} [${(r.text || '').slice(0, 50)}…]`)
      .join('\n');
    console.log('   Sample requests:\n' + sample);
    return;
  }

  // Run the Python worker ONCE over the whole batch (models loaded once).
  const jsonl = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  console.log(`🐍 [local-mt] Invoking ${PYTHON} ${path.relative(ROOT, PY_SCRIPT)} on ${requests.length} requests...`);
  const started = Date.now();
  const proc = spawnSync(PYTHON, [PY_SCRIPT], {
    input: jsonl,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (proc.error) {
    console.error(`❌ [local-mt] Failed to spawn Python worker: ${proc.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (proc.status !== 0) {
    console.error(`❌ [local-mt] Python worker exited with status ${proc.status}.`);
    process.exitCode = 1;
    return;
  }

  // Parse JSONL responses.
  const results = new Map(); // id -> translated text
  let okCount = 0;
  let errCount = 0;
  for (const line of (proc.stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let res;
    try { res = JSON.parse(trimmed); } catch { continue; }
    if (res && res.id && typeof res.text === 'string' && res.text.trim()) {
      results.set(res.id, res.text);
      okCount++;
    } else {
      errCount++;
    }
  }
  console.log(`   ✅ ${okCount} translated · ${errCount} failed · ${Math.round((Date.now() - started) / 1000)}s\n`);

  if (okCount === 0) {
    console.log('⚠️  [local-mt] Zero successful translations — leaving slices untouched.');
    return;
  }

  // Group results by file → apply, with the same write guards relocalize uses.
  const budgetOk = () => (Date.now() - started) < TIME_BUDGET_MS;
  const byFile = new Map(); // file -> array of { jobIdx, locale, field, text }
  for (const [id, text] of results) {
    const tgt = targets.get(id);
    if (!tgt) continue;
    if (!byFile.has(tgt.file)) byFile.set(tgt.file, []);
    byFile.get(tgt.file).push({ ...tgt, text });
  }

  let filesWritten = 0;
  let fieldsFilled = 0;
  let flagsCleared = 0;

  for (const [file, edits] of byFile) {
    if (!budgetOk()) {
      console.log('⏰ [local-mt] Time budget reached — stopping before remaining files (already-translated fields stay in memory but unwritten).');
      break;
    }
    const filePath = path.join(BY_CRAWLER_DIR, file);
    const data = readJson(filePath);
    if (!data || !Array.isArray(data.jobs)) continue;

    let fileChanged = false;
    const touchedJobs = new Set();

    for (const { jobIdx, locale, field, text } of edits) {
      const job = data.jobs[jobIdx];
      if (!job) continue;
      const srcLang = job.sourceLang || 'it';
      if (locale === srcLang) continue; // never write the source locale

      const bag = field === 'title' ? 'titleByLocale' : 'descriptionByLocale';
      if (!job[bag] || typeof job[bag] !== 'object') job[bag] = {};

      const incoming = String(text || '').trim();
      if (!incoming) continue; // never write empty (safety guard)

      // Never write a value that is just a copy of the source (would re-flag).
      const sourceText = field === 'title'
        ? (job.title || job.titleByLocale?.[srcLang] || '').trim()
        : (job.description || job.descriptionByLocale?.[srcLang] || '').trim();
      if (incoming.toLowerCase() === sourceText.toLowerCase()) continue;

      const existing = String(job[bag][locale] || '').trim();
      // Don't overwrite an already-good translation (one that isn't a source copy
      // and meets the min length). Only fill genuinely-missing/bad slots.
      const existingIsBad = existing.length < (field === 'title' ? MIN_TITLE_CHARS : MIN_DESC_CHARS)
        || existing.toLowerCase() === sourceText.toLowerCase();
      if (existing && !existingIsBad) continue;

      job[bag][locale] = incoming;
      fileChanged = true;
      fieldsFilled++;
      touchedJobs.add(jobIdx);
    }

    // Clear needsRetranslation ONLY when the job is now actually complete.
    for (const jobIdx of touchedJobs) {
      const job = data.jobs[jobIdx];
      if (job && job.needsRetranslation) {
        const outcome = reconcileRetranslationState(job, { attempted: false });
        if (outcome === 'cleared') { flagsCleared++; fileChanged = true; }
      }
    }

    if (fileChanged) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      filesWritten++;
    }
  }

  console.log(`\n📈 [local-mt] Mop-up results:`);
  console.log(`   ${fieldsFilled} locale fields filled across ${filesWritten} slice files`);
  console.log(`   ${flagsCleared} needsRetranslation flags cleared (now complete)`);
  console.log('✅ [local-mt] Local MT mop-up complete.');
}

main().catch((err) => {
  console.error('❌ [local-mt] Mop-up failed:', err?.message || err);
  process.exit(1);
});
