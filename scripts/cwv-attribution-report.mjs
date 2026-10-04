#!/usr/bin/env node
// CWV attribution report — which element moves, and the p75 per job-board template.
//
// The weekly CWV monitor (scripts/cwv-monitor-check.mjs) coins a regression per
// page with device and p75, but nothing in the chain said WHICH element shifts,
// and a template-wide defect (job_detail: thousands of pages, none in
// TARGET_PAGES) stayed invisible. This report reads the field attribution that
// services/webVitalsAttribution.ts emits as `ui_interaction` (page=web_vitals)
// and the `web_vitals` p75 per `page_template`, and posts it on the open CWV
// regression issues.
//
//   node scripts/cwv-attribution-report.mjs --dry-run   # print the markdown, comment nothing
//   node scripts/cwv-attribution-report.mjs --comment   # also comment on the open CWV issues
//
// Exit 1 when the GA4 Data API rejects a request (an unregistered dimension
// must not pass in silence) or no service-account token is available; exit 0
// with «nessun evento di attribuzione nella finestra» when the window has no
// attribution rows yet.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GA4_READONLY_SCOPE,
  fetchRetry,
  ga4DateRange,
  getServiceAccountToken,
} from './lib/ga4-service-account.mjs';
import {
  ATTRIBUTION_PAGE,
  fetchAttribution,
  invalidDimension,
  summarizeAttribution,
  templateP75,
  topClsSelectors,
} from './lib/cwv-attribution.mjs';

export const WINDOW_DAYS = 7;
export const LAG_DAYS = 2;
// Each GA4 request is bounded (30 s) and retried only on 429/5xx: a transient
// Data API hiccup does not fail the run, a 4xx (unregistered dimension) still
// returns at once and fails closed.
export const GA4_REQUEST_TIMEOUT_MS = 30_000;
export const GA4_REQUEST_RETRIES = 2;
const defaultFetch = (url, options) =>
  fetchRetry(url, options, GA4_REQUEST_RETRIES, GA4_REQUEST_TIMEOUT_MS);
export const CWV_REGRESSION_LABEL = 'cwv-regression';
export const WATCHLIST_TITLE_PREFIX = 'CWV field regression on a tracked page';
export const NO_EVENTS_MESSAGE = 'nessun evento di attribuzione nella finestra';
export const FAILURE_TITLE = 'CWV attribution report: dimensione GA4 non valida, contratto client/lettore divergente o evento web_vitals assente';
export const REPORT_HEADING = '### Attribuzione CWV dal campo';

