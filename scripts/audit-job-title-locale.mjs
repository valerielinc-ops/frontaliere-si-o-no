#!/usr/bin/env node
/**
 * audit-job-title-locale.mjs — deterministic wrong-language job-title audit.
 *
 * WHY THIS EXISTS
 * ---------------
 * Italian job pages shipped German `<h1>`/`<title>`/`JobPosting.title` for
 * months while `validate-translation-completeness.mjs` reported 100% coverage:
 * that gate counts CHARACTERS in a locale slot, never the LANGUAGE of them.
 * Four layers each deferred the title problem to another layer and none owned
 * it (crawler → "phase 2 handles it" → mark-mistranslated → descriptions only;
 * the ratchet test had been `it.skip` since 2026-05-19). Nothing measured the
 * defect, so nothing could report it.
 *
 * This script is that missing measurement. It applies
 * `titleLooksUntranslated()` (scripts/lib/job-locale-utils.mjs) to EVERY
 * non-source locale title slot in the dataset and emits both a human summary
 * and a machine-readable report. `.github/workflows/job-title-locale-audit.yml`
 * turns that report into a speaking GitHub issue.
 *
 * DESIGN NOTES
 * ------------
 * - Report-only. It never mutates job data and never fails a deploy. The
 *   repair path is `scripts/mark-mistranslated-jobs.mjs` (wired into
 *   translate-pending.yml); the regression gate is
 *   `tests/job-locale-consistency.test.ts`.
 * - Top-N + totals, never an unbounded dump. Measured 2026-08-11 on the
 *   ASSEMBLED `data/jobs.json` (22,781 active jobs): 22,236 of 68,306
 *   non-source title slots flag (32.55%). On the committed
 *   `data/jobs/by-crawler/*.json` slices the same run reads 24,054 of 79,796
 *   (30.14%) — the two populations differ by 2.41pp, so ALWAYS say which one a
 *   number came from. `tests/job-locale-consistency.test.ts` gates the
 *   assembled one, and its header explains what that cost when it was missed.
 *   Either way an issue body listing the offenders individually would exceed
 *   GitHub's 65,536-char cap ~40× and say nothing a leaderboard does not.
 * - `topEvidence` is deliberately part of the output. Grouping the literal
 *   marker token that fired (`des`, `Fachfrau`, `Switzerland`, …) by
 *   locale+reason is what makes a DETECTOR false positive visible next to a
 *   real defect: a single token responsible for thousands of flags in exactly
 *   one target locale is a lexicon bug, not 2,000 broken pages. Without this
 *   column both look identical in the totals. (Live example at the time of
 *   writing: `fr / source-function-word / "des"` fires 1,967 times because the
 *   German article `des` is also an everyday French word.)
 * - Degrades gracefully. `data/jobs.json` is a gitignored build artefact; when
 *   it is absent the audit assembles a read-only view from the committed
 *   `data/jobs/by-crawler/*.json` slices, and when those are absent too it
 *   reports `datasetPresent:false` and exits 0 rather than crashing a
 *   scheduled workflow or a sparse worktree.
 * - `genderTrigraph` (added #5587 item2) is a SEPARATE per-slot count from
 *   `flagged`/`untranslated` above: a title can be a genuinely correct
 *   translation and still carry a raw, un-localized DACH gender code — e.g. a
 *   German "(m/w/d)" copied verbatim into an otherwise-correct Italian title,
 *   which should read "(m/f/d)". `titleLooksUntranslated()` deliberately does
 *   NOT fold that into `untranslated` (see its own doc comment: a gender-code
 *   mismatch is "a locale inconsistency, not a wrong-language title"), so
 *   nothing was counting it even though the masking infrastructure to FIX it
 *   already existed (scripts/lib/translation-glossary.mjs, #5562/#5571). The
 *   detector here is `title !== localizeGenderTrigraphs(title, locale)`:
 *   `localizeGenderTrigraphs` is idempotent, so the two sides differ only
 *   when a trigraph is present AND not yet in the target locale's form.
 *
 * Usage:
 *   node scripts/audit-job-title-locale.mjs [options]
 *     --report <path>   JSON report path (default data/job-title-locale-audit.json)
 *     --top <n>         leaderboard size for company/canton/evidence (default 15)
 *     --samples <n>     concrete offending slots to include (default 20)
 *     --limit <n>       only scan the first N jobs (debugging)
 *     --from-slices     ignore data/jobs.json and read the per-crawler slices
 *     --max-rate <pct>  exit 1 when the flagged rate exceeds <pct> (opt-in;
 *                       omitted = always exit 0, report-only)
 *     --quiet           suppress the human summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleLooksUntranslated, DEFAULT_JOB_LOCALES } from './lib/job-locale-utils.mjs';
import { localizeGenderTrigraphs } from './lib/translation-glossary.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOCALES = DEFAULT_JOB_LOCALES;

/* ────────────────────────────────────────────────────────────────────────────
 * Pure core — exported so tests can drive it from an inline fixture without
 * needing data/jobs.json (a build artefact absent from every sparse worktree).
 * ──────────────────────────────────────────────────────────────────────────── */

