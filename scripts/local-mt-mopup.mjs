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
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isIncomplete, reconcileRetranslationState } from './relocalize-pending-jobs.mjs';
import { titleLooksUntranslated } from './lib/job-locale-utils.mjs';
import { readRunStartMs, markRunStart } from './lib/translate-run-clock.mjs';
import { balanceMarkdownMarkers } from './lib/free-translate.mjs';
import { finalizeTranslatedText, maskProtectedTokens } from './lib/translation-glossary.mjs';
import { buildTrafficPriority, formatPriorityReport, TRAFFIC_SOURCE_PATH } from './lib/job-traffic-priority.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const PY_SCRIPT = path.join(__dirname, 'local-mt-translate.py');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;
const MIN_TITLE_CHARS = 3;

/**
 * Rollout switch for the language arm of classifyMopupWrite() (workspace issue
 * 16). Default OFF, and OFF does not mean blind: the arm still runs and still
 * counts, it only withholds the write, so a production run can be READ before
 * it is allowed to act. Same repo-variable idiom as
 * TITLE_MISTRANSLATION_QUEUE_CEILING in
 * .github/corpus-workflows/translate-pending.yml, which means flipping it is a
 * one-line PR on the site that reaches the corpus through the `identical`
 * mirror — no admin rights on the corpus repo, and the same one line reverts it.
 */
