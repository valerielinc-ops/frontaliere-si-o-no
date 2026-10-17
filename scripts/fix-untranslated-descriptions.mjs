#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * fix-untranslated-descriptions.mjs — Batch fix for jobs with source-copy descriptions.
 *
 * Finds jobs where descriptionByLocale[locale] is an exact or normalized copy of the source description
 * and translates them using the free-translate cascade (DeepL → SimplyTranslate → etc).
 *
 * Does NOT use AI/LLM — only the free cascade.
 * Does NOT modify titles, slugs, or needsRetranslation flags.
 *
 * Usage:
 *   node scripts/fix-untranslated-descriptions.mjs [--dry-run] [--max N] [--slice <basename>]
 *
 *   --slice limits the run to a single by-crawler slice (basename with or without
 *   .json, e.g. `banca-cler`) for surgical, single-company fixes.
 *
 * Env:
 *   UNTRANSLATED_DESCRIPTION_FIX_DEADLINE_MS — run-wide wall-clock deadline
 *     measured from the translate-pending run marker (default 300*60*1000).
 *     Standalone runs without a marker use this process's start time; the
 *     workflow fails closed if its marker is missing.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, getCascadeStats, getCodexTierStats, logCascadeSummary, setFallbackProviderConcurrency } from './lib/free-translate.mjs';
import { installCodexReserveReport } from './lib/codex-reserve-report.mjs';
import { MIN_TRANSLATION_CHARS, translationRejectionReason } from './lib/translation-quality.mjs';
import {
  isDescriptionSourceCopy,
  normalizeJobLocale,
  sourceLocaleTextCandidates,
  sourceLocaleTextForTranslation,
} from './lib/job-locale-utils.mjs';
import { resolveRunStartMs } from './lib/translate-run-clock.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
// Translation-quality gate lives in a shared leaf lib so every writer of the
// indexed descriptionByLocale dataset uses the SAME thresholds (single source
// of truth). Re-exported here for back-compat with existing importers/tests.
export {
  MIN_TRANSLATION_RATIO,
  MIN_TRANSLATION_CHARS,
  isAcceptableTranslation,
} from './lib/translation-quality.mjs';
const DRY_RUN = process.argv.includes('--dry-run');
const MAX = (() => {
  const idx = process.argv.indexOf('--max');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  const envMax = Number(process.env.UNTRANSLATED_DESCRIPTION_FIX_MAX);
  return Number.isFinite(envMax) && envMax > 0 ? envMax : Infinity;
})();
// Run-wide deadline measured from the shared translate-pending start marker.
// Standalone invocations keep a local fallback; the workflow requires the marker.
const DESCRIPTION_FIX_DEADLINE_MS = Number(process.env.UNTRANSLATED_DESCRIPTION_FIX_DEADLINE_MS)
  || 300 * 60 * 1000;
const RUN_START_MS = resolveRunStartMs();
const SLICE = (() => {
  const idx = process.argv.indexOf('--slice');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  return process.argv[idx + 1].replace(/\.json$/, '');
})();

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

/**
 * The slots of one slice that phase 2e repairs: a non-source locale whose
 * description is still a copy of the source (whitespace/entities aside).
 */
export function collectDescriptionFixTasks(jobs) {
  const tasks = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const sl = normalizeJobLocale(job?.sourceLang) || 'it';
    const sourceDescriptions = sourceLocaleTextCandidates(job, 'description');
    const sourceDesc = sourceLocaleTextForTranslation(job, 'description', 120);
    if (!sourceDesc || sourceDesc.length < 120) continue;
    const dbl = job.descriptionByLocale || {};
    for (const locale of LOCALES) {
      if (locale === sl) continue;
      const existing = (dbl[locale] || '').trim();
      if (!existing) continue;
      // Fix exact source copies and copies that differ only by whitespace/entities.
      if (!sourceDescriptions.some((source) =>
        source.length >= 120 && isDescriptionSourceCopy(existing, source))) continue;
      tasks.push({ job, locale, sl, sourceDesc });
    }
  }
  // Grouped by language pair, job order kept inside each pair: Codex joins
  // only queued texts of the same pair, and in job order the descriptions in
  // flight were split across it/en/fr (run 38937686046: 3.5 texts per call in
  // phase 2e against 11.3 in phase 2b).
  const pair = (task) => `${task.sl}>${task.locale}`;
  const pairOrder = [...new Set(tasks.map(pair))];
  return pairOrder.flatMap((key) => tasks.filter((task) => pair(task) === key));
}