const pct = (n, d) => (d > 0 ? n / d : 0);

/** Ordered leaderboard from a `{key: {slots, flagged}}` accumulator. */
function leaderboard(map, keyName, top) {
  return Object.entries(map)
    .map(([key, v]) => ({ [keyName]: key, slots: v.slots, flagged: v.flagged, rate: pct(v.flagged, v.slots) }))
    .filter((r) => r.flagged > 0)
    .sort((a, b) => b.flagged - a.flagged || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, top);
}

function bump(map, key, field) {
  const k = String(key || '?');
  if (!map[k]) map[k] = { slots: 0, flagged: 0 };
  map[k][field] += 1;
}

/**
 * Scan every non-source, non-empty title slot of every job.
 *
 * @param {Array<object>} jobs
 * @param {object} [options]
 * @param {number} [options.top=15]      leaderboard size
 * @param {number} [options.samples=20]  concrete offenders to keep
 * @param {number} [options.limit]       cap the number of jobs scanned
 * @param {(job:object, locale:string) => (string|null)} [options.urlFor]
 *        resolves a public URL for an offending slot; returns null when the
 *        canton→section data is unavailable (sparse worktree). A fabricated URL
 *        is worse than none, so this is injected rather than guessed.
 * @returns {object} machine-readable report
 */
export function auditJobTitles(jobs, { top = 15, samples = 20, limit, urlFor } = {}) {
  const list = Array.isArray(jobs) ? (limit ? jobs.slice(0, limit) : jobs) : [];

  let slots = 0;
  let flagged = 0;
  let jobsFlagged = 0;
  // "Actionable" = slots on jobs the repair path would newly touch, i.e. not
  // already queued (needsRetranslation) and not given up on
  // (localeMismatchSuppressed). Reported separately because the headline rate
  // must describe what the SITE serves, while the repair path can only act on
  // the un-queued remainder.
  let actionableSlots = 0;
  let actionableFlagged = 0;
  let actionableJobs = 0;
  let needsRetranslation = 0;
  let localeMismatchSuppressed = 0;
  // #5587 item2 — per-slot count of gender trigraphs still in a non-locale
  // form. Independent of `flagged`/`untranslated`: see the module header.
  let genderTrigraphSlots = 0;
  let genderTrigraphUnlocalized = 0;

  const byTargetLocale = {};
  const bySourceLang = {};
  const byReason = {};
  const byCanton = {};
  const byCompany = {};
  const evidence = {};
  const sampleRows = [];
  const byGenderTrigraphLocale = {};

  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    const queued = Boolean(job.needsRetranslation) || Boolean(job.localeMismatchSuppressed);
    if (job.needsRetranslation) needsRetranslation += 1;
    if (job.localeMismatchSuppressed) localeMismatchSuppressed += 1;

    const sourceLang = String(job.sourceLang || 'it').toLowerCase();
    const titles = job.titleByLocale && typeof job.titleByLocale === 'object' ? job.titleByLocale : {};
    const sourceTitle = String(titles[sourceLang] || job.title || '');
    let jobHasFlag = false;
    let jobHasActionableFlag = false;

    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const title = String(titles[locale] || '').trim();
      if (!title) continue; // an EMPTY slot is a completeness defect, not a language one

      slots += 1;
      if (!queued) actionableSlots += 1;
      bump(byTargetLocale, locale, 'slots');
      bump(bySourceLang, sourceLang, 'slots');
      bump(byCanton, job.canton, 'slots');
      bump(byCompany, job.company, 'slots');

      // #5587 item2 — per-slot gender-trigraph localization count, independent
      // of the untranslated verdict below (a title can be correctly translated
      // and still carry a raw "(m/w/d)"). `localizeGenderTrigraphs` is
      // idempotent, so a diff means a trigraph was present in a non-locale form.
      genderTrigraphSlots += 1;
      bump(byGenderTrigraphLocale, locale, 'slots');
      if (title !== localizeGenderTrigraphs(title, locale)) {
        genderTrigraphUnlocalized += 1;
        bump(byGenderTrigraphLocale, locale, 'flagged');
      }

      const verdict = titleLooksUntranslated({
        title,
        sourceTitle,
        sourceLang,
        targetLocale: locale,
        company: job.company || '',
        location: job.location || '',
      });
      if (!verdict.untranslated) continue;

      flagged += 1;
      jobHasFlag = true;
      if (!queued) {
        actionableFlagged += 1;
        jobHasActionableFlag = true;
      }
      bump(byTargetLocale, locale, 'flagged');
      bump(bySourceLang, sourceLang, 'flagged');
      bump(byCanton, job.canton, 'flagged');
      bump(byCompany, job.company, 'flagged');
      byReason[verdict.reason] = (byReason[verdict.reason] || 0) + 1;

      const evKey = `${locale} ${verdict.reason} ${String(verdict.evidence || '').toLowerCase().slice(0, 40)}`;
      evidence[evKey] = (evidence[evKey] || 0) + 1;

      if (sampleRows.length < samples) {
        sampleRows.push({
          slug: job.slug || null,
          company: job.company || null,
          canton: job.canton || null,
          targetLocale: locale,
          sourceLang,
          title,
          sourceTitle,
          reason: verdict.reason,
          markers: verdict.markers,
          evidence: verdict.evidence,
          overlap: Number(verdict.overlap.toFixed(3)),
          queued,
          url: typeof urlFor === 'function' ? urlFor(job, locale) : null,
        });
      }
    }
    if (jobHasFlag) jobsFlagged += 1;
    if (jobHasActionableFlag) actionableJobs += 1;
  }

  const localeRow = (map) =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, { slots: v.slots, flagged: v.flagged, rate: pct(v.flagged, v.slots) }])
    );

  return {
    totalJobs: list.length,
    slots,
    flagged,
    rate: pct(flagged, slots),
    jobsFlagged,
    jobRate: pct(jobsFlagged, list.length),
    actionable: {
      slots: actionableSlots,
      flagged: actionableFlagged,
      rate: pct(actionableFlagged, actionableSlots),
      jobs: actionableJobs,
    },
    queued: { needsRetranslation, localeMismatchSuppressed },
    // #5587 item2 — see module header. Same {slots, flagged, rate} shape as
    // byTargetLocale/bySourceLang for consistency; `flagged` here means
    // "still carries a non-locale-form gender trigraph", NOT `untranslated`.
    genderTrigraph: {
      slots: genderTrigraphSlots,
      flagged: genderTrigraphUnlocalized,
      rate: pct(genderTrigraphUnlocalized, genderTrigraphSlots),
      byTargetLocale: localeRow(byGenderTrigraphLocale),
    },
    byTargetLocale: localeRow(byTargetLocale),
    bySourceLang: localeRow(bySourceLang),
    byReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1])),
    byCanton: leaderboard(byCanton, 'canton', top),
    byCompany: leaderboard(byCompany, 'company', top),
    topEvidence: Object.entries(evidence)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([key, count]) => {
        const [targetLocale, reason, token] = key.split(' ');
        return { targetLocale, reason, evidence: token, count };
      }),
    samples: sampleRows,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Dataset loading + CLI
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve the job dataset. `data/jobs.json` is a gitignored build artefact, so
 * fall back to the committed per-crawler slices — that keeps the audit runnable
 * on a fresh clone and in a sparse worktree without an assemble step.
 *
 * @returns {{jobs: Array<object>, source: string|null}}
 */
