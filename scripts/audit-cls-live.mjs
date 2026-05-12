#!/usr/bin/env node
/**
 * audit-cls-live.mjs
 *
 * Post-deploy CLS gate. Runs PageSpeed Insights on a representative set of
 * live URLs (one per template), reads CrUX field data when available and
 * Lighthouse lab data as fallback, and compares the result against
 * `data/cls-baseline.json`.
 *
 * Why a gate at all:
 *   The 2026-05-08 monetization audit showed CLS p75 mobile = 0.94 and
 *   desktop = 1.016 (Google "poor"). Without a ratchet, every refactor risks
 *   pushing CLS up another notch. AdSense bid down + viewability collapse
 *   directly track this number.
 *
 * Threshold logic (configurable):
 *   - HARD BLOCK if CLS > 0.25 (Google "needs improvement" boundary) AND
 *     baseline was < 0.25 — i.e. a passing page just regressed past the line.
 *   - SOFT BLOCK if CLS regressed by >10% relative AND >0.05 absolute vs
 *     baseline (avoids false positives on tiny pages with noisy CrUX).
 *   - PASS if absent from baseline (records new entry; first-run setup).
 *
 * Usage:
 *   node scripts/audit-cls-live.mjs                   # CI mode, exit 1 on regression
 *   node scripts/audit-cls-live.mjs --json            # JSON report
 *   node scripts/audit-cls-live.mjs --rebaseline      # write current numbers to baseline
 *   node scripts/audit-cls-live.mjs --strategy=mobile # default: both
 *
 * Env:
 *   PAGESPEED_API_KEY  — optional, lifts the rate limit (loaded from RC by
 *                        load-rc-env.mjs in CI).
 *   LIVE_BASE_URL      — default https://frontaliereticino.ch
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(ROOT, 'data/cls-baseline.json');
const REPORTS_DIR = resolve(ROOT, 'reports');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const REBASELINE = args.includes('--rebaseline');
const STRATEGY_ARG = args.find((a) => a.startsWith('--strategy='))?.slice('--strategy='.length);
const STRATEGIES = STRATEGY_ARG === 'mobile' || STRATEGY_ARG === 'desktop' ? [STRATEGY_ARG] : ['mobile', 'desktop'];

const BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');
const API_KEY = process.env.PAGESPEED_API_KEY || '';
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// Hard threshold: Google's "needs improvement" boundary.
// Any page with CLS > 0.25 is flagged "poor" by CrUX.
const HARD_CLS_THRESHOLD = 0.25;

// Regression triggers: relative AND absolute, both must hit.
const REL_REGRESSION = 0.10; // +10% worse than baseline
const ABS_REGRESSION = 0.05; // +0.05 absolute (filters noisy small samples)

/**
 * URLs to audit. Tightened from 14 → 7 representatives in 2026-05-08:
 *
 *   - 14 × 2 strategies = 28 PSI calls → ~30 min serial run
 *   - Most leaf URLs reported the same site-wide CrUX origin fallback
 *     (0.73 mobile / 0.66 desktop) anyway, so they were redundant.
 *   - Kept: surfaces with their OWN URL-level CrUX (homepage, jobs_index)
 *     plus one representative per template family that has distinct CLS.
 *
 * Adding here = locked into the ratchet. Choose URLs that:
 *  - Have stable, evergreen content (so the lab number is reproducible)
 *  - Cover every major template
 *  - Have enough live traffic for CrUX field data when possible
 */
const TARGETS = [
  { id: 'home', path: '/' },
  { id: 'jobs_index', path: '/cerca-lavoro-ticino/' },
  { id: 'jobs_filter_concorsi', path: '/cerca-lavoro-ticino/concorsi-per-l-assunzione-di-personale-citta-di-lugano-lugano/' },
  { id: 'articles_index', path: '/articoli-frontaliere/' },
  { id: 'calculator_root', path: '/calcola-stipendio/' },
  { id: 'comparators_currency', path: '/compara-servizi/cambio-franco-euro/' },
  { id: 'border_wait_hub', path: '/traffico-dogane/' },
];

/**
 * Parallelism for PSI calls. PSI's documented quota is 25k req/day with key
 * and there is no documented per-second cap; in practice, running ~12 calls
 * concurrently is reliable and cuts the gate from ~30 min to ~3 min on the
 * 7-target × 2-strategy matrix.
 */
const PSI_CONCURRENCY = 6;