const LANG_AWARE_OVERWRITE = String(process.env.LOCAL_MT_LANG_AWARE_OVERWRITE || '0') === '1';

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
export function needsWork(job) {
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
 *
 * Title also goes through titleLooksUntranslated() — the same lexicon-based
 * detector mark-mistranslated-jobs.mjs uses to set needsRetranslation. Without
 * it, a title that is PRESENT and long enough (so the length/copy checks below
 * pass) but still partially source-language (binnen-i, compound-residue,
 * function-word/orthography leftovers, token-overlap) was invisible here: it
 * never reached this free/unlimited tier and sat exclusively on the
 * quota-capped AI cascade (issue #6354), which is 81.5% of the flagged
 * backlog on the 2026-08-18 snapshot.
 */
export function missingSlots(job) {
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

    // Title missing, too short, or an untranslated copy of the source title —
    // these three need a meaningful sourceTitle to compare against, so they
    // stay gated on the floor. titleLooksUntranslated() is lexical and does
    // NOT depend on the source title's length (mirrors the un-gated call in
    // mark-mistranslated-jobs.mjs's titleOffence(), the sibling that sets the
    // SAME needsRetranslation flag this loop drains) — gating it on
    // MIN_TITLE_CHARS would silently exempt any job whose source title is
    // shorter than the floor from the lexical check too (issue #6539).
    const tooShortOrCopy = sourceTitle.length >= MIN_TITLE_CHARS &&
      (title.length < MIN_TITLE_CHARS || title.toLowerCase() === sourceTitleLc);
    const lexicallyUntranslated = titleLooksUntranslated({
      title,
      sourceTitle,
      sourceLang: srcLang,
      targetLocale: locale,
      company: job.company || '',
      location: job.location || '',
    }).untranslated;
    if (tooShortOrCopy || lexicallyUntranslated) {
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

/**
 * Protected TOKENS — the mop-up's half of the guard, applied BEFORE the batch is
 * handed to Python.
 *
 * Handed the raw DACH gender code, a machine translator is free to read the
 * letters as words and does: live IT titles came back as
 * "(lunedì/mercoledì/d)" (m→Monday, w→Wednesday). Argos is no different from the
 * HTTP cascade (free-translate.mjs) or the local providers
 * (job-localization-pipeline.mjs) in this respect — and since this tier produces
 * the BULK of the mop-up-translated corpus, leaving it unmasked would keep the
 * defect alive on the highest-volume writer while the other two were fixed.
 *
 * `maskProtectedTokens` returns the input byte-identical when there is nothing
 * to protect, so the JSONL payload handed to Python is unchanged for the
 * overwhelming majority of requests.
 *
 * @returns {{ request: {id: string, text: string, from: string, to: string},
 *             protectedTokens: Array }}
 */
export function buildMopupRequest({ id, text, from, to }) {
  const { text: masked, tokens: protectedTokens } = maskProtectedTokens(text);
  return { request: { id, text: masked, from, to }, protectedTokens };
}

/**
 * The SAME single exit transform the other two translation entry points use —
 * `finalizeTranslatedText` (restore protected tokens in the target locale's
 * display form → protected-term glossary → placeholder strip) — reached by a
 * CALL, not by a re-implementation, so the three writers into the published
 * corpus cannot drift.
 *
 * Markdown-marker balancing runs first, exactly as in the cascade's finalize():
 * the raw Argos output leaks orphan `**` as literal markers.
 *
 * `fieldType` scopes the glossary's broad single-word fallbacks (and the
 * dropped-token re-append) to titles only, so a description body's legitimate
 * prose is never rewritten.
 *
 * @returns {string} '' when nothing meaningful survives — the caller skips the write.
 */
export function finalizeMopupTranslation({
  sourceText,
  rawText,
  targetLang,
  fieldType = 'title',
  protectedTokens = [],
}) {
  return finalizeTranslatedText({
    sourceText,
    translatedText: balanceMarkdownMarkers(String(rawText ?? '')),
    targetLang,
    fieldType,
    protectedTokens,
  }).trim();
}

/**
 * The write loop's REJECTION CHAIN, in one place, so the thing that decides
 * whether an Argos output reaches the corpus is a single callable instead of a
 * sequence of inline `continue`s only main() can reach.
 *
 * Extracted for the reject audit (workspace issue 13): the pipeline drops ~96%
 * of the Argos outputs it successfully produces and no caller could observe
 * WHICH guard did it — the drops are silent and un-instrumented. An audit that
 * re-implemented this chain would be measuring a gate that does not exist, so
 * both main() below and scripts/research/argos-reject-audit.mjs call this.
 *
 * Order and semantics are byte-faithful to the previous inline chain, except
 * for the language-aware arm of the existing-value guard — see below.
 *
 * @returns {{decision: string, incoming: string, sourceText: string,
 *   existing: string, languageDriven: boolean}}
 *   decision is 'write' or one of 'skip:source-locale' | 'skip:empty-raw' |
 *   'skip:finalize-empty' | 'skip:source-copy' | 'skip:existing-good' |
 *   'skip:candidate-untranslated'. languageDriven marks the decisions the
 *   language arm made, the ones the rollout switch gates.
 */
export function classifyMopupWrite({
  job,
  locale,
  field,
  rawText,
  protectedTokens = [],
  langAware = true,
}) {
  const srcLang = job.sourceLang || 'it';
  const bag = field === 'title' ? 'titleByLocale' : 'descriptionByLocale';
  const sourceText = field === 'title'
    ? (job.title || job.titleByLocale?.[srcLang] || '').trim()
    : (job.description || job.descriptionByLocale?.[srcLang] || '').trim();
  const existing = String(job[bag]?.[locale] || '').trim();
  const base = { incoming: '', sourceText, existing };

  if (locale === srcLang) return { ...base, decision: 'skip:source-locale' };

  const raw = String(rawText || '').trim();
  if (!raw) return { ...base, decision: 'skip:empty-raw' };

  const incoming = finalizeMopupTranslation({
    sourceText,
    rawText: raw,
    targetLang: locale,
    fieldType: field,
    protectedTokens,
  });
  if (!incoming) return { ...base, decision: 'skip:finalize-empty' };

  // Never write a value that is just a copy of the source (would re-flag).
  if (incoming.toLowerCase() === sourceText.toLowerCase()) {
    return { ...base, incoming, decision: 'skip:source-copy' };
  }

  // Don't overwrite an already-good translation (one that isn't a source copy
  // and meets the min length). Only fill genuinely-missing/bad slots.
  const existingIsBad = existing.length < (field === 'title' ? MIN_TITLE_CHARS : MIN_DESC_CHARS)
    || existing.toLowerCase() === sourceText.toLowerCase();
  if (existing && !existingIsBad) {
    // LANGUAGE ARM (workspace issue 16). Length and byte-exact copy are not the
    // only ways an existing value can be bad: it can be the wrong LANGUAGE.
    // missingSlots() one screen up already knows that — it queues a title when
    // titleLooksUntranslated() says the slot is still in the source language —
    // and this guard used to not ask. So a German title in the IT slot was long
    // enough and not byte-identical to the source: the queue asked for a
    // repair, and the repair was thrown away unread, every run, forever.
    // Measured on origin/main: this guard blocks 18'606 title slots (54,3% of
    // all queued title slots) and 100% of them were queued by the language
    // detector — 303/303 in the sampled audit, and by construction over the
    // whole corpus. The two predicates did not disagree occasionally; they
    // disagreed on the entire blocked set.
    //
    // The CANDIDATE side is not optional. fix-untranslated-titles.mjs:78
    // objects that widening the verdict "would hand the same input to the same
    // cascade and overwrite a half-good title with, at best, the same half-good
    // title" — and it is right about any guard that re-enables the write by
    // looking only at `existing`. So the arm asks the SAME question of the
    // candidate with the SAME predicate: 49,6% of candidates fail it (binnen-i,
    // compound residue, source function words) and stay rejected. Of the ones
    // that pass, an A/B judgement against the stored text scored 83,1% an
    // improvement and 12,3% a regression, ~7:1.
    //
    // Measured and deliberately NOT added, both net-negative on the same judged
    // sample: a detectJobTitleLocaleDetails() check on the candidate (net +102
    // vs +109) and a minimum length ratio against the existing text (+109, a
    // wash). The minimum guard is also the best-measured one.
    //
    // Descriptions never reach here: missingSlots() queues a description on
    // exactly this same length-or-copy test, so the two predicates already
    // agree and the blocked set is empty (0 of 14'989 description slots).
    if (!langAware || field !== 'title') {
      return { ...base, incoming, decision: 'skip:existing-good' };
    }
    const ask = (title) => titleLooksUntranslated({
      title,
      sourceTitle: sourceText,
      sourceLang: srcLang,
      targetLocale: locale,
      company: job.company || '',
      location: job.location || '',
    });
    const existingVerdict = ask(existing);
    if (!existingVerdict.untranslated) {
      return { ...base, incoming, decision: 'skip:existing-good' };
    }
    const candidateVerdict = ask(incoming);
    if (candidateVerdict.untranslated) {
      return {
        ...base,
        incoming,
        decision: 'skip:candidate-untranslated',
        reason: candidateVerdict.reason,
        languageDriven: true,
      };
    }
    return {
      ...base,
      incoming,
      decision: 'write',
      reason: existingVerdict.reason,
      languageDriven: true,
    };
  }

  return { ...base, incoming, decision: 'write' };
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

  const sliceFiles = listSliceFileNames(BY_CRAWLER_DIR);

  // Build the FULL candidate list first — no early exit on MAX_JOBS here. The
  // old code capped mid-scan while walking sliceFiles alphabetically, so any
  // slice sorted after wherever the cap landed (e.g. postfinance.json,
  // richemont.json — both past position ~200/570) never got scanned, on any
  // run, ever: a permanent starvation the falling headline count could not
  // reveal (issue #6109 — same shape job-traffic-priority.mjs's header
  // describes for the cascade). Ordering the full candidate set below by the
  // same traffic-priority the cascade already uses fixes it for this free
  // tier too, at the cost of reading every slice instead of stopping early.
  const candidates = []; // { file, jobIdx, job, slots }
  let scannedJobs = 0;

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

      candidates.push({ file, jobIdx, job, slots });
    }
  }

  let popularity = readJson(path.join(ROOT, TRAFFIC_SOURCE_PATH));
  if (!popularity || typeof popularity !== 'object' || Array.isArray(popularity)) {
    console.warn(`⚠️  [local-mt] ${TRAFFIC_SOURCE_PATH} missing/unreadable — ordering this pass oldest-first instead (still fair, just not traffic-weighted).`);
    popularity = {};
  }
  // `freshFirst` è ACCESO qui e solo qui. Questo è il percorso gratuito —
  // Argos locale, cap 6.000 job per esecuzione, cinque esecuzioni al giorno —
  // cioè l'unico che abbia la capacità per il vincolo delle 24 ore: contro un
  // ingresso di ~1.421 annunci al giorno, la coorte fresca sta comodamente
  // dentro un singolo passaggio e non affama le altre due corsie.
  //
  // Il cascade AI (`relocalize-pending-jobs.mjs`) lo lascia spento apposta:
  // processa 53 job in 90 minuti per deadline, quindi una testa fresca da
  // 1.308 job gli mangerebbe tutti gli slot di ogni run senza nemmeno
  // smaltirla.
  const { order, stats } = buildTrafficPriority(candidates.map((c) => c.job), popularity, { freshFirst: true });
  for (const line of formatPriorityReport(stats)) console.log(line);

  const byJob = new Map(candidates.map((c) => [c.job, c]));
  const selected = order.slice(0, MAX_JOBS).map((job) => byJob.get(job)).filter(Boolean);

  // Build the batch: a flat list of translation requests + back-references so we
  // can write each result into the right { file, jobIndex, locale, field }.
  const requests = [];   // { id, text, from, to }
  const targets = new Map(); // id -> { file, jobIdx, locale, field }
  const jobsInScope = []; // { file, jobIdx } (deduped)
  const jobSeen = new Set();
  let nextId = 0;

  for (const { file, jobIdx, job, slots } of selected) {
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
      // Mask gender trigraphs so Argos never sees the raw code (see
      // buildMopupRequest). The sentinels are carried on the target entry and
      // restored — in the target locale's display form — by the write loop.
      const { request, protectedTokens } = buildMopupRequest({ id, text, from: srcLang, to: locale });
      requests.push(request);
      targets.set(id, { file, jobIdx, locale, field, protectedTokens });
      queued++;
    }
    if (queued > 0) {
      const key = `${file}#${jobIdx}`;
      if (!jobSeen.has(key)) { jobSeen.add(key); jobsInScope.push({ file, jobIdx }); }
    }
  }

  console.log(`📊 [local-mt] Scanned ${scannedJobs} jobs across ${sliceFiles.length} slices · ${candidates.length} candidates in the queue.`);
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
  // Observability for the language arm. Every slot that reached the guard chain
  // is counted under the decision that disposed of it, and the language-driven
  // ones are counted per detector reason, so a run can be read off the log
  // without re-running the audit. This is what makes "observe one run first"
  // mean something: with the switch OFF the shadow counters say exactly how
  // many fields the flip would rewrite, on the real production queue.
  const decisionTally = {};
  const langWriteReasons = {};
  const langSkipReasons = {};
  let shadowWithheld = 0;

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

    for (const { jobIdx, locale, field, text, protectedTokens } of edits) {
      const job = data.jobs[jobIdx];
      if (!job) continue;
      const srcLang = job.sourceLang || 'it';
      if (locale === srcLang) continue; // never write the source locale

      const bag = field === 'title' ? 'titleByLocale' : 'descriptionByLocale';
      if (!job[bag] || typeof job[bag] !== 'object') job[bag] = {};

      // Quality parity with the other two entry points: the SAME shared exit
      // transform (`finalizeTranslatedText`, via finalizeMopupTranslation) —
      // balance markdown markers, restore the masked gender trigraphs in the
      // target locale's display form, apply the protected-term glossary, strip
      // leaked template placeholders. The raw Argos output skipped all of it, so
      // the BULK of the mop-up-translated corpus (the workhorse tier) shipped
      // lower quality than the cascade's — orphan `**` leaking as literal
      // markers, meaning-inverted MT (e.g. DE "Nachtwache" → IT "orologio
      // notturno") never corrected, a German "(m/w/d)" surviving verbatim into an
      // Italian title, and a leaked "(ORGANIZZAZIONE)" reaching the dataset.
      // Returns '' when nothing meaningful survives, which the guard chain skips.
      // The whole chain (empty-raw → finalize-empty → source-copy →
      // existing-good → language arm) lives in classifyMopupWrite() so the
      // reject audit can observe it.
      const { decision, incoming, reason, languageDriven } = classifyMopupWrite({
        job, locale, field, rawText: text, protectedTokens,
      });
      decisionTally[decision] = (decisionTally[decision] || 0) + 1;
      if (languageDriven) {
        const bucket = decision === 'write' ? langWriteReasons : langSkipReasons;
        bucket[reason] = (bucket[reason] || 0) + 1;
      }
      if (decision !== 'write') continue;
      // Shadow arm: with the switch off, a language-driven write is counted and
      // withheld. The corpus is untouched and the log still reports the volume.
      if (languageDriven && !LANG_AWARE_OVERWRITE) {
        shadowWithheld++;
        continue;
      }

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
      // Atomic write: temp+rename so a SIGKILL mid-write cannot leave a
      // truncated slice that causes the subsequent assemble step to hard-fail.
      // NOTE: this script writes per-crawler slices only — never data/jobs.json
      // directly. data/jobs.json is written exclusively by assemble-jobs-dataset.mjs.
      const content = JSON.stringify(data, null, 2) + '\n';
      const tmp = `${filePath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, content, 'utf-8');
        fs.renameSync(tmp, filePath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
        throw err;
      }
      filesWritten++;
    }
  }

  console.log(`\n📈 [local-mt] Mop-up results:`);
  console.log(`   ${fieldsFilled} locale fields filled across ${filesWritten} slice files`);
  console.log(`   ${flagsCleared} needsRetranslation flags cleared (now complete)`);

  // Guard-chain report. Printed unconditionally: the point of the switch is to
  // be able to read a run before flipping it, which needs the numbers to be
  // there when it is still off.
  const sorted = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const totalDecisions = Object.values(decisionTally).reduce((a, b) => a + b, 0);
  console.log(`\n🚦 [local-mt] Write-guard decisions (${totalDecisions} slots reached the chain):`);
  for (const [decision, n] of sorted(decisionTally)) {
    const pct = totalDecisions ? ((100 * n) / totalDecisions).toFixed(1) : '0.0';
    console.log(`   ${decision.padEnd(28)} ${String(n).padStart(6)}  ${pct}%`);
  }
  const langWrites = Object.values(langWriteReasons).reduce((a, b) => a + b, 0);
  const langSkips = Object.values(langSkipReasons).reduce((a, b) => a + b, 0);
  console.log(`\n🌍 [local-mt] Language arm — LOCAL_MT_LANG_AWARE_OVERWRITE=${LANG_AWARE_OVERWRITE ? '1 (ENFORCING, writes applied)' : '0 (SHADOW, writes withheld)'}`);
  console.log(`   ${langWrites} wrong-language slots with a target-language candidate${LANG_AWARE_OVERWRITE ? ' → overwritten' : ` → WITHHELD (${shadowWithheld} not written)`}`);
  for (const [reason, n] of sorted(langWriteReasons)) console.log(`      existing was ${reason.padEnd(22)} ${String(n).padStart(6)}`);
  console.log(`   ${langSkips} wrong-language slots whose candidate was ALSO wrong-language → still rejected`);
  for (const [reason, n] of sorted(langSkipReasons)) console.log(`      candidate was ${reason.padEnd(21)} ${String(n).padStart(6)}`);
  if (!LANG_AWARE_OVERWRITE && langWrites > 0) {
    console.log(`   ℹ️  Set repo variable LOCAL_MT_LANG_AWARE_OVERWRITE=1 to apply these ${langWrites} writes.`);
  }
  console.log('✅ [local-mt] Local MT mop-up complete.');
}

/**
 * Direct-invocation guard — same shape as relocalize-pending-jobs.mjs, which
 * this module already imports.
 *
 * Two reasons it has to be here. (1) The pure seams above (buildMopupRequest /
 * finalizeMopupTranslation) are unit-tested, and importing the module must not
 * scan data/jobs/by-crawler and spawn Python. (2) main() calls markRunStart(),
 * and translate-run-clock.mjs documents that as "call ONLY when a script is
 * invoked directly — never on import"; without the guard, any importer seeded
 * the shared run clock with its own start time.
 */
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false; // node REPL / no script → not a direct invocation
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ [local-mt] Mop-up failed:', err?.message || err);
    process.exit(1);
  });
}