const DESCRIPTION_FIX_CONCURRENCY_MAX = 8;

function boundedEnvInteger(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Descriptions in flight. Codex groups the texts queued while its lanes are
 * busy (FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS); one description at a time
 * only ever queued that description's own lines, so phase 2e sent 4.9 texts
 * per call against 7.4 in phase 2b (run 38686616395). With the lane up, two
 * descriptions per lane keep the queue fed. Without it (no broker, budget or
 * quota spent) the free providers take over, rate-limited per host: one at a
 * time, as before.
 */
export function descriptionFixConcurrency(codexStats) {
  const laneUp = codexStats?.lanePresent === true && !codexStats?.stopReason;
  if (!laneUp) return 1;
  const lanes = boundedEnvInteger('FREE_TRANSLATE_CODEX_LANES', 2, 1, 3);
  return boundedEnvInteger(
    'UNTRANSLATED_DESCRIPTION_FIX_CONCURRENCY',
    Math.min(DESCRIPTION_FIX_CONCURRENCY_MAX, lanes * 2),
    1,
    DESCRIPTION_FIX_CONCURRENCY_MAX,
  );
}

/**
 * Run `worker` over `tasks` in order with at most `limit()` in flight; the
 * limit is read before every start, so it drops to 1 as soon as Codex stops.
 * Returns 'deadline' when the run deadline stopped it, else 'done'.
 */
export async function runDescriptionFixPool(tasks, worker, { budgetOk = () => true, roomFor = () => true, limit = () => 1, onStart = () => {} } = {}) {
  const running = new Set();
  let next = 0;
  let outcome = 'done';
  while (next < tasks.length) {
    if (!budgetOk()) { outcome = 'deadline'; break; }
    if (!roomFor(running.size)) break;
    if (running.size >= Math.max(1, limit())) {
      await Promise.race(running);
      continue;
    }
    const task = tasks[next];
    next += 1;
    const pending = Promise.resolve()
      .then(() => worker(task))
      .finally(() => running.delete(pending));
    running.add(pending);
    // Called once a slot has really started, with the slots now in flight.
    onStart(running.size);
  }
  await Promise.all(running);
  return outcome;
}

async function main() {
  let files = listSliceFileNames(BY_CRAWLER_DIR);
  if (SLICE) {
    files = files.filter(f => f.replace(/\.json$/, '') === SLICE);
    if (files.length === 0) {
      console.error(`❌ No slice matching --slice "${SLICE}" in ${BY_CRAWLER_DIR}`);
      process.exit(1);
    }
    console.log(`🎯 Scoped to slice: ${SLICE}`);
  }
  let totalFixed = 0;
  let totalFailed = 0;
  /** @type {Record<string, number>} refusals by the rule that refused them */
  const refusals = {};
  let slicesChanged = 0;
  // What the pool really did (run 38937686046 sent Codex 3.5 texts per call,
  // the sequential figure): the limit is printed when it changes, the peak at
  // the end.
  let poolLimit = null;
  let poolPeak = 0;
  let charsTranslated = 0;
  const budgetOk = () => (Date.now() - RUN_START_MS) < DESCRIPTION_FIX_DEADLINE_MS;
  let deadlineReached = false;

  // Several descriptions run at once while Codex is up; the providers after it
  // stay one call at a time, as when this phase was sequential.
  setFallbackProviderConcurrency(1);
  if (!Number.isFinite(MAX) && MAX !== Infinity) {
    console.error(`❌ Invalid --max / UNTRANSLATED_DESCRIPTION_FIX_MAX: expected a number`);
    process.exit(1);
  }

  console.log(`🔧 Fixing untranslated descriptions across ${files.length} slices...`);
  {
    // The starting limit, printed even when no slice has work.
    const stats = getCodexTierStats();
    poolLimit = descriptionFixConcurrency(stats);
    console.log(`   descriptions in flight: up to ${poolLimit} (Codex lane ${stats?.lanePresent ? 'present' : 'absent'}${stats?.stopReason ? `, stopped: ${stats.stopReason}` : ''})`);
  }
  if (DRY_RUN) console.log('   (DRY RUN — no files will be modified)');
  if (MAX < Infinity) console.log(`   (MAX: ${MAX} descriptions)`);
  console.log('');

  for (const file of files) {
    if (!budgetOk()) {
      deadlineReached = true;
      break;
    }
    if (totalFixed + totalFailed >= MAX) break;

    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    if (jobs.length === 0) continue;

    let sliceChanged = false;
    const tasks = collectDescriptionFixTasks(jobs);

    const translateTask = async ({ job, locale, sl, sourceDesc }) => {
      // Translate using free cascade
      const translated = await freeTranslateWithRetry({
        text: sourceDesc,
        sourceLang: sl,
        targetLang: locale,
        fieldType: 'description',
        maxRetries: 1,
      });

      const isNewLanguage = translated && !isDescriptionSourceCopy(translated, sourceDesc);
      // Single source of truth: same gate the sibling writers use.
      const rejection = translationRejectionReason(sourceDesc, translated);
      const isAcceptable = rejection === null;

      if (isNewLanguage && isAcceptable && translated.length >= 120) {
        if (!DRY_RUN) {
          const dbl = job.descriptionByLocale || {};
          dbl[locale] = translated;
          job.descriptionByLocale = dbl;
          sliceChanged = true;
        }
        totalFixed++;
        charsTranslated += sourceDesc.length;
        // Log progress every 20 translations
        if (totalFixed % 20 === 0) {
          console.log(`   ... ${totalFixed} done, ${(charsTranslated / 1000).toFixed(0)}K chars`);
        }
      } else {
        // Diagnostic: a translation that passes the char floor but that the
        // quality gate refuses, with the rule that refused it.
        const refused =
          isNewLanguage &&
          translated &&
          translated.length >= MIN_TRANSLATION_CHARS &&
          !isAcceptable;
        if (refused) {
          const pct = ((translated.length / sourceDesc.length) * 100).toFixed(0);
          refusals[rejection] = (refusals[rejection] || 0) + 1;
          console.log(`  ⚠️  ${file.replace('.json', '')} [${locale}]: translation refused (${rejection}; ${pct}% of source, ${translated.length}/${sourceDesc.length} chars) — skipped`);
        }
        totalFailed++;
      }
    };

    const outcome = await runDescriptionFixPool(tasks, translateTask, {
      budgetOk,
      // Never start more slots than --max still allows, counting those in flight.
      roomFor: (inFlight) => totalFixed + totalFailed + inFlight < MAX,
      onStart: (inFlight) => { poolPeak = Math.max(poolPeak, inFlight); },
      limit: () => {
        const stats = getCodexTierStats();
        const current = descriptionFixConcurrency(stats);
        if (current !== poolLimit) {
          console.log(`   descriptions in flight: up to ${current} (Codex lane ${stats?.lanePresent ? 'present' : 'absent'}${stats?.stopReason ? `, stopped: ${stats.stopReason}` : ''})`);
          poolLimit = current;
        }
        return current;
      },
    });
    if (outcome === 'deadline') deadlineReached = true;

    if (sliceChanged && !DRY_RUN) {
      writeJson(slicePath, sliceData);
      slicesChanged++;
      console.log(`  ✅ ${file.replace('.json', '')}`);
    }

    if (deadlineReached) break;
  }
  if (deadlineReached) {
    const elapsedMin = Math.round((Date.now() - RUN_START_MS) / 60000);
    console.log(`\n⏰ Description-fix deadline reached after ~${elapsedMin}min — completed work was persisted; remaining slices stay queued for the next run.`);
  }

  console.log(`\n📊 Description fix complete: ${totalFixed} translated, ${totalFailed} failed`);
  console.log(`   descriptions in flight: peak ${poolPeak}`);
  const refusalSummary = Object.entries(refusals).sort((a, b) => b[1] - a[1]).map(([rule, count]) => `${rule} ${count}`).join(', ');
  if (refusalSummary) console.log(`   refused by the quality gate: ${refusalSummary}`);
  console.log(`   ${slicesChanged} slices modified, ${(charsTranslated / 1000).toFixed(0)}K chars translated`);
  logCascadeSummary();
}

// Only run the batch when invoked directly as a script; allow the helper above
// to be imported (e.g. by localize-vf-existing-jobs.mjs / re-localize-jobs.mjs)
// without side effects.
const isMainModule =
  process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();

if (isMainModule) {
  installCodexReserveReport('2e-descriptions', () => ({ codex: getCodexTierStats(), cascade: getCascadeStats() }));
  main().catch(err => { console.error('❌', err.message); process.exit(1); });
}
