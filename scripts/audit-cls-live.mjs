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
 * URLs to audit. One representative per template + the known high-CLS surfaces
 * from the 2026-05-08 PostHog $web_vitals query (homepage, job-board).
 *
 * Adding here = locked into the ratchet. Choose URLs that:
 *  - Have stable, evergreen content (so the lab number is reproducible)
 *  - Cover every major template (no per-template surprise regression)
 *  - Have enough live traffic for CrUX field data when possible
 */
const TARGETS = [
  { id: 'home', path: '/' },
  { id: 'jobs_index', path: '/cerca-lavoro-ticino/' },
  { id: 'jobs_filter_concorsi', path: '/cerca-lavoro-ticino/concorsi-per-l-assunzione-di-personale-citta-di-lugano-lugano/' },
  { id: 'jobs_filter_addetti', path: '/cerca-lavoro-ticino/addetti-servizi-alla-casa/' },
  { id: 'articles_index', path: '/articoli-frontaliere/' },
  { id: 'comparators_currency', path: '/compara-servizi/cambio-franco-euro/' },
  { id: 'guide_lamal', path: '/guida-frontaliere/lamal-frontalieri/' },
  { id: 'guide_border_wait', path: '/guida-frontaliere/tempi-attesa-dogana/' },
  { id: 'calculator_root', path: '/calcola-stipendio/' },
  { id: 'fisco_simulation', path: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/' },
  { id: 'border_wait_hub', path: '/traffico-dogane/' },
  { id: 'fuel_today', path: '/prezzi-benzina/oggi/' },
  { id: 'health_premiums', path: '/premi-cassa-malati/' },
  { id: 'weekly_employers', path: '/aziende-che-assumono/ticino/settimana-corrente/' },
];

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

async function runPsi(url, strategy) {
  const params = new URLSearchParams({ url, strategy, category: 'performance' });
  if (API_KEY) params.set('key', API_KEY);
  const endpoint = `${PSI_ENDPOINT}?${params.toString()}`;
  const r = await fetch(endpoint, { method: 'GET' });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PSI ${r.status} for ${url} (${strategy}): ${t.slice(0, 200)}`);
  }
  const j = await r.json();

  // CrUX field (real users, 28-day rolling window). Only present if URL has
  // enough traffic. CrUX returns p75 of CLS distribution.
  const cruxField = j.loadingExperience?.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  const cruxOriginField = j.originLoadingExperience?.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE;

  // Lighthouse lab — always present. CLS is computed for the synthetic load.
  const labRaw = j.lighthouseResult?.audits?.['cumulative-layout-shift']?.numericValue;

  // CrUX returns CLS scaled ×100 (so a 0.10 CLS shows as 10). Normalize.
  const cruxP75 = cruxField?.percentile != null ? cruxField.percentile / 100 : null;
  const cruxOriginP75 = cruxOriginField?.percentile != null ? cruxOriginField.percentile / 100 : null;

  return {
    cruxP75,
    cruxOriginP75,
    cruxCategory: cruxField?.category || null,
    lab: typeof labRaw === 'number' ? labRaw : null,
    // Effective value to use: prefer field, fall back to lab
    effective: cruxP75 ?? cruxOriginP75 ?? (typeof labRaw === 'number' ? labRaw : null),
    source: cruxP75 != null ? 'crux_url' : cruxOriginP75 != null ? 'crux_origin' : labRaw != null ? 'lab' : 'unavailable',
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

  for (const target of TARGETS) {
    const url = `${BASE_URL}${target.path}`;
    for (const strategy of STRATEGIES) {
      const key = `${target.id}@${strategy}`;
      try {
        const data = await runPsi(url, strategy);
        const baselineValue = baseline.entries?.[key]?.cls ?? null;
        const verdict = classifyRegression(data.effective, baselineValue);
        results.push({ key, url, strategy, ...data, baseline: baselineValue, verdict });
        if (!JSON_OUT) {
          const tag =
            verdict.state === 'hard_regression' ? '🔴'
            : verdict.state === 'soft_regression' ? '⚠️'
            : verdict.state === 'improved' ? '✅'
            : verdict.state === 'new' ? '🆕'
            : verdict.state === 'flat' ? '·'
            : '?';
          console.log(`${tag} ${key.padEnd(40)} cls=${fmt(data.effective)} (src=${data.source}) baseline=${fmt(baselineValue)} — ${verdict.reason}`);
        }
        // Be polite to the API (default 25 req/100s without key)
        if (!API_KEY) await new Promise((r) => setTimeout(r, 4500));
      } catch (e) {
        errors.push({ key, url, strategy, error: e.message });
        if (!JSON_OUT) console.error(`❌ ${key}: ${e.message.slice(0, 200)}`);
      }
    }
  }

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

  // Always also dump a daily report file (overwrite per day)
  const today = new Date().toISOString().split('T')[0];
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(
    resolve(REPORTS_DIR, `cls-${today}.json`),
    JSON.stringify({ generated: new Date().toISOString(), baseUrl: BASE_URL, threshold: HARD_CLS_THRESHOLD, results, errors, hardRegressions: hardRegressions.length, softRegressions: softRegressions.length }, null, 2) + '\n',
  );

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
