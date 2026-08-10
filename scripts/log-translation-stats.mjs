#!/usr/bin/env node
/**
 * Append a translation stats snapshot to data/translation-stats-history.json.
 * Called by translate-pending.yml after each run to build a monitoring history.
 *
 * Usage: node scripts/log-translation-stats.mjs [label]
 *
 * ── Why the percentage is FLOORED, never rounded ──────────────────────────
 * Until 2026-08-10 the summary line was
 *
 *     `   Complete:  ${entry.complete} (${Math.round(entry.complete/total*100)}%)`
 *
 * and `Math.round` turns 99.57% into "100%". The committed history shows a run
 * with 26208/26321 complete — i.e. 113 jobs with a missing locale slot and 1930
 * carrying `needsRetranslation: true` — printed as `Complete: … (100%)`. That
 * one `Math.round` is where "job translation is at 100%" came from.
 *
 * Two rules make that impossible now:
 *   1. the percentage is floored (`formatCompleteRatio`), so a non-zero
 *      incomplete count can never read as 100%;
 *   2. the raw counts are always printed next to it, and the word COMPLETE is
 *      reserved for the exact case — nothing missing AND nothing flagged.
 *
 * ── Why "complete" is not "translated" ────────────────────────────────────
 * `complete` here means "all four locale slots are populated and long enough".
 * It is a PRESENCE measure that counts characters: a German title copied into
 * the `it` slot is 40 characters long and scores as complete. Jobs carrying
 * `needsRetranslation: true` are complete by that definition too, which is why
 * they are now reported as a separate, subtractive figure (`verifiedTranslated`
 * = slots present minus flagged).
 *
 * The remaining gap — verifying that a populated slot is actually in the target
 * LANGUAGE — is not measured here. It plugs into the seam documented in
 * scripts/validate-translation-completeness.mjs (`titleLooksUntranslated`).
 * Until that is wired, `languageVerified` stays `null`: unknown, not zero.
 *
 * ── Rounding direction is deliberate and asymmetric ───────────────────────
 * Success rates are floored here (never overstate the good news). Problem rates
 * are ceiled in validate-translation-completeness.mjs (`formatFlaggedRate`), so
 * a non-zero problem can never print as "0%". Same reason, opposite direction —
 * do not "unify" them into one helper.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRAWLERS_DIR = 'data/jobs/by-crawler';
const STATS_FILE = 'data/translation-stats-history.json';
export const LOCALES = ['it', 'en', 'de', 'fr'];
export const MIN_DESC = 120;
export const MIN_TITLE = 3;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Format a SUCCESS ratio (higher is better) so it can never overstate itself.
 *
 * Floors to one decimal and prints the raw counts alongside. `100%` is returned
 * only when `part >= total` — the `Math.min(…, 99.9)` is belt-and-braces for a
 * float that lands on 1000/1000 without the counts being equal.
 *
 * @param {number} part
 * @param {number} total
 * @returns {string} e.g. `26208/26321 (99.5%)` — never `(100%)` unless exact.
 */
export function formatCompleteRatio(part, total) {
  if (!Number.isFinite(total) || total <= 0) return `${part}/${total || 0} (n/a)`;
  if (part >= total) return `${part}/${total} (100%)`;
  const floored = Math.min(Math.floor((part / total) * 1000) / 10, 99.9);
  return `${part}/${total} (${floored.toFixed(1)}%)`;
}

/**
 * Classify one job.
 *
 * `incomplete` is bit-identical to the pre-2026-08-10 `isIncomplete()`: same
 * thresholds, same locales, same `othersDiffer` escape hatch. The loop uses
 * `continue` where the original used an early `return true` purely so the
 * remaining locales can still be observed — the returned boolean is unchanged.
 *
 * `sourceCopyExcused` is new and OBSERVATIONAL only: it records that a locale
 * slot held a byte-copy of the source title and was excused by the
 * "some other non-source locale differs, so assume this one is fine" rule.
 * That rule suppresses exactly the reported failure mode (DE source, EN+FR
 * translated, IT left in German). Counting it does not change `incomplete`.
 *
 * @param {object} job
 * @returns {{ incomplete: boolean, sourceCopyExcused: boolean }}
 */
