#!/usr/bin/env node
/**
 * audit-information-gain.mjs — issue #5002.
 *
 * Measures, per template cohort, how much each page adds over its siblings:
 * the Information-Gain question (US8140449B1) restated as something computable
 * from emitted HTML. The metric engine, and the reasoning behind masking and
 * cohorting, live in `scripts/lib/informationGain.mjs`.
 *
 * WHAT THIS CATCHES THAT NOTHING ELSE DOES
 * ---------------------------------------------------------------------------
 * `audit-content-duplicates.mjs` hashes the WHOLE body text and reports exact
 * collisions. A mail-merge family never collides: swap the place name and one
 * figure and the hash changes. Measured on production 2026-08-24, the fiscal
 * guide family (`/tasse-frontalieri-comune/`) was at 0,0 % median gain with
 * 9 of 9 sampled pages contributing NOT ONE sentence their siblings did not
 * already carry — and content-duplicates was green on all of them, because
 * `0,55 %` vs `0,7 %` is enough to break a SHA-256. This audit is the missing
 * half: near-duplication, not identity.
 *
 * THE GATE
 * ---------------------------------------------------------------------------
 * Two failure modes, both rates (never counts — `audit-all.mjs` may sample,
 * see AGENTS.md rule #1's dist exception):
 *
 *   1. A cohort not in the inventory drops below MEDIAN_IGS_FLOOR_PCT.
 *   2. An inventoried cohort gets WORSE than its recorded median by more than
 *      REGRESSION_TOLERANCE_PCT.
 *
 * The inventory (`KNOWN_LOW_GAIN_COHORTS`) is the same device as
 * `tests/gate-wiring-baseline.json`: a list of a pre-existing defect, made
 * visible so it stops growing, that can only shrink. It is a LIST with
 * recorded values, not a global threshold, because a single lowered threshold
 * is indistinguishable from the defect spreading.
 *
 * Recovery never fails the run — a cohort that climbs far above its recorded
 * value prints a "remove me from the inventory" line instead. On a REHYDRATED
 * dist (pages emitted months ago by code that no longer exists) an equality
 * assertion on a rate would flap on corpus churn alone, and a flapping gate
 * gets switched off within a week.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-information-gain.mjs [dist]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';
import { fingerprintPage, scoreCohorts } from './lib/informationGain.mjs';
import { JOB_BOARD_SECTION_RX } from './lib/jobBoardSections.mjs';

/**
 * Median share of page-specific prose a gated cohort must clear.
 *
 * Calibrated on production, 2026-08-24, on a 102-page cross-family sample
 * (12 pages per sitemap family, evenly spaced through each sitemap):
 *
 *   it:/aziende/                                   47,6 %   ← employer profiles
 *   it:/lavoro-ticino-                             21,4 %   ← profession landings
 *   it:/vivere-in-ticino/comuni-di-frontiera/    5,8-11,5 %
 *   it:/vivere-in-germania-lavorare-in-svizzera/    5,1 %
 *   it:/vivere-in-austria-lavorare-in-svizzera/     1,8 %
 *   it:/tasse-frontalieri-comune/                   0,0 %
 *   it:/vivere-in-liechtenstein-lavorare-in-svizzera/ 0,0 %
 *   it:/vivere-in-francia-lavorare-in-svizzera/     0,0 %
 *
 * The employer-profile family is the control: same shell, same nav, same
 * footer, but a real per-page payload (that employer's open positions). It
 * scores 8× the municipality families, which is what says the metric is
 * measuring the payload and not the chrome.
 *
 * 5 % is set below every family that carries a real payload and above every
 * family that carries none — "the median page has at least one sentence in
 * twenty that its siblings do not have". The issue's own target (IGS > 40 %)
 * is REPORTED per cohort but deliberately not the gate: a threshold nothing
 * currently meets is a threshold that gets lowered, not met.
 */
const MEDIAN_IGS_FLOOR_PCT = 5;

/** How far an inventoried cohort may drift down before it is a regression. */
const REGRESSION_TOLERANCE_PCT = 1.5;

/**
 * Cohorts with a cohort of at least this many pages are gated. Below it the
 * "shared with half the cohort" test is noise — and under AUDIT_SAMPLE_RATE a
 * large family can legitimately show up with a handful of pages.
 */
const MIN_COHORT_PAGES = 12;

/**
 * Pre-existing low-gain cohorts, with the median measured when they were
 * inventoried. SHRINK-ONLY: adding a line is not an option, it is how the
 * defect spreads. Removing one is the point.
 *
 * Every entry here is a family whose pages are mostly their siblings' pages.
 *
 * NOT inventoried, and deliberately so — the six municipality families that
 * #5002 gave the nearest-neighbour comparison to. Measured AFTER the fix, by
 * rendering every above-floor page of each family and running this auditor on
 * the output (the four foreign families were measured this way because their
 * live pages predate the fix):
 *
 *   it:/vivere-in-ticino/comuni-di-frontiera/       15,6 %   (era 11,5-15,4 %)
 *   it:/vivere-in-germania-lavorare-in-svizzera/    11,1 %   (era 5,1 %)
 *   it:/tasse-frontalieri-comune/                    9,1 %   (era 0,0 %)
 *   it:/vivere-in-liechtenstein-lavorare-in-svizzera/ 6,1 %  (era 0,0 %)
 *   it:/vivere-in-francia-lavorare-in-svizzera/       5,6 %  (era 0,0 %)
 *
 * Values measured on the production sample of 2026-08-24 (see the calibration
 * note above for the method).
 */
const KNOWN_LOW_GAIN_COHORTS = new Map([
  // Salary landings built from one BFS row each: the row IS the page, and the
  // surrounding prose is one template. Fixing it means giving each page a
  // payload of its own (the same move #5002 made for the comuni), which is
  // real content work on a different dataset — tracked in #6328.
  ['it:/stipendio-medio-svizzera-', 0],
  ['de:/de/durchschnittslohn-schweiz-', 0],
  // The one municipality family that the #5002 block did NOT lift over the
  // floor: 0,0 % → 4,2 % measured on all 8 above-floor pages. Inventoried with
  // its post-fix value rather than left out, because "it will be above the
  // floor from now on" was an expectation and this one turned out false — and
  // an uninventoried cohort fails HARD the day the dataset grows past
  // MIN_COHORT_PAGES (8 above-floor comuni per locale today).
  //
  // Why it is the odd one out: the Austrian corridor has no frontalieri regime
  // at all (art. 15 §4 DBA-A repealed in 2006), so the page is dominated by one
  // long legal explainer that is IDENTICALLY true for every comune — ~29 of its
  // ~32 counted segments. There is no per-comune reality being hidden by
  // template prose: the dataset offers population, road distance and nearest
  // crossing, and the comparison block already surfaces all three. Raising this
  // cohort means finding a genuinely per-comune fact that we do not have yet,
  // not rewording what is there.
  ['it:/vivere-in-austria-lavorare-in-svizzera/', 4.2],
]);