export function loadJobs({ root = ROOT, fromSlices = false } = {}) {
  const assembled = path.join(root, 'data', 'jobs.json');
  if (!fromSlices && fs.existsSync(assembled)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(assembled, 'utf8'));
      if (Array.isArray(parsed)) return { jobs: parsed, source: 'data/jobs.json' };
    } catch {
      /* fall through to slices */
    }
  }
  const sliceDir = path.join(root, 'data', 'jobs', 'by-crawler');
  if (!fs.existsSync(sliceDir)) return { jobs: [], source: null };
  const jobs = [];
  for (const file of listSliceFileNames(sliceDir)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sliceDir, file), 'utf8'));
      const rows = Array.isArray(parsed) ? parsed : parsed?.jobs;
      if (Array.isArray(rows)) jobs.push(...rows);
    } catch {
      /* a single unreadable slice must not sink the audit */
    }
  }
  return { jobs, source: jobs.length ? 'data/jobs/by-crawler' : null };
}

/**
 * Build a per-locale public-URL resolver, or null when the canton→section
 * tables are unavailable. Loaded lazily and defensively: `data/` is excluded
 * from every sparse worktree in this repo, and a missing table must degrade the
 * report (url:null) rather than crash the audit.
 */
async function makeUrlResolver(root = ROOT) {
  try {
    const { createCantonResolvers } = await import('../build-plugins/shared/cantonResolvers.mjs');
    const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(root, 'data', 'canton-url-slugs.json'), 'utf8'));
    const municipalitiesFile = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'canton-municipalities.json'), 'utf8')
    );
    const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });
    return (job, locale) => {
      const slug = job?.slugByLocale?.[locale] || job?.slug;
      if (!slug) return null;
      const section = resolveCantonSection(locale, resolveJobCanton(job || {}));
      return `https://frontaliereticino.ch/${section}/${slug}/`;
    };
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const num = (flag, fallback) => {
    const raw = get(flag, undefined);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    report: get('--report', path.join(ROOT, 'data', 'job-title-locale-audit.json')),
    top: num('--top', 15),
    samples: num('--samples', 20),
    limit: num('--limit', undefined),
    maxRate: num('--max-rate', undefined),
    fromSlices: argv.includes('--from-slices'),
    quiet: argv.includes('--quiet'),
  };
}