function fmt(n) {
  if (n == null || Number.isNaN(n)) return 'n/a';
  return n.toFixed(3);
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { generated: null, entries: {} };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    return { generated: null, entries: {} };
  }
}

function saveBaseline(baseline) {
  if (!existsSync(dirname(BASELINE_PATH))) mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

// Retry on transient PSI 5xx errors (Lighthouse-side flakes). Backoff: 2s/4s/8s.
// PSI returns 500/502 surprisingly often under load; treating them as hard
// failures fails the deploy gate even when Google is the problem, not us.
// 4xx errors (bad URL, missing key, quota) are NOT retried — they indicate
// a configuration bug that retrying cannot fix.
const PSI_MAX_ATTEMPTS = 3;
const PSI_RETRY_BASE_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPsi(url, strategy) {
  const params = new URLSearchParams({ url, strategy, category: 'performance' });
  if (API_KEY) params.set('key', API_KEY);
  const endpoint = `${PSI_ENDPOINT}?${params.toString()}`;

  let lastError = null;
  for (let attempt = 1; attempt <= PSI_MAX_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await fetch(endpoint, { method: 'GET' });
    } catch (e) {
      // Network-layer failure (DNS, ECONNRESET, abort). Treat as transient.
      lastError = new Error(`PSI network error for ${url} (${strategy}): ${e.message || e}`);
      if (attempt < PSI_MAX_ATTEMPTS) {
        await sleep(PSI_RETRY_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }
    if (r.ok) {
      const j = await r.json();
      return parsePsiResponse(j);
    }
    const body = await r.text();
    const isTransient5xx = r.status >= 500 && r.status < 600;
    lastError = new Error(`PSI ${r.status} for ${url} (${strategy}): ${body.slice(0, 200)}`);
    if (!isTransient5xx || attempt >= PSI_MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(PSI_RETRY_BASE_MS * Math.pow(2, attempt - 1));
  }
  // Defensive — unreachable, the loop always either returns or throws.
  throw lastError || new Error(`PSI failed after ${PSI_MAX_ATTEMPTS} attempts for ${url} (${strategy})`);
}

function parsePsiResponse(j) {
  // CrUX field (real users, 28-day rolling window). Only present if URL has
  // enough traffic. CrUX returns p75 of CLS distribution.
  const cruxField = j.loadingExperience?.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  const cruxOriginField = j.originLoadingExperience?.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE;

  // Lighthouse lab — always present. CLS is computed for the synthetic load.
  const labRaw = j.lighthouseResult?.audits?.['cumulative-layout-shift']?.numericValue;

  // CrUX returns CLS scaled ×100 (so a 0.10 CLS shows as 10). Normalize.
  const cruxP75 = cruxField?.percentile != null ? cruxField.percentile / 100 : null;
  const cruxOriginP75 = cruxOriginField?.percentile != null ? cruxOriginField.percentile / 100 : null;
  const lab = typeof labRaw === 'number' ? labRaw : null;

  // CrUX is a 28-day rolling window of real-user field data — by design it
  // lags any code change by 2-3 weeks. When a CLS fix lands, lab (synthetic,
  // measured on this same PSI call) drops immediately while CrUX p75 stays
  // pinned at the pre-fix value for weeks. Treating CrUX as the only signal
  // means the gate blocks every CI run during that cooking period, even
  // though the fix is already shipped and verifiable in lab.
  //
  // Trust-lab override: if CrUX is "poor" (>0.25) AND lab is significantly
  // better (lab <= cruxP75/2 AND lab below HARD_CLS_THRESHOLD), prefer lab
  // for the effective value. The source label becomes `lab_post_fix` so the
  // human reader knows what happened. Once CrUX rolls forward, this branch
  // stops firing and we go back to field-data as the truth.
  const cruxBest = cruxP75 ?? cruxOriginP75;
  const trustLabOverFreshFix =
    cruxBest != null &&
    cruxBest > HARD_CLS_THRESHOLD &&
    lab != null &&
    lab < HARD_CLS_THRESHOLD &&
    lab <= cruxBest / 2;

  let effective;
  let source;
  if (trustLabOverFreshFix) {
    effective = lab;
    source = 'lab_post_fix';
  } else if (cruxP75 != null) {
    effective = cruxP75;
    source = 'crux_url';
  } else if (cruxOriginP75 != null) {
    effective = cruxOriginP75;
    source = 'crux_origin';
  } else if (lab != null) {
    effective = lab;
    source = 'lab';
  } else {
    effective = null;
    source = 'unavailable';
  }

  // Extract a compact subset of the Lighthouse "layout-shift-elements" audit
  // for CLS attribution debugging — sufficient to identify the shifting node
  // without ballooning the report with the full ~500 KB Lighthouse JSON.
  // The full payload (`psiRaw`) is also returned for hard regressions so the
  // post-deploy artifact carries everything an investigator needs.
  const lsElements = j.lighthouseResult?.audits?.['layout-shift-elements'];
  const finalScreenshot = j.lighthouseResult?.audits?.['final-screenshot']?.details?.data || null;

  return {
    cruxP75,
    cruxOriginP75,
    cruxCategory: cruxField?.category || null,
    lab,
    effective,
    source,
    attribution: {
      layoutShiftElements: lsElements?.details?.items?.slice(0, 5) ?? null,
      score: lsElements?.score ?? null,
    },
    finalScreenshot,
    raw: j, // full Lighthouse JSON — caller decides whether to persist
  };
}

function classifyRegression(current, baseline) {
  if (current == null) return { state: 'unknown', reason: 'no PSI data' };
  if (baseline == null) return { state: 'new', reason: 'first-run baseline' };

  // Hard block: passed → poor crossing
  if (current > HARD_CLS_THRESHOLD && baseline <= HARD_CLS_THRESHOLD) {
    return { state: 'hard_regression', reason: `crossed poor threshold (${fmt(baseline)} → ${fmt(current)})` };
  }

  // Already poor — additionally, only flag if it got even worse meaningfully.
  const absDelta = current - baseline;
  const relDelta = baseline > 0 ? absDelta / baseline : 0;

  if (absDelta >= ABS_REGRESSION && relDelta >= REL_REGRESSION) {
    return {
      state: current > HARD_CLS_THRESHOLD ? 'hard_regression' : 'soft_regression',
      reason: `regression Δ=${fmt(absDelta)} (+${(relDelta * 100).toFixed(1)}%)`,
    };
  }

  if (absDelta < -ABS_REGRESSION || relDelta <= -REL_REGRESSION) {
    return { state: 'improved', reason: `improved Δ=${fmt(absDelta)} (${(relDelta * 100).toFixed(1)}%)` };
  }

  return { state: 'flat', reason: 'within tolerance' };
}

async function run() {
  const baseline = loadBaseline();
  const results = [];
  const errors = [];

  // Build the full call grid first, then dispatch in parallel batches of
  // PSI_CONCURRENCY. Order doesn't matter for the final report — we
  // reconstruct it by sorted key after the fact.
  const calls = [];
  for (const target of TARGETS) {
    const url = `${BASE_URL}${target.path}`;
    for (const strategy of STRATEGIES) {
      calls.push({ key: `${target.id}@${strategy}`, url, strategy });
    }
  }

  async function execOne(c) {
    try {
      const data = await runPsi(c.url, c.strategy);
      const baselineValue = baseline.entries?.[c.key]?.cls ?? null;
      const verdict = classifyRegression(data.effective, baselineValue);
      const row = { ...c, ...data, baseline: baselineValue, verdict };
      results.push(row);
      if (!JSON_OUT) {
        const tag =
          verdict.state === 'hard_regression' ? '🔴'
          : verdict.state === 'soft_regression' ? '⚠️'
          : verdict.state === 'improved' ? '✅'
          : verdict.state === 'new' ? '🆕'
          : verdict.state === 'flat' ? '·'
          : '?';
        console.log(`${tag} ${c.key.padEnd(40)} cls=${fmt(data.effective)} (src=${data.source}) baseline=${fmt(baselineValue)} — ${verdict.reason}`);
      }
    } catch (e) {
      errors.push({ key: c.key, url: c.url, strategy: c.strategy, error: e.message });
      if (!JSON_OUT) console.error(`❌ ${c.key}: ${e.message.slice(0, 200)}`);
    }
  }

  // Polite to PSI without an API key: stick to a tiny pool. With key, fan out.
  const concurrency = API_KEY ? PSI_CONCURRENCY : 2;
  let cursor = 0;
  async function worker() {
    while (cursor < calls.length) {
      const i = cursor++;
      await execOne(calls[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // Stable order in the persisted report (results was filled in completion order).
  results.sort((a, b) => a.key.localeCompare(b.key));

  const hardRegressions = results.filter((r) => r.verdict.state === 'hard_regression');
  const softRegressions = results.filter((r) => r.verdict.state === 'soft_regression');

  if (REBASELINE) {
    const newBaseline = {
      generated: new Date().toISOString(),
      threshold: HARD_CLS_THRESHOLD,
      entries: {},
    };
    for (const r of results) {
      if (r.effective != null) {
        newBaseline.entries[r.key] = { cls: Number(r.effective.toFixed(4)), source: r.source, capturedAt: newBaseline.generated };
      }
    }
    saveBaseline(newBaseline);
    if (!JSON_OUT) console.log(`\n💾 wrote ${BASELINE_PATH} — ${Object.keys(newBaseline.entries).length} entries`);
  }

  // Always also dump a daily report file (overwrite per day). Strip the
  // raw Lighthouse JSON from every entry here — that file is the human-readable
  // daily summary, not the artifact-grade audit-reports/ output below.
  const today = new Date().toISOString().split('T')[0];
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const slimResults = results.map((r) => { const { raw, ...rest } = r; return rest; });
  writeFileSync(
    resolve(REPORTS_DIR, `cls-${today}.json`),
    JSON.stringify({ generated: new Date().toISOString(), baseUrl: BASE_URL, threshold: HARD_CLS_THRESHOLD, results: slimResults, errors, hardRegressions: hardRegressions.length, softRegressions: softRegressions.length }, null, 2) + '\n',
  );

  // Structured audit-reports/ entry. Offender list = every result with a
  // non-improved verdict, sorted by current CLS desc. For HARD regressions
  // we preserve the full Lighthouse `psiRaw` so post-deploy debug can replay
  // the same CrUX + lab evidence offline.
  const offendersForReport = results
    .slice()
    .sort((a, b) => (b.effective ?? 0) - (a.effective ?? 0))
    .filter((r) => r.verdict.state !== 'flat' && r.verdict.state !== 'improved')
    .map((r) => {
      const base = {
        path: r.url,
        feature: r.strategy,
        metric: r.effective,
        ratio: null,
        cls: r.effective,
        source: r.source,
        baseline: r.baseline,
        verdict: r.verdict,
        attribution: r.attribution ?? null,
      };
      // Only hard regressions get the full Lighthouse payload — keeps the
      // JSON under ~1 MB for the typical 1-2 hard regressions per failed run.
      if (r.verdict.state === 'hard_regression') {
        base.psiRaw = r.raw ?? null;
        base.finalScreenshot = r.finalScreenshot ?? null;
      }
      return base;
    });
  await writeAuditReport({
    audit: 'cls-live',
    passed: hardRegressions.length === 0,
    threshold: { metric: 'cls', value: HARD_CLS_THRESHOLD, comparator: '<=' },
    baselineFile: 'data/cls-baseline.json',
    offenders: offendersForReport,
    byFeature: { mobile: results.filter((r) => r.strategy === 'mobile').length, desktop: results.filter((r) => r.strategy === 'desktop').length },
    extra: {
      hardRegressions: hardRegressions.length,
      softRegressions: softRegressions.length,
      errorsCount: errors.length,
      baseUrl: BASE_URL,
    },
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ results, errors, hardRegressions, softRegressions }, null, 2));
  } else {
    console.log('');
    console.log(`Targets audited: ${TARGETS.length} × ${STRATEGIES.length} = ${TARGETS.length * STRATEGIES.length}`);
    console.log(`Hard regressions: ${hardRegressions.length}`);
    console.log(`Soft regressions: ${softRegressions.length}`);
    console.log(`Errors: ${errors.length}`);
    if (hardRegressions.length > 0) {
      console.log(`\n🔴 Hard regressions (CI-blocking):`);
      for (const r of hardRegressions) console.log(`  - ${r.key}  cls=${fmt(r.effective)}  baseline=${fmt(r.baseline)}  ${r.verdict.reason}`);
    }
  }

  // Exit policy:
  //   0 — no hard regression (soft regressions are warning only)
  //   1 — at least one hard regression OR all PSI calls errored
  if (hardRegressions.length > 0) process.exit(1);
  if (results.length === 0 && errors.length > 0) process.exit(1);
  process.exit(0);
}

run().catch((e) => {
  console.error('audit-cls-live: fatal:', e?.stack || e);
  process.exit(1);
});
