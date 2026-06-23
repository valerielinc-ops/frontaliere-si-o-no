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
 * Wall-clock budget (ELAPSED-AWARE, #2212): the effective budget is the SMALLER
 * of (a) LOCAL_MT_TIME_BUDGET_MS, a per-step ceiling fresh from THIS process's
 * start, and (b) the time left until a run-wide deadline (LOCAL_MT_MOPUP_DEADLINE_MS,
 * default 320min) measured from the SHARED run start the cascade published
 * (scripts/lib/translate-run-clock.mjs). Mirroring the cascade's own elapsed-aware
 * budget, this prevents a cascade that overflowed its 250min gate + a fresh full
 * mop-up + commit/scatter/slug/deploy from approaching the 350min job timeout and
 * losing uncommitted incremental writes. When no run-start marker exists (local
 * run / cascade skipped) the reference falls back to this process's own start, so
 * standalone behaviour is unchanged (bounded purely by LOCAL_MT_TIME_BUDGET_MS).
 *
 * Usage:
 *   node scripts/local-mt-mopup.mjs [--max-jobs N] [--dry-run]
 * Env:
 *   LOCAL_MT_MAX_JOBS          — cap jobs processed (default 2000; --max-jobs wins)
 *   LOCAL_MT_TIME_BUDGET_MS    — per-step wall-clock ceiling (default 280*60*1000)
 *   LOCAL_MT_MOPUP_DEADLINE_MS — run-wide deadline from run start (default 320*60*1000)
 *   LOCAL_MT_PYTHON            — python interpreter (default 'python3')
 *   LOCAL_MT_DRY_RUN=1         — scan + report only, no Python call, no writes
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isIncomplete, reconcileRetranslationState } from './relocalize-pending-jobs.mjs';
import { readRunStartMs, markRunStart } from './lib/translate-run-clock.mjs';
import { balanceMarkdownMarkers } from './lib/free-translate.mjs';
import { applyGlossaryCorrections } from './lib/translation-glossary.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const PY_SCRIPT = path.join(__dirname, 'local-mt-translate.py');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;

const PYTHON = process.env.LOCAL_MT_PYTHON || 'python3';
// Per-step ceiling: a fresh budget measured from THIS process's start.
const STATIC_TIME_BUDGET_MS = Number(process.env.LOCAL_MT_TIME_BUDGET_MS) || 280 * 60 * 1000;
// Run-wide deadline measured from the run start the cascade published. Bounds the
// mop-up relative to the SAME reference the cascade uses, leaving ~30min under the
// 350min job timeout for commit/scatter/slug/deploy.
const MOPUP_DEADLINE_MS = Number(process.env.LOCAL_MT_MOPUP_DEADLINE_MS) || 320 * 60 * 1000;
// Effective budget is ELAPSED-AWARE (#2212): the smaller of the per-step ceiling
// and the time LEFT until the run-wide deadline. Falls back to this process's own
// start when no run-start marker exists (local run / cascade skipped), so the
// standalone budget stays exactly LOCAL_MT_TIME_BUDGET_MS.
const RUN_START_MS = readRunStartMs() ?? Date.now();
const TIME_BUDGET_MS = Math.min(
  STATIC_TIME_BUDGET_MS,
  Math.max(0, MOPUP_DEADLINE_MS - (Date.now() - RUN_START_MS)),
);
// Reserve 5min after the spawn kill for the JSON-write phase.
// spawnSync timeout = TIME_BUDGET_MS - WRITE_RESERVE_MS so that when ETIMEDOUT
// fires, Date.now()-started is still < TIME_BUDGET_MS and budgetOk() stays true.
const WRITE_RESERVE_MS = 5 * 60 * 1000;

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
  // Publish the run start (WRITE-ONCE) so that under the Argos-first ordering this
  // BULK pass (Phase 2a) — which runs BEFORE the cascade — establishes the shared
  // run clock. The cascade (Phase 2b) and the leftover mop-up (Phase 2c) then bound
  // their elapsed-aware deadlines to the TRUE whole-job start, keeping the total
  // under the 350min timeout. No-op when a marker already exists (cascade-first, or
  // this being the Phase 2c pass after the cascade seeded it). Uses this process's
  // start (RUN_START_MS falls back to now() when no marker exists yet).
  markRunStart(RUN_START_MS);

  // Elapsed-aware early-out (#2212): if the cascade already consumed the run-wide
  // window, there is no time to safely run a Python batch (spawn timeout =
  // TIME_BUDGET_MS - WRITE_RESERVE_MS would be non-positive, which spawnSync
  // treats as "no timeout" = unbounded). Step aside so the always()-guarded commit
  // step runs well before the 350min job timeout instead of risking a kill.
  if (TIME_BUDGET_MS <= WRITE_RESERVE_MS) {
    const elapsedMin = Math.round((Date.now() - RUN_START_MS) / 60000);
    console.log(`⏰ [local-mt] Run-wide budget effectively exhausted (${Math.round(TIME_BUDGET_MS / 1000)}s left of the ${Math.round(MOPUP_DEADLINE_MS / 60000)}min deadline, ~${elapsedMin}min elapsed) — skipping mop-up so the commit step runs before the job timeout. Leftovers stay flagged for the next run.`);
    return;
  }

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
    timeout: TIME_BUDGET_MS - WRITE_RESERVE_MS,
  });

  const timedOut = proc.error?.code === 'ETIMEDOUT';
  // ENOBUFS: stdout exceeded maxBuffer — proc.stdout holds up to maxBuffer of
  // captured output; treat like ETIMEDOUT and fall through to parse the partial
  // JSONL rather than dropping all work for the run.
  const bufOverflow = proc.error?.code === 'ENOBUFS';
  if (proc.error && !timedOut && !bufOverflow) {
    console.error(`❌ [local-mt] Failed to spawn Python worker: ${proc.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (timedOut) {
    // Process stalled: killed by the timeout guard. Fall through to parse
    // whatever partial stdout was captured before the kill so partial results
    // are committed rather than lost.
    console.warn(`⏰ [local-mt] Python worker killed after ${Math.round(TIME_BUDGET_MS / 60000)}min timeout — will commit partial results.`);
  } else if (bufOverflow) {
    console.warn(`⚠️  [local-mt] Python worker stdout exceeded 256 MB maxBuffer — parsing captured partial results. Consider reducing --max-jobs or LOCAL_MT_MAX_JOBS.`);
  } else if (proc.status !== 0) {
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

      const raw = String(text || '').trim();
      if (!raw) continue; // never write empty (safety guard)

      // Source text for the copy guards — computed BEFORE glossary so corrections
      // compare against the true source.
      const sourceText = field === 'title'
        ? (job.title || job.titleByLocale?.[srcLang] || '').trim()
        : (job.description || job.descriptionByLocale?.[srcLang] || '').trim();

      // Quality parity with the cascade's finalize() (free-translate.mjs): balance
      // markdown markers, then apply the protected-term glossary. The raw Argos
      // output skipped both, so the BULK of the mop-up-translated corpus (the
      // workhorse tier) shipped lower quality than the cascade's — orphan `**`
      // leaking as literal markers, and meaning-inverted MT (e.g. DE "Nachtwache"
      // → IT "orologio notturno") never corrected. fieldType scopes the glossary's
      // broad single-word fallbacks to titles only (body prose stays untouched).
      const incoming = applyGlossaryCorrections({
        sourceText,
        translatedText: balanceMarkdownMarkers(raw),
        targetLang: locale,
        fieldType: field,
      }).trim();
      if (!incoming) continue;

      // Never write a value that is just a copy of the source (would re-flag).
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