const p2 = (v) => `${(v * 100).toFixed(2)}%`;

function printSummary(report) {
  const r = report;
  console.log('\n═══ Job title locale audit ═══');
  if (!r.datasetPresent) {
    console.log('⚠️  No job dataset found (data/jobs.json and data/jobs/by-crawler are both absent).');
    console.log('   Run `node scripts/assemble-jobs-dataset.mjs` first, or run from a full checkout.');
    return;
  }
  console.log(`Dataset: ${r.datasetSource} — ${r.totalJobs} jobs, ${r.slots} non-source title slots`);
  console.log(`Flagged: ${r.flagged} slots (${p2(r.rate)}) across ${r.jobsFlagged} jobs (${p2(r.jobRate)})`);
  console.log(
    `Actionable (not already queued): ${r.actionable.flagged}/${r.actionable.slots} (${p2(r.actionable.rate)}), ${r.actionable.jobs} jobs`
  );
  console.log(
    `Already queued: needsRetranslation=${r.queued.needsRetranslation}, localeMismatchSuppressed=${r.queued.localeMismatchSuppressed}`
  );
  console.log(
    `Gender trigraph not localized: ${r.genderTrigraph.flagged}/${r.genderTrigraph.slots} (${p2(r.genderTrigraph.rate)}) — a title can pass the language check above and still carry a raw "(m/w/d)"`
  );

  console.log('\n— by target locale —');
  for (const [locale, v] of Object.entries(r.byTargetLocale)) {
    console.log(`  ${locale}  ${String(v.flagged).padStart(6)}/${String(v.slots).padEnd(7)} ${p2(v.rate)}`);
  }
  console.log('\n— by source language —');
  for (const [lang, v] of Object.entries(r.bySourceLang)) {
    console.log(`  ${lang}  ${String(v.flagged).padStart(6)}/${String(v.slots).padEnd(7)} ${p2(v.rate)}`);
  }
  console.log('\n— by reason —');
  for (const [reason, count] of Object.entries(r.byReason)) {
    console.log(`  ${reason.padEnd(24)} ${count}`);
  }
  console.log('\n— worst cantons —');
  for (const row of r.byCanton) console.log(`  ${String(row.canton).padEnd(6)} ${row.flagged}/${row.slots} (${p2(row.rate)})`);
  console.log('\n— worst companies —');
  for (const row of r.byCompany) console.log(`  ${String(row.company).slice(0, 44).padEnd(46)} ${row.flagged}/${row.slots} (${p2(row.rate)})`);
  console.log('\n— top marker evidence (a single token dominating ONE locale is a detector lexicon bug, not a page defect) —');
  for (const e of r.topEvidence) console.log(`  ${String(e.count).padStart(6)}  ${e.targetLocale}/${e.reason} → "${e.evidence}"`);
  console.log('\n— sample offenders —');
  for (const s of r.samples.slice(0, 10)) {
    console.log(`  [${s.targetLocale}] ${s.reason} (${s.evidence}) — ${s.title}`);
    console.log(`      source(${s.sourceLang}): ${s.sourceTitle}`);
    if (s.url) console.log(`      ${s.url}`);
  }
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { jobs, source } = loadJobs({ fromSlices: opts.fromSlices });
  const urlFor = jobs.length ? await makeUrlResolver() : null;

  const report = {
    timestamp: new Date().toISOString(),
    datasetPresent: jobs.length > 0,
    datasetSource: source,
    ...auditJobTitles(jobs, { top: opts.top, samples: opts.samples, limit: opts.limit, urlFor }),
  };

  fs.mkdirSync(path.dirname(opts.report), { recursive: true });
  fs.writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  if (!opts.quiet) printSummary(report);
  console.log(`📄 Report: ${opts.report}`);

  // Report-only unless the caller explicitly asks for a gate. The scheduled
  // workflow reads the JSON and never the exit code, mirroring
  // audit-job-locations.mjs / location-quality-audit.yml.
  if (opts.maxRate !== undefined && report.datasetPresent && report.rate * 100 > opts.maxRate) {
    console.error(`❌ flagged rate ${p2(report.rate)} exceeds --max-rate ${opts.maxRate}%`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[audit-job-title-locale] ${err?.stack || err}`);
    process.exit(1);
  });
}
