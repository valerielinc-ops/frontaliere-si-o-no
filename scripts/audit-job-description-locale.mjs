#!/usr/bin/env node
/**
 * audit-job-description-locale — the measurement behind
 * tests/job-locale-consistency.test.ts's DESCRIPTIONS ratchet, run on a
 * schedule instead of only when a PR happens to be open.
 *
 * WHY IT EXISTS. On 2026-08-11 that ratchet read 0.320% against its 0.300%
 * limit and turned `vitest` red on EVERY open PR at once. Nothing had reported
 * the drift: the gate only speaks inside a PR run, it reports a rate with no
 * offender list, and no branch could fix it because the defect was in main's
 * DATA, not in any diff. Diagnosing it took a manual walk from a red check to a
 * batch of Confederazione Svizzera apprenticeship postings whose `it`
 * description was a byte-identical copy of the `de` source. This script is that
 * walk, done deterministically, so the next occurrence arrives as an issue with
 * the offenders already named.
 *
 * IT ALSO WATCHES THE MARGIN, NOT ONLY THE BREACH — the part the ratchet cannot
 * do. The gate went green again the same day WITHOUT anything being repaired:
 * the offender count stayed at 100 while the dataset grew from 31,266 to 34,594
 * description slots, so the rate fell to 0.289% purely by dilution. A gate
 * sitting 0.011pp under its limit is one crawl away from red and looks
 * identical to a healthy one. `--min-headroom-pp` is what makes that state
 * visible.
 *
 * MEASUREMENT PARITY. The rate here must be the rate the gate computes, or the
 * alert is about a different number than the one that breaks CI: same assembled
 * `data/jobs.json`, same `detectLanguageWithConfidence`, same 120-char floor,
 * same 0.65 confidence, same `needsRetranslation` skip. `MAX_RATE` is duplicated
 * from the test rather than imported (the test declares it inline, and this
 * script must not import a vitest file); tests/audit-job-description-locale.test.ts
 * asserts the two constants stay equal so the duplication cannot drift.
 *
 * Report-only: always exits 0 on a successful measurement. The repair path is
 * mark-locale-mismatched-jobs.mjs inside translate-pending.yml; the regression
 * gate is the vitest ratchet.
 *
 * Usage:
 *   node scripts/audit-job-description-locale.mjs [--min-headroom-pp N] [--out PATH]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const LOCALES = ['it', 'en', 'de', 'fr'];

const MIN_DESCRIPTION_CHARS = 120;
const DESCRIPTION_CONFIDENCE = 0.65;

/**
 * Kept equal to `MAX_RATE` in tests/job-locale-consistency.test.ts by
 * tests/audit-job-description-locale.test.ts. Raising one without the other
 * makes this audit report health while CI is red, which is worse than no audit.
 */
export const MAX_RATE = 0.003;

/** Default headroom below which a still-green gate is worth saying out loud. */
export const DEFAULT_MIN_HEADROOM_PP = 0.05;

/**
 * Measure the descriptions ratchet. Pure: takes jobs, returns the report.
 * Exported so the test can exercise it without a dataset on disk.
 */
export function auditDescriptionLocales(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  let slots = 0;
  const offenders = [];
  const byCompany = new Map();
  const byPair = new Map();
  let actionableJobs = 0;
  const actionableSlugs = new Set();

  for (const job of list) {
    // Same skip as the gate: jobs awaiting translation are expected to hold
    // source-language fallbacks until translate-pending processes them.
    if (job?.needsRetranslation) continue;

    for (const locale of LOCALES) {
      const description = String(job?.descriptionByLocale?.[locale] || '').trim();
      if (description.length < MIN_DESCRIPTION_CHARS) continue;
      slots += 1;

      const detected = detectLanguageWithConfidence(description, locale);
      if (detected.confidence < DESCRIPTION_CONFIDENCE) continue;
      if (detected.lang === locale || !LOCALES.includes(detected.lang)) continue;

      const company = String(job?.company || '?');
      const slug = String(job?.slug || '?');
      // A source-copy is the shape the FREE Argos mop-up can repair; anything
      // else needs the quota-bound cascade. The distinction decides whether a
      // breach is cheap or expensive to clear, so it belongs in the report.
      const sourceLang = String(job?.sourceLang || 'it').toLowerCase();
      const sourceDesc = String(job?.descriptionByLocale?.[sourceLang] || job?.description || '').trim();
      const sourceCopy = sourceDesc.length > 0 && description.toLowerCase() === sourceDesc.toLowerCase();

      offenders.push({
        company,
        slug,
        locale,
        detected: detected.lang,
        confidence: Number(detected.confidence.toFixed(2)),
        sourceLang,
        sourceCopy,
        suppressed: Boolean(job?.localeMismatchSuppressed),
      });
      byCompany.set(company, (byCompany.get(company) || 0) + 1);
      const pair = `${sourceLang}->${locale}`;
      byPair.set(pair, (byPair.get(pair) || 0) + 1);
      if (!job?.localeMismatchSuppressed) {
        if (!actionableSlugs.has(slug)) actionableJobs += 1;
        actionableSlugs.add(slug);
      }
    }
  }

  const rate = slots > 0 ? offenders.length / slots : 0;
  const headroomPp = (MAX_RATE - rate) * 100;
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ key: k, count: n }));

  return {
    datasetPresent: list.length > 0,
    totalJobs: list.length,
    slots,
    flagged: offenders.length,
    rate,
    maxRate: MAX_RATE,
    headroomPp,
    breached: rate > MAX_RATE,
    sourceCopyCount: offenders.filter((o) => o.sourceCopy).length,
    actionableJobs,
    topCompanies: top(byCompany),
    topPairs: top(byPair),
    offenders: offenders.slice(0, 200),
  };
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const raw = Number(get('--min-headroom-pp'));
  return {
    minHeadroomPp: Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_HEADROOM_PP,
    out: get('--out') || path.join(ROOT, 'data', 'job-description-locale-audit.json'),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let jobs = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf8'));
    if (Array.isArray(parsed) && parsed.length > 0) jobs = parsed;
  } catch {
    jobs = null;
  }

  if (!jobs) {
    // No dataset means no measurement. Emit an explicit absent-report rather
    // than a zero one: a zero would read as "healthy" and close the tracking
    // issue on an empty run.
    const report = { datasetPresent: false, minHeadroomPp: opts.minHeadroomPp };
    fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
    console.log('data/jobs.json absent or empty — no measurement. Run scripts/assemble-jobs-dataset.mjs first.');
    return;
  }

  const report = { ...auditDescriptionLocales(jobs), minHeadroomPp: opts.minHeadroomPp };
  report.thinMargin = !report.breached && report.headroomPp < opts.minHeadroomPp;
  fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));

  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  console.log(
    `[audit] descriptions-wrong-locale ${report.flagged}/${report.slots} = ${pct(report.rate)} `
      + `(max ${pct(report.maxRate)}, headroom ${report.headroomPp.toFixed(3)}pp) `
      + `source-copy ${report.sourceCopyCount} · actionable jobs ${report.actionableJobs}`
  );
  if (report.breached) console.log('❌ BREACHED — the vitest ratchet is red on every open PR.');
  else if (report.thinMargin) console.log(`⚠️  THIN MARGIN — under ${opts.minHeadroomPp}pp of headroom.`);
  else console.log('✅ healthy');
  for (const c of report.topCompanies.slice(0, 5)) console.log(`   ${c.count}\t${c.key}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();