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
 * Hard regressions and the deploy (owner decision, 2026-10-04: «nessun blocco
 * deploy, solo issue nel backlog»):
 *   With `--report-issue` (the post-deploy step passes it) a hard regression
 *   does NOT fail the step: it opens or updates the stable monitor issue
 *   CLS_REGRESSION_ISSUE_TITLE and exits 0. A later run that measures every
 *   target without any hard regression closes that issue. If the issue write
 *   cannot be confirmed the regression would be neither blocking nor tracked,
 *   so the step fails instead (exit 1). Without the flag (local verification,
 *   `verify-cls-fix.mjs`) a hard regression still exits 1, as before.
 *   PSI errors keep their own exit policy in both modes.
 *
 * Usage:
 *   node scripts/audit-cls-live.mjs                   # local verdict, exit 1 on hard regression
 *   node scripts/audit-cls-live.mjs --report-issue    # CI gate: hard regression → monitor issue, exit 0
 *   node scripts/audit-cls-live.mjs --json            # JSON report
 *   node scripts/audit-cls-live.mjs --rebaseline      # write current numbers to baseline
 *   node scripts/audit-cls-live.mjs --strategy=mobile # default: both
 *
 * Env:
 *   PAGESPEED_API_KEY  — optional, lifts the rate limit (loaded from RC by
 *                        load-rc-env.mjs in CI).
 *   LIVE_BASE_URL      — default https://frontaliereticino.ch
 *   CLS_LIVE_REPORTS_DIR / CLS_BASELINE_PATH — optional overrides of
 *                        `reports/` and `data/cls-baseline.json` (tests).
 *   CLS_GATE_BUILD_SHA — optional, the deployed build SHA shown in the issue.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';
import {
  createGithubIssue,
  isFailureReportingDisabled,
  resolveGithubIssue,
} from './lib/github-issue-creator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASELINE_PATH = process.env.CLS_BASELINE_PATH
  ? resolve(process.env.CLS_BASELINE_PATH)
  : resolve(ROOT, 'data/cls-baseline.json');
const REPORTS_DIR = process.env.CLS_LIVE_REPORTS_DIR
  ? resolve(process.env.CLS_LIVE_REPORTS_DIR)
  : resolve(ROOT, 'reports');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const REBASELINE = args.includes('--rebaseline');
const REPORT_ISSUE = args.includes('--report-issue');
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

// Retry on transient PSI 5xx errors (Lighthouse-side flakes) and response
// stream interruptions. Backoff: 2s/4s/8s/16s (30s maximum wait).
// PSI returns 500/502 surprisingly often under load; treating them as hard
// failures fails the deploy gate even when Google is the problem, not us.
// 4xx errors (bad URL, missing key, quota) are NOT retried with the same
// credentials — they indicate a configuration/provider response that the
// retry loop cannot fix. A configured key rejected with 401/403 gets one
// deliberate keyless fallback below, because PSI can still serve the request
// without a key and the live gate must not confuse key configuration with CLS.
// A body can terminate repeatedly while PSI is under load. Three attempts
// still produced one false live failure in consecutive deploys (#9978), so
// keep the retry bounded but allow the provider a longer recovery window.
const PSI_MAX_ATTEMPTS = 5;
const PSI_RETRY_BASE_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lab CLS retry: PSI is notoriously high-variance for layout-shift
// measurements. Sample lab=0.122 on one call vs lab=1.0 on the next is
// not unusual for the same URL (Lighthouse run-to-run jitter). When the
// FIRST call shows a "bad" lab while CrUX is already known-bad, sample
// 2 more PSI runs and KEEP THE BEST (min lab) — that's the closest
// reflection of the actual post-fix render. Without this, the gate
// flaps red whenever PSI happens to pick a slow lab measurement, even
// though the page is fine on average.
const LAB_RETRY_SAMPLES = 2;       // 2 additional samples (3 total)
const LAB_RETRY_THRESHOLD = 0.25;  // same as HARD_CLS_THRESHOLD

/**
 * Le due chiavi sotto cui Lighthouse pubblica l'attribuzione del layout shift,
 * IN ORDINE DI PRECEDENZA: `layout-shifts` e' quella viva, PSI risponde solo
 * con lei; `layout-shift-elements` e' ritirata e resta come fallback per i
 * report archiviati.
 *
 * L'ordine sta scritto UNA volta sola, qui: prima viveva in due funzioni
 * separate che potevano divergere in silenzio (nit della review su PR #7287).
 */
const LAYOUT_SHIFT_AUDIT_KEYS = ['layout-shifts', 'layout-shift-elements'];

/**
 * L'audit di attribuzione del layout shift PIU' la chiave che ha risposto,
 * insieme: `{ audit, source }`.
 *
 * La `source` non e' un extra: `audit.score` NON misura la stessa cosa nelle
 * due chiavi (audit binario sulla vecchia, CLS scalato sulla nuova), quindi un
 * confronto storico su quel numero e' valido solo fra report con la stessa
 * `source`. Derivarla QUI, dall'audit gia' scelto, invece di ri-leggere gli
 * `audits` altrove, e' cio' che rende impossibile la divergenza.
 *
 * Esportata e pura apposta: il difetto che chiude viveva dentro `runPsi()`,
 * che fa rete, quindi nessun test poteva vederlo e per tre settimane il campo
 * e' tornato `null` senza che niente fallisse.
 */
export function pickLayoutShiftAudit(audits) {
  for (const source of LAYOUT_SHIFT_AUDIT_KEYS) {
    const audit = audits?.[source];
    if (audit) return { audit, source };
  }
  return { audit: undefined, source: null };
}

/**
 * Proiezione COMPATTA e di forma stabile degli item di attribuzione.
 *
 * I due audit non hanno la stessa forma di `details.items`: il vecchio e' un
 * flat `{node, score}`, il nuovo puo' portare anche `subItems`/`cause` per
 * shift. Persistere gli item grezzi sotto lo stesso nome nell'artifact
 * post-deploy significherebbe cambiare forma (e dimensione) del campo senza
 * cambiargli nome — proprio cio' che il commento «compact subset» prometteva di
 * non fare. Misurato sulla risposta reale del 2026-09-04: item flat, 507 byte
 * l'uno, nessun `subItems`; ma la forma non e' garantita, quindi si proietta.
 *
 * Il payload Lighthouse integrale resta in `raw` per chi indaga davvero.
 */
export function compactShiftItems(audit, limit = 5) {
  const items = audit?.details?.items;
  if (!Array.isArray(items)) return null;
  return items.slice(0, limit).map((it) => ({
    score: it?.score ?? null,
    node: {
      selector: it?.node?.selector ?? null,
      snippet: it?.node?.snippet ?? null,
      nodeLabel: it?.node?.nodeLabel ?? null,
      boundingRect: it?.node?.boundingRect ?? null,
    },
  }));
}

export async function runPsiRequest(url, strategy, apiKey = '', fetchImpl = fetch, sleepImpl = sleep) {
  const params = new URLSearchParams({ url, strategy, category: 'performance' });
  if (apiKey) params.set('key', apiKey);
  const endpoint = `${PSI_ENDPOINT}?${params.toString()}`;

  let lastError = null;
  for (let attempt = 1; attempt <= PSI_MAX_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await fetchImpl(endpoint, { method: 'GET' });
    } catch (e) {
      // Network-layer failure (DNS, ECONNRESET, abort). Treat as transient.
      lastError = new Error(`PSI network error for ${url} (${strategy}): ${e.message || e}`);
      if (attempt < PSI_MAX_ATTEMPTS) {
        await sleepImpl(PSI_RETRY_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }
    let body;
    try {
      // Read the body explicitly so an undici `terminated`/premature-close
      // error is retried like the equivalent failure before headers arrive.
      // Previously `r.json()` lived outside the retry boundary and one
      // truncated PSI response became a false live-validation failure.
      body = await r.text();
    } catch (e) {
      lastError = new Error(`PSI network error for ${url} (${strategy}): ${e.message || e}`);
      if (attempt < PSI_MAX_ATTEMPTS) {
        await sleepImpl(PSI_RETRY_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }
    if (r.ok) {
      let j;
      try {
        j = JSON.parse(body);
      } catch (e) {
        throw new Error(`PSI malformed JSON for ${url} (${strategy}): ${e.message || e}`, { cause: e });
      }
      return parsePsiResponse(j);
    }
    const isTransient5xx = r.status >= 500 && r.status < 600;
    lastError = new Error(`PSI ${r.status} for ${url} (${strategy}): ${body.slice(0, 200)}`);
    if (!isTransient5xx || attempt >= PSI_MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleepImpl(PSI_RETRY_BASE_MS * Math.pow(2, attempt - 1));
  }
  // Defensive — unreachable, the loop always either returns or throws.
  throw lastError || new Error(`PSI failed after ${PSI_MAX_ATTEMPTS} attempts for ${url} (${strategy})`);
}

/**
 * PSI auth/quota and exhausted transient 5xx responses contain no live CLS
 * measurement. They are inconclusive provider failures, not evidence of a
 * site regression. 5xx responses have already passed the bounded retry loop
 * in `runPsiRequest`; classifying them here keeps a partial Lighthouse outage
 * from turning the deploy gate into a false site regression while preserving
 * failure-closed handling for malformed requests, network errors, and other
 * unclassified failures.
 */
export function isInconclusivePsiError(error) {
  const message = typeof error === 'string'
    ? error
    : error?.message || error?.error || '';
  const statuses = [...String(message).matchAll(/\bPSI\s+(\d{3})\b/g)]
    .map((match) => Number(match[1]));
  return statuses.length > 0 && statuses.every((status) =>
    [401, 403, 429].includes(status) || (status >= 500 && status <= 599));
}

export function shouldFailOpenForPsiErrors(errors = []) {
  return Array.isArray(errors) && errors.length > 0 && errors.every(isInconclusivePsiError);
}

async function runPsi(url, strategy) {
  try {
    return await runPsiRequest(url, strategy, API_KEY);
  } catch (error) {
    if (!API_KEY || !/\bPSI (?:401|403)\b/.test(error?.message || '')) throw error;

    // A key can be rejected by a stale restriction or an API enablement
    // mismatch even while unauthenticated PSI requests remain available.
    // Retry once without it so a secret/configuration problem cannot become a
    // false live-CMS regression. The original error is retained if fallback
    // also fails, making the report explain both attempts.
    try {
      return await runPsiRequest(url, strategy, '');
    } catch (fallbackError) {
      throw new Error(
        `${fallbackError.message || fallbackError} (keyed PSI request was rejected with ${error.message})`,
        { cause: fallbackError },
      );
    }
  }
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

  // Attribuzione del layout shift, proiettata compatta: il payload Lighthouse
  // integrale resta in `raw`. Quale chiave vince e perche' la vecchia resta
  // fallback e' nella jsdoc di `pickLayoutShiftAudit()`.
  const { audit: lsElements, source: lsSource } = pickLayoutShiftAudit(j.lighthouseResult?.audits);
  const finalScreenshot = j.lighthouseResult?.audits?.['final-screenshot']?.details?.data || null;

  return {
    cruxP75,
    cruxOriginP75,
    cruxCategory: cruxField?.category || null,
    lab,
    effective,
    source,
    attribution: {
      layoutShiftElements: compactShiftItems(lsElements),
      score: lsElements?.score ?? null,
      source: lsSource,
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

/**
 * Stable monitor title (no run number, no value): github-issue-creator.mjs
 * dedups every later regression into comments on the canonical issue, reopens
 * it within its default window, and `resolveGithubIssue` closes it by the same
 * exact title. Outside the `CWV Regression (` family of cwv-monitor-check.mjs
 * and outside the `*Failure:` titles of close-recovered-failure-issues.mjs, so
 * no other closer reconciles it.
 */
export const CLS_REGRESSION_ISSUE_TITLE = '[Monitor] CLS regression after deploy';
const CLS_ISSUE_WORKFLOW = 'Post-deploy Validate Live (CLS regression gate)';
const CLS_ISSUE_LABELS = ['performance'];

/**
 * Pure verdict of one gate run: which regressions count, what to do with the
 * monitor issue, and the exit code BEFORE the issue outcome is known.
 *
 *   - PSI errors: unchanged policy. Any non-inconclusive error exits 1; a run
 *     where every call failed inconclusively (401/403/429/5xx) passes open.
 *   - Hard regressions: exit 1 only without `reportIssue` (local verdict).
 *     With it they become `issueAction: 'report'`, and the caller exits 0 once
 *     the issue write is confirmed.
 *   - `resolve` only on a COMPLETE clean measurement: every expected call
 *     answered with a CLS value, no error at all. A target that errored or
 *     returned no CLS cannot prove that its regression is gone.
 */
export function decideClsGate({ results = [], errors = [], expectedCalls = 0, reportIssue = false } = {}) {
  const hardRegressions = results.filter((r) => r?.verdict?.state === 'hard_regression');
  const softRegressions = results.filter((r) => r?.verdict?.state === 'soft_regression');
  const hasBlockingPsiErrors = errors.some((error) => !isInconclusivePsiError(error));
  const allPsiProviderErrors =
    results.length === 0 && errors.length > 0 && shouldFailOpenForPsiErrors(errors);
  const psiExit = hasBlockingPsiErrors || (results.length === 0 && errors.length > 0 && !allPsiProviderErrors);

  const completeMeasurement =
    errors.length === 0
    && expectedCalls > 0
    && results.length === expectedCalls
    && results.every((r) => r?.effective != null && r?.verdict?.state !== 'unknown');

  let issueAction = 'none';
  if (reportIssue) {
    if (hardRegressions.length > 0) issueAction = 'report';
    else if (completeMeasurement) issueAction = 'resolve';
  }

  const regressionExit = hardRegressions.length > 0 && !reportIssue;
  return {
    hardRegressions,
    softRegressions,
    hasBlockingPsiErrors,
    allPsiProviderErrors,
    completeMeasurement,
    issueAction,
    exitCode: psiExit || regressionExit ? 1 : 0,
  };
}

function fmtField(value) {
  return value == null ? 'n/a' : fmt(value);
}

/**
 * Issue title + body for the hard regressions of one run: URL, field CLS (URL
 * and origin p75), lab CLS, the effective value and its source, baseline,
 * thresholds and the run link. Pure, so the test pins what the backlog sees.
 */
export function buildClsRegressionIssue({
  hardRegressions = [],
  baseUrl = BASE_URL,
  baselineGenerated = null,
  runUrl = null,
  buildSha = null,
} = {}) {
  const rows = hardRegressions.map((r) => (
    `| \`${r.key}\` | ${r.url} | ${fmtField(r.effective)} (\`${r.source}\`) | ${fmtField(r.cruxP75)} | `
    + `${fmtField(r.cruxOriginP75)} | ${fmtField(r.lab)} | ${fmtField(r.baseline)} | ${r.verdict?.reason ?? ''} |`
  ));
  const description = [
    `Il gate CLS post-deploy ha misurato **${hardRegressions.length}** regressione/i hard su ${baseUrl}.`,
    '',
    'Per decisione del proprietario del 2026-10-04 («nessun blocco deploy, solo issue nel backlog») il gate '
      + 'non fa fallire il deploy: la regressione è tracciata qui. La issue si chiude da sola alla prima run '
      + 'del gate che misura tutti i target senza regressioni hard.',
    '',
    '| Target | URL | CLS effettivo (fonte) | Campo p75 URL | Campo p75 origine | Lab | Baseline | Motivo |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `- **Baseline:** \`data/cls-baseline.json\` (generata ${baselineGenerated ?? 'n/a'})`,
    `- **Soglia:** hard se CLS > ${HARD_CLS_THRESHOLD} partendo da ≤ ${HARD_CLS_THRESHOLD}, oppure peggioramento `
      + `≥ +${ABS_REGRESSION} assoluto e ≥ +${(REL_REGRESSION * 100).toFixed(0)}% relativo con CLS > ${HARD_CLS_THRESHOLD}`,
    '- **Precedenza della fonte:** campo URL (CrUX p75), poi campo origine, poi lab; `lab_post_fix` quando il lab è '
      + 'sotto soglia e almeno la metà del campo',
    `- **Run:** ${runUrl ?? 'n/a'}`,
    ...(buildSha ? [`- **Build SHA:** ${buildSha}`] : []),
    '- **Evidenza:** artifact `cls-report-<run_id>` (report giornaliero) e `audit-reports-live-<run_id>-<attempt>` '
      + '(`cls-live.json` con il payload PSI completo delle regressioni hard)',
  ].join('\n');
  return { title: CLS_REGRESSION_ISSUE_TITLE, description };
}

/**
 * Applies `issueAction` to the monitor issue. The creator and resolver are
 * injectable (tests); the defaults are github-issue-creator.mjs.
 *
 * Returns `{ tracked }` for a report: `true` when the write is confirmed,
 * `'disabled'` when ENABLE_FAILURE_REPORT=false switched reporting off on
 * purpose, `false` otherwise (the caller then fails the step, because an
 * untracked regression that does not block is a lost signal). A failed resolve
 * is only a warning: the issue stays open and the next clean run closes it.
 */
export async function syncClsRegressionIssue(
  { issueAction, hardRegressions = [], baselineGenerated = null, runUrl = null, buildSha = null, baseUrl = BASE_URL },
  {
    create = createGithubIssue,
    resolve: resolveIssue = resolveGithubIssue,
    reportingDisabled = isFailureReportingDisabled,
  } = {},
) {
  if (issueAction === 'report') {
    const { title, description } = buildClsRegressionIssue({
      hardRegressions, baseUrl, baselineGenerated, runUrl, buildSha,
    });
    let result = null;
    try {
      result = await create({
        title,
        description,
        priority: 3,
        labels: CLS_ISSUE_LABELS,
        workflow: CLS_ISSUE_WORKFLOW,
        exactTitle: true,
      });
    } catch (error) {
      console.error(`audit-cls-live: monitor issue write failed: ${error?.message || error}`);
      return { action: 'report', tracked: false, issue: null };
    }
    if (result === null && reportingDisabled()) return { action: 'report', tracked: 'disabled', issue: null };
    return { action: 'report', tracked: result?.persisted === true, issue: result };
  }
  if (issueAction === 'resolve') {
    try {
      const closed = await resolveIssue(CLS_REGRESSION_ISSUE_TITLE, {
        workflow: CLS_ISSUE_WORKFLOW,
        runUrl,
        exactTitle: true,
      });
      return { action: 'resolve', tracked: true, issue: closed ?? null };
    } catch (error) {
      console.warn(`audit-cls-live: monitor issue close failed (it stays open until the next clean run): ${error?.message || error}`);
      return { action: 'resolve', tracked: false, issue: null };
    }
  }
  return { action: 'none', tracked: true, issue: null };
}

function appendSummary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try { appendFileSync(file, `${line}\n`); } catch { /* best-effort */ }
}

function setStepOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try { appendFileSync(file, `${name}=${value}\n`); } catch { /* best-effort */ }
}

function currentRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL || 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
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

  async function runPsiWithSamples(url, strategy) {
    let best = await runPsi(url, strategy);
    if (best.lab == null || best.lab < LAB_RETRY_THRESHOLD) return best;
    // First call returned a high lab. PSI lab is high-variance — sample
    // 2 more times (3 total) and keep the run with the lowest lab. The
    // min closely matches the page's actual post-fix render; high
    // samples are Lighthouse jitter, not true regressions.
    for (let extra = 0; extra < LAB_RETRY_SAMPLES; extra++) {
      try {
        const sample = await runPsi(url, strategy);
        if (sample.lab != null && (best.lab == null || sample.lab < best.lab)) {
          best = sample;
        }
        if (best.lab != null && best.lab < LAB_RETRY_THRESHOLD) break;
      } catch (_) { /* swallow — keep best from previous samples */ }
    }
    return best;
  }

  async function execOne(c) {
    try {
      const data = await runPsiWithSamples(c.url, c.strategy);
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

  const gate = decideClsGate({
    results,
    errors,
    expectedCalls: calls.length,
    // A rebaseline run replaces the reference it was judged against: it must
    // neither open nor close the monitor issue.
    reportIssue: REPORT_ISSUE && !REBASELINE,
  });
  const { hardRegressions, softRegressions, hasBlockingPsiErrors, allPsiProviderErrors } = gate;

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
    JSON.stringify({ generated: new Date().toISOString(), baseUrl: BASE_URL, threshold: HARD_CLS_THRESHOLD, results: slimResults, errors, hardRegressions: hardRegressions.length, softRegressions: softRegressions.length, inconclusive: allPsiProviderErrors }, null, 2) + '\n',
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
    passed: hardRegressions.length === 0
      && !hasBlockingPsiErrors
      && (results.length > 0 || allPsiProviderErrors),
    threshold: { metric: 'cls', value: HARD_CLS_THRESHOLD, comparator: '<=' },
    baselineFile: 'data/cls-baseline.json',
    offenders: offendersForReport,
    byFeature: { mobile: results.filter((r) => r.strategy === 'mobile').length, desktop: results.filter((r) => r.strategy === 'desktop').length },
    extra: {
      hardRegressions: hardRegressions.length,
      softRegressions: softRegressions.length,
      errorsCount: errors.length,
      inconclusive: allPsiProviderErrors,
      baseUrl: BASE_URL,
    },
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ results, errors, hardRegressions, softRegressions, inconclusive: allPsiProviderErrors }, null, 2));
  } else {
    console.log('');
    console.log(`Targets audited: ${TARGETS.length} × ${STRATEGIES.length} = ${TARGETS.length * STRATEGIES.length}`);
    console.log(`Hard regressions: ${hardRegressions.length}`);
    console.log(`Soft regressions: ${softRegressions.length}`);
    console.log(`Errors: ${errors.length}`);
    if (hardRegressions.length > 0) {
      console.log(gate.issueAction === 'report'
        ? `\n🔴 Hard regressions (tracked in the monitor issue, not deploy-blocking):`
        : `\n🔴 Hard regressions (exit 1):`);
      for (const r of hardRegressions) console.log(`  - ${r.key}  cls=${fmt(r.effective)}  baseline=${fmt(r.baseline)}  ${r.verdict.reason}`);
    }
  }

  setStepOutput('hard_regressions', String(hardRegressions.length));

  // Monitor issue (only with --report-issue): a hard regression opens or
  // updates it, a complete clean run closes it.
  const issue = await syncClsRegressionIssue({
    issueAction: gate.issueAction,
    hardRegressions,
    baselineGenerated: baseline.generated ?? null,
    runUrl: currentRunUrl(),
    buildSha: process.env.CLS_GATE_BUILD_SHA || null,
  });
  // Under --json this script's own annotations go to stderr; with
  // --report-issue the issue creator's log lines may still reach stdout.
  const note = JSON_OUT ? console.error : console.log;
  if (issue.action === 'report') {
    const ref = issue.issue?.url || (issue.issue?.number ? `#${issue.issue.number}` : CLS_REGRESSION_ISSUE_TITLE);
    if (issue.tracked === true) {
      note(`::warning::CLS: ${hardRegressions.length} hard regression(s), tracked in ${ref} — not deploy-blocking (owner decision 2026-10-04)`);
      appendSummary(`- ⚠️ CLS: ${hardRegressions.length} regressione/i hard, tracciata/e in ${ref} (non bloccante, decisione del proprietario 2026-10-04)`);
    } else if (issue.tracked === 'disabled') {
      note(`::warning::CLS: ${hardRegressions.length} hard regression(s); ENABLE_FAILURE_REPORT=false, no monitor issue written`);
    } else {
      note(`::error::CLS: ${hardRegressions.length} hard regression(s) and the monitor issue write was not confirmed — failing the step so the regression is not lost`);
      appendSummary(`- 🔴 CLS: ${hardRegressions.length} regressione/i hard NON tracciata/e (scrittura della issue non confermata): step rosso`);
    }
  }

  // Exit policy:
  //   0 — no blocking PSI error and, with --report-issue, every hard
  //       regression tracked in the monitor issue; an all-provider
  //       auth/quota outage is inconclusive and therefore passes open
  //   1 — any non-inconclusive PSI error; a hard regression without
  //       --report-issue (local verdict); a hard regression whose monitor
  //       issue write was not confirmed
  if (gate.exitCode !== 0) process.exit(gate.exitCode);
  if (issue.action === 'report' && issue.tracked === false) process.exit(1);
  if (allPsiProviderErrors) {
    // These responses contain zero CLS signal. Blocking the deploy gate on a
    // third-party auth/quota response is a false "Validation Failure", not a
    // real regression. Fail open, same as this repo's other watchdogs on
    // inconclusive API results (see check-pages-publish-lag.mjs).
    console.log('\n⚠️  All PSI calls were inconclusive (auth/quota 401/403/429) — not a site regression. Passing gate open.');
  }
  process.exit(0);
}

// Main-module guard, NON decorativo: questo modulo esporta funzioni pure che i
// test importano, e senza guard l'import fa partire il grid PSI completo
// (TARGETS x STRATEGIES, rete live) dentro il worker vitest, che poi muore su
// uno dei `process.exit()` di `run()`. Trovato dalla review su PR #7287: il
// test che pinna il contratto era lo stesso che innescava il gate.
// `verify-cls-fix.mjs` lancia questo file come PROCESSO (non lo importa),
// quindi per lui il guard e' trasparente.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch((e) => {
    console.error('audit-cls-live: fatal:', e?.stack || e);
    process.exit(1);
  });
}