/** @returns {import('./lib/audit-runner.mjs').Auditor} */
function createAuditor({ dist = DEFAULT_DIST, sampleRate = 1 } = {}) {
  /** @type {Array<ReturnType<typeof fingerprintPage>>} */
  const fingerprints = [];

  return {
    name: 'information-gain',
    collect(file, html) {
      // Noindex pages are not in the index, so they cannot dilute or inflate
      // what the index contains. Cheap substring test before the regex: the
      // attribute is absent on the large majority of pages.
      // Quote-flexible (matches the sibling regex in every other audit, e.g.
      // audit-text-html-ratio.mjs / audit-title-length.mjs): the site's HTML
      // minifier drops attribute quotes when the value needs none
      // (`name=robots content=noindex,follow`), so a quote-mandatory regex
      // never matches an emitted page and every below-floor noindex bridge
      // (short boilerplate, near-zero gain by design) leaks into the cohorts
      // it was meant to be excluded from — dragging the family's median to
      // near-zero even though the indexable pages score well above the floor
      // (issue #6558: confirmed live prod scores 8-13% on the same families
      // this regex was hiding bridge pages inside of).
      if (html.includes('noindex') && /<meta[^>]+name=["']?robots["']?[^>]+content=["']?[^"'>]*noindex/i.test(html)) return;
      const relPath = relative(dist, file);
      // Job-board sections (listing hubs + individual job-detail pages, every
      // canton) are out of scope: they are hydration/JobPosting-JSON-LD driven
      // pages sourced from third-party postings, not the editorial guide/
      // comparison prose #5002 targets — see scripts/lib/jobBoardSections.mjs.
      // Every sibling classifier that separates "editorial" from "job-board"
      // (audit-title-length, audit-text-html-ratio, audit-page-weight, …) and
      // this audit's own calibration + companion live-scan MONITORED_SITEMAPS
      // already treat them as a distinct, unmeasured category; scoring them
      // here mixes two page kinds with unrelated prose expectations into the
      // same cohort and floods it with false "below-floor" offenders.
      if (JOB_BOARD_SECTION_RX.test(relPath)) return;
      fingerprints.push(fingerprintPage(relPath, html));
    },
    report() {
      const { cohorts, pagesScored, pagesUncohorted } = scoreCohorts(fingerprints, {
        minCohortPages: MIN_COHORT_PAGES,
      });

      const gated = cohorts.filter((c) => c.gated);
      const offenders = [];
      const recovered = [];

      for (const cohort of gated) {
        const known = KNOWN_LOW_GAIN_COHORTS.get(cohort.label);
        if (known === undefined) {
          if (cohort.medianIgs < MEDIAN_IGS_FLOOR_PCT) {
            offenders.push({ ...cohort, reason: 'below-floor', recordedMedian: null });
          }
          continue;
        }
        if (cohort.medianIgs < known - REGRESSION_TOLERANCE_PCT) {
          offenders.push({ ...cohort, reason: 'regressed-vs-inventory', recordedMedian: known });
        } else if (cohort.medianIgs >= MEDIAN_IGS_FLOOR_PCT) {
          recovered.push({ ...cohort, recordedMedian: known });
        }
      }

      const passed = offenders.length === 0;
      const belowTarget = gated.filter((c) => c.medianIgs < 40).length;

      return {
        passed,
        offendersTotal: offenders.length,
        byFeature: offenders.reduce((acc, o) => {
          acc[o.reason] = (acc[o.reason] ?? 0) + 1;
          return acc;
        }, {}),
        offenders: offenders.map((o) => ({
          path: o.label,
          feature: o.reason,
          metric: Number(o.medianIgs.toFixed(2)),
          ratio: o.pages === 0 ? null : Number((o.zeroGainPages / o.pages).toFixed(4)),
        })),
        threshold: { metric: 'median-igs-pct', value: MEDIAN_IGS_FLOOR_PCT, comparator: '>=' },
        baselineFile: null,
        baselineDelta: null,
        extra: {
          sampleRate,
          cohortsSeen: cohorts.length,
          cohortsGated: gated.length,
          pagesScored,
          pagesUncohorted,
          cohortsBelowIssueTarget40: belowTarget,
          inventorySize: KNOWN_LOW_GAIN_COHORTS.size,
          recoveredCohorts: recovered.map((c) => ({
            label: c.label,
            recordedMedian: c.recordedMedian,
            medianIgs: Number(c.medianIgs.toFixed(2)),
          })),
          // The full table, every run: AGENTS.md rule #1's dist exception asks
          // for the measured rate to be printed so the next threshold tightens
          // on data. Capped so the report file stays small on a full corpus.
          cohorts: gated.slice(0, 60).map((c) => ({
            label: c.label,
            // The cohort's template identity, independent of which pages the
            // run happened to sample. The label is derived from the sampled
            // paths, so two runs can name the same family differently; without
            // this field a report cannot be used to inventory a cohort in
            // KNOWN_LOW_GAIN_COHORTS without guessing which label will come
            // back next run (issue #6975).
            skeletonHash: c.skeletonHash.toString(16),
            pages: c.pages,
            medianIgs: Number(c.medianIgs.toFixed(2)),
            meanIgs: Number(c.meanIgs.toFixed(2)),
            zeroGainPages: c.zeroGainPages,
            worst: c.worst.map((p) => ({
              urlPath: p.urlPath,
              igs: Number(p.igs.toFixed(2)),
              segments: p.segments,
              pageSpecific: p.pageSpecific,
            })),
          })),
        },
        humanSummary:
          `information-gain: ${gated.length} coorti gated su ${cohorts.length}, ` +
          `${pagesScored} pagine in coorte, ${offenders.length} sotto soglia ` +
          `(floor ${MEDIAN_IGS_FLOOR_PCT}%, inventario ${KNOWN_LOW_GAIN_COHORTS.size})`,
      };
    },
  };
}

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const arg = process.argv[2];
  const distDir = arg && !arg.startsWith('--') ? arg : DEFAULT_DIST;
  const s = await stat(distDir).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-information-gain] dist directory not found: ${distDir}`);
    process.exit(1);
  }

  const a = createAuditor({ dist: distDir });
  const files = await walkHtmlFiles(distDir);
  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }

  const result = a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders,
    byFeature: result.byFeature,
    extra: result.extra,
  });

  console.log(`[audit-information-gain] ${files.length} file, ${result.extra.pagesScored} in coorte`);
  console.log('  median  pagine  zero  coorte');
  for (const cohort of result.extra.cohorts) {
    console.log(
      `  ${String(cohort.medianIgs.toFixed(1)).padStart(6)}%  ${String(cohort.pages).padStart(6)}  ` +
        `${String(cohort.zeroGainPages).padStart(4)}  ${cohort.label}`,
    );
  }
  if (result.extra.recoveredCohorts.length > 0) {
    console.log('\n[audit-information-gain] coorti risalite sopra il floor — togli la riga da KNOWN_LOW_GAIN_COHORTS:');
    for (const c of result.extra.recoveredCohorts) {
      console.log(`  ${c.label}: ${c.recordedMedian}% → ${c.medianIgs}%`);
    }
  }
  if (!result.passed) {
    console.error('\n[audit-information-gain] coorti sotto soglia:');
    for (const o of result.offenders) console.error(`  ${o.metric}%  [${o.feature}]  ${o.path}`);
  }
  console.log(`\n[audit-information-gain] ${result.humanSummary}`);
  process.exit(result.passed ? 0 : 1);
}

export const factory = createAuditor;
export const auditor = factory();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  standalone().catch((err) => {
    console.error('[audit-information-gain] fatal', err);
    process.exit(1);
  });
}

export const INFORMATION_GAIN_GATE = {
  MEDIAN_IGS_FLOOR_PCT,
  REGRESSION_TOLERANCE_PCT,
  MIN_COHORT_PAGES,
  KNOWN_LOW_GAIN_COHORTS,
  ROOT,
};