const fmtCls = (n) => (typeof n === 'number' ? n.toFixed(3) : 'n/a');
const fmtMs = (n) => (typeof n === 'number' ? `${Math.round(n)} ms` : 'n/a');
const fmtMean = (n) => (typeof n === 'number' ? n.toFixed(1) : 'n/a');
const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/`/g, "'");

export function renderReport(report, { runUrl } = {}) {
  const { window, attribution, selectors, templates, coverage = {} } = report;
  const lines = [
    REPORT_HEADING,
    '',
    `Finestra GA4 ${window.startDate} → ${window.endDate} (${WINDOW_DAYS} giorni, ritardo ${LAG_DAYS}). `
      + `Fonte: evento \`ui_interaction\` con \`page = ${ATTRIBUTION_PAGE}\` su \`/\` e \`/cerca-lavoro*\`, `
      + 'emesso da `services/webVitalsAttribution.ts` per ogni CLS/INP non `good`.',
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);

  lines.push('', '#### Elemento che si sposta (section × component × action)', '');
  const summary = summarizeAttribution(attribution);
  if (!summary.length) {
    lines.push(`_${NO_EVENTS_MESSAGE}._`);
  } else {
    lines.push('| section | component | action | eventi |', '|---|---|---|---:|');
    for (const row of summary) lines.push(`| ${cell(row.section)} | ${cell(row.component)} | ${cell(row.action)} | ${row.count} |`);
    if (coverage.attributionTruncated) lines.push('', '_Attenzione: GA4 ha troncato le righe (bucket `(other)` o righe oltre il limite)._');
  }

  if (summary.length) {
    lines.push('', '#### Primi selettori CLS', '');
    const top = topClsSelectors(selectors);
    if (!top.length) {
      lines.push('_Nessun selettore CLS nella finestra._');
    } else {
      lines.push('| # | selettore | component | eventi | ac medio | cc medio |', '|---:|---|---|---:|---:|---:|');
      top.forEach((row, i) => lines.push(`| ${i + 1} | \`${cell(row.selector)}\` | ${cell(row.component)} | ${row.count} | ${fmtMean(row.ac)} | ${fmtMean(row.cc)} |`));
      lines.push('', '_`ac` = contenitori Auto Ads presenti, `cc` = quelli collassati da `services/autoAdCollapse.ts`, medie pesate per evento._');
      if (coverage.selectorsTruncated) lines.push('_I selettori sono letti dalle prime righe per eventi: la coda e\' fuori dal limite della richiesta._');
    }
  }

  lines.push('', '#### p75 per template su `/cerca-lavoro*`', '');
  const perTemplate = templateP75(templates);
  if (!perTemplate.length) {
    lines.push('_Nessun evento `web_vitals` con `page_template` nella finestra._');
  } else {
    lines.push('| template | device | CLS p75 | n CLS | INP p75 | n INP |', '|---|---|---:|---:|---:|---:|');
    for (const row of perTemplate) {
      lines.push(`| ${cell(row.template)} | ${cell(row.device)} | ${fmtCls(row.clsP75)} | ${row.clsN} | ${fmtMs(row.inpP75)} | ${row.inpN} |`);
    }
    if (coverage.templatesTruncated) lines.push('', '_Attenzione: GA4 ha troncato le righe, il p75 puo\' essere distorto._');
  }
  return `${lines.join('\n')}\n`;
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Open CWV issues: every `cwv-regression` one plus the #5001 watchlist tracker. Never closed ones. */
export function findTargetIssues(gh = defaultGh) {
  const labelled = JSON.parse(gh(['issue', 'list', '--state', 'open', '--label', CWV_REGRESSION_LABEL, '--limit', '100', '--json', 'number,title,state']) || '[]');
  const watchlist = JSON.parse(gh(['issue', 'list', '--state', 'open', '--search', `in:title "${WATCHLIST_TITLE_PREFIX}"`, '--limit', '20', '--json', 'number,title,state']) || '[]')
    .filter((issue) => String(issue.title || '').startsWith(WATCHLIST_TITLE_PREFIX));
  const byNumber = new Map();
  for (const issue of [...labelled, ...watchlist]) {
    // `--state open` already filters; the state check keeps a search hiccup
    // from ever commenting on a closed issue.
    if (issue.state && String(issue.state).toUpperCase() !== 'OPEN') continue;
    if (Number.isSafeInteger(issue.number)) byNumber.set(issue.number, issue);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function commentOnIssues(issues, markdown, gh = defaultGh) {
  const dir = mkdtempSync(join(tmpdir(), 'cwv-attribution-'));
  try {
    const bodyFile = join(dir, 'comment.md');
    writeFileSync(bodyFile, markdown);
    for (const issue of issues) gh(['issue', 'comment', String(issue.number), '--body-file', bodyFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runUrlFromEnv(env) {
  return env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = defaultFetch,
  getToken = () => getServiceAccountToken([GA4_READONLY_SCOPE]),
  gh = defaultGh,
  log = console.log,
  logError = console.error,
} = {}) {
  const comment = argv.includes('--comment');
  const dryRun = argv.includes('--dry-run') || !comment;

  const token = await getToken();
  if (!token) {
    logError(`::error title=${FAILURE_TITLE}::nessun token del service account GA4 (GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_SERVICE_ACCOUNT_JSON)`);
    return 1;
  }

  const { startDate, endDate } = ga4DateRange(WINDOW_DAYS, LAG_DAYS, now);
  let report;
  try {
    report = await fetchAttribution({ token, startDate, endDate, fetchImpl });
  } catch (error) {
    const dimension = invalidDimension(error?.message);
    const detail = dimension
      ? `la Data API non riconosce la dimensione ${dimension}: il parametro non e' registrato o il contratto client/lettore e' cambiato`
      : `richiesta GA4 fallita: ${String(error?.message || error).slice(0, 400)}`;
    logError(`::error title=${FAILURE_TITLE}::${detail}`);
    return 1;
  }

  const markdown = renderReport(report, { runUrl: runUrlFromEnv(env) });
  log(markdown);

  if (!report.attribution.length) {
    log(NO_EVENTS_MESSAGE);
    return 0;
  }
  if (dryRun) return 0;

  const issues = findTargetIssues(gh);
  if (!issues.length) {
    log('Nessuna issue CWV aperta da commentare.');
    return 0;
  }
  commentOnIssues(issues, markdown, gh);
  log(`Commentate: ${issues.map((issue) => `#${issue.number}`).join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`::error title=${FAILURE_TITLE}::${error?.stack || error}`);
    process.exitCode = 1;
  });
}