export function classifyJob(job) {
  const tbl = job.titleByLocale || {};
  const dbl = job.descriptionByLocale || {};
  const sourceTitle = (job.title || '').trim().toLowerCase();
  const sourceDesc = (job.description || '').trim().toLowerCase();
  const sourceLang = job.sourceLang || 'it';
  let incomplete = false;
  let sourceCopyExcused = false;

  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();
    if (title.length < MIN_TITLE || desc.length < MIN_DESC) { incomplete = true; continue; }
    if (title.toLowerCase() === sourceTitle && locale !== sourceLang) {
      const othersDiffer = LOCALES.some(
        l => l !== locale && l !== sourceLang &&
             (tbl[l] || '').trim().toLowerCase() !== sourceTitle
      );
      if (!othersDiffer) { incomplete = true; continue; }
      sourceCopyExcused = true;
    }
    if (desc.length > 0 && desc.toLowerCase() === sourceDesc && locale !== sourceLang) {
      incomplete = true;
    }
  }
  return { incomplete, sourceCopyExcused };
}

/** Back-compat thin wrapper over classifyJob(). */
export function isIncomplete(job) {
  return classifyJob(job).incomplete;
}

/** @returns {object} a zeroed counter bag for {@link summarizeJobs}. */
export function emptyCounters() {
  return {
    total: 0,
    incomplete: 0,
    needsRetranslation: 0,
    flaggedAmongSlotsPresent: 0,
    suppressed: 0,
    sourceCopyExcused: 0,
    byLocale: { it: 0, en: 0, de: 0, fr: 0 },
  };
}

/**
 * Count one array of jobs (one crawler slice). Pure — no I/O.
 *
 * @param {object[]} jobs
 * @returns {ReturnType<typeof emptyCounters>}
 */
export function summarizeJobs(jobs) {
  const c = emptyCounters();
  for (const job of jobs) {
    c.total++;
    const { incomplete, sourceCopyExcused } = classifyJob(job);
    const flagged = !!job.needsRetranslation;
    if (flagged) c.needsRetranslation++;
    // A flagged job whose four slots are all populated is precisely the job the
    // old report called "complete". Subtracting these is what turns a presence
    // count into a (still upper-bound) translation count.
    if (flagged && !incomplete) c.flaggedAmongSlotsPresent++;
    if (job.localeMismatchSuppressed) c.suppressed++;
    if (sourceCopyExcused) c.sourceCopyExcused++;
    if (incomplete) {
      c.incomplete++;
      const sourceDesc = (job.description || '').trim().toLowerCase();
      const sourceLang = job.sourceLang || 'it';
      for (const loc of LOCALES) {
        const title = (job.titleByLocale?.[loc] || '').trim();
        const desc = (job.descriptionByLocale?.[loc] || '').trim();
        if (title.length < MIN_TITLE || desc.length < MIN_DESC ||
            (desc.toLowerCase() === sourceDesc && loc !== sourceLang)) {
          c.byLocale[loc]++;
        }
      }
    }
  }
  return c;
}

/** Accumulate `src` into `dst` in place. @returns {object} dst */
export function mergeCounters(dst, src) {
  dst.total += src.total;
  dst.incomplete += src.incomplete;
  dst.needsRetranslation += src.needsRetranslation;
  dst.flaggedAmongSlotsPresent += src.flaggedAmongSlotsPresent;
  dst.suppressed += src.suppressed;
  dst.sourceCopyExcused += src.sourceCopyExcused;
  for (const loc of LOCALES) dst.byLocale[loc] += src.byLocale[loc];
  return dst;
}

/**
 * Turn counters into the history entry.
 *
 * `complete` keeps its old key AND its old meaning so the 200-entry committed
 * series stays comparable; `slotsPresent` is the same number under a name that
 * does not claim more than it measures.
 */
export function finalizeEntry(counters, { label, topPending = [], timestamp = new Date().toISOString() } = {}) {
  const complete = counters.total - counters.incomplete;
  return {
    timestamp,
    label,
    total: counters.total,
    needsRetranslation: counters.needsRetranslation,
    suppressed: counters.suppressed,
    incomplete: counters.incomplete,
    complete,                          // legacy key, legacy meaning: slots present
    slotsPresent: complete,            // same number, honest name
    flaggedAmongSlotsPresent: counters.flaggedAmongSlotsPresent,
    verifiedTranslated: complete - counters.flaggedAmongSlotsPresent,
    sourceCopyExcused: counters.sourceCopyExcused,
    // Seam: null = "not measured", never 0. Wired once titleLooksUntranslated
    // (see validate-translation-completeness.mjs) lands and is costed.
    languageVerified: null,
    missingByLocale: counters.byLocale,
    topPending,
  };
}

/**
 * Render the console report. Pure — returns lines, prints nothing.
 * @returns {string[]}
 */
export function formatReport(entry) {
  const lines = [];
  const row = (label, value, note = '') =>
    lines.push(`   ${String(label).padEnd(30)}${value}${note ? `  ${note}` : ''}`);

  lines.push('');
  lines.push(`📊 Translation stats [${entry.label}]`);
  row('Total jobs:', entry.total);
  row('4 locale slots present:', formatCompleteRatio(entry.slotsPresent, entry.total));
  row('Missing/short slots:', entry.incomplete);
  row('Flagged needsRetranslation:', entry.needsRetranslation,
      `(${entry.flaggedAmongSlotsPresent} of them counted as "present" above — flagged is NOT translated)`);
  row('Verified translated:', formatCompleteRatio(entry.verifiedTranslated, entry.total),
      '= present minus flagged');
  row('Language-verified:', entry.languageVerified ?? 'not measured',
      '(presence is a character count, not a language check)');
  row('Source-copy titles excused:', entry.sourceCopyExcused,
      '(byte-copy of the source title, waved through by the "others differ" rule)');
  row('Suppressed (gave up):', entry.suppressed);
  const bl = entry.missingByLocale;
  row('Missing by locale:', `IT=${bl.it} EN=${bl.en} DE=${bl.de} FR=${bl.fr}`);

  // COMPLETE is reserved for the exact case: nothing missing and nothing
  // flagged. Anything else says so in words, not just in a percentage.
  if (entry.incomplete === 0 && entry.needsRetranslation === 0) {
    lines.push('   Verdict: COMPLETE — every job has 4 populated locale slots and none is flagged.');
  } else {
    lines.push(`   Verdict: NOT COMPLETE — ${entry.incomplete} jobs with a missing/short slot, ` +
               `${entry.needsRetranslation} flagged for retranslation.`);
  }

  if (entry.topPending.length > 0) {
    lines.push('   Top pending companies:');
    for (const { company, pending } of entry.topPending.slice(0, 5)) {
      lines.push(`     ${String(pending).padStart(4)} — ${company}`);
    }
  }
  return lines;
}

function main() {
  const label = process.argv[2] || 'translate-pending';

  // Excludes cleanup-jobs.mjs's own scratch file (`<slice>.cleanup-tmp.json`):
  // a hard-killed cleanup run can leave it orphaned in the same CI job, and its
  // bare jobs-array shape passes straight through the `Array.isArray` check
  // below, double-counting every job in it into the committed stats history.
  const files = fs.existsSync(CRAWLERS_DIR)
    ? fs.readdirSync(CRAWLERS_DIR).filter(f => f.endsWith('.json') && !f.includes('-locale-cache') && !f.includes('.cleanup-tmp'))
    : [];

  const counters = emptyCounters();
  const topCompanies = [];

  for (const file of files) {
    const content = readJson(path.join(CRAWLERS_DIR, file));
    if (!content) continue;
    const jobs = Array.isArray(content) ? content : (content.jobs || []);
    const sliceCounters = summarizeJobs(jobs);
    mergeCounters(counters, sliceCounters);
    if (sliceCounters.incomplete > 0) {
      const company = jobs[0]?.company || file.replace('.json', '');
      topCompanies.push({ company, pending: sliceCounters.incomplete });
    }
  }

  topCompanies.sort((a, b) => b.pending - a.pending);

  const entry = finalizeEntry(counters, { label, topPending: topCompanies.slice(0, 10) });

  for (const line of formatReport(entry)) console.log(line);

  const history = readJson(STATS_FILE) || [];
  history.push(entry);
  // Keep last 200 entries
  if (history.length > 200) history.splice(0, history.length - 200);
  fs.writeFileSync(STATS_FILE, JSON.stringify(history, null, 2) + '\n', 'utf-8');
  console.log(`   Saved to ${STATS_FILE} (${history.length} entries total)\n`);
}

// Main-guarded so the pure helpers above can be imported by tests (and by
// nothing else) without reading data/ or appending to the history file.
const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();
