#!/usr/bin/env node
/**
 * Google Indexing API (JobPosting only)
 *
 * Notifies Google of job pages via the Indexing API, the official channel for
 * JobPosting (Google accepts only JobPosting / BroadcastEvent pages here).
 *
 * Caller: ONLY the `indexing` job of monitor-gsc-seo.yml, serialized by the
 * concurrency group `indexing-api-jobs-ledger` (one writer of the ledger at a
 * time). It runs daily right after the PT quota reset, with the URLs the GSC
 * monitor found WITHOUT a "Job Postings" rich result as `--priority-file`, and
 * after every successful publish (post-deploy-publish.yml dispatches
 * monitor-gsc-seo.yml with mode=post-publish; small `--max`, so new jobs reach
 * Google the same day).
 *
 * Source of URLs: the LIVE job sitemaps (what Google is told exists), merged
 * with the active jobs of the published dataset (the data-CDN slim index +
 * slug map, scripts/lib/indexing-jobs-dataset.mjs), so the script needs
 * neither a build nor jobs.json. The second source exists because the job
 * sitemaps only move with a full publish: from 2026-11-06 every publish
 * failed, the sitemaps stayed at 06-11 and the offers that went live through
 * the section shards were in no sitemap, hence never notified. A dataset-only
 * URL is sent only after its live page proves to be the ACTIVE detail page of
 * that job (judgeDatasetLive); if the dataset cannot be read the run warns
 * and uses the sitemaps alone. What to send and in which order
 * is decided by scripts/lib/indexing-jobs-planner.mjs against a persistent
 * ledger (`--ledger`, pulled from / pushed to Firestore around this script by
 * scripts/lib/indexing-ledger-store.mjs) that also carries the per-day
 * request counter.
 * Every URL is fetched live before it is notified: URL_UPDATED only for a 200
 * page carrying JobPosting without noindex, URL_DELETED only for 404/410 or
 * noindex. Nothing that is not a job page is ever sent.
 *
 * Authentication — the first identity Google accepts as Search Console OWNER
 * (checked with the read-only urlNotifications/metadata endpoint, which does
 * not consume the publish quota):
 *   1. Service account (GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_JSON)
 *   2. OAuth2 user (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN, from
 *      Remote Config via scripts/load-rc-env.mjs)
 * Until 2026-10 the script stopped at the service account: that identity is
 * only `siteFullUser` on sc-domain:frontaliereticino.ch, so every publish got
 * 403 "Failed to verify the URL ownership" and no job URL was ever notified.
 *
 * Usage:
 *   node scripts/submit-google-indexing-jobs.js [--max N] [--max-first-run N]
 *        [--priority-file f.json] [--ledger path] [--dry-run]
 *
 * Exit codes — a green run must mean the notifications could be attempted:
 *   0  done, including "nothing to send", the daily quota already spent, and
 *      a 429 "Quota exceeded" from Google (expected at 200/day, the day is
 *      closed in the ledger and the next day resumes);
 *   1  configuration/auth error: invalid ledger, no credentials, no identity
 *      Google accepts as Search Console owner, 403 on publish, or an
 *      unexpected exception (the 2026-10-28 → 2026-11-10 runs exited 0 on all
 *      of these, so a green check proved nothing).
 * Every outcome is also written to the step summary and as an annotation.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { DEFAULT_OWNER_PROBE_URL, resolveOwnerToken } from './lib/indexing-owner.mjs';
import { DAILY_BUDGET, DEFAULT_INDEXING_LEDGER, writeLedgerFile } from './lib/indexing-api-quota.mjs';
import {
  quotaDayKey,
  isJobDetailCandidate,
  parseSitemapUrlset,
  parseJobSitemapIndex,
  loadLedger,
  observeSitemap,
  planSubmissions,
  countDedupSkipped,
  recordOutcome,
  reserveQuota,
  judgeLive,
  spentOn,
} from './lib/indexing-jobs-planner.mjs';
import { loadDatasetJobEntries, mergeJobSources, judgeDatasetLive } from './lib/indexing-jobs-dataset.mjs';

const SITE_URL = 'https://frontaliereticino.ch';
const DEFAULT_MAX = 15;
const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 20_000;
const INDEXING_PUBLISH = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
export { DAILY_BUDGET };
const USER_AGENT = 'frontaliere-indexing-api/2.0 (+https://frontaliereticino.ch)';

export {
  DEFAULT_OWNER_PROBE_URL,
  isOwnerProbeSuccess,
  probeOwnership,
  resolveOwnerToken,
} from './lib/indexing-owner.mjs';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(prefix, msg) { console.log(`${prefix} ${msg}`); }

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function parseArgs(argv) {
  const args = { max: DEFAULT_MAX, maxFirstRun: 0, priorityFile: null, ledger: DEFAULT_INDEXING_LEDGER, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--max-first-run') args.maxFirstRun = Number(argv[++i]);
    else if (a === '--priority-file') args.priorityFile = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
  }
  const envMax = Number(process.env.GSC_JOBS_INDEXING_MAX);
  if (!argv.includes('--max') && Number.isFinite(envMax) && envMax > 0) args.max = envMax;
  args.max = Math.max(0, Math.min(DAILY_BUDGET, Math.floor(Number.isFinite(args.max) ? args.max : DEFAULT_MAX)));
  args.maxFirstRun = Math.max(0, Math.min(DAILY_BUDGET, Math.floor(Number.isFinite(args.maxFirstRun) ? args.maxFirstRun : 0)));
  return args;
}

/**
 * Per-run cap. `--max-first-run` lets whichever run opens the quota day
 * (nothing spent yet) take the large share, so it does not matter whether the
 * 08:20 schedule or a deploy-triggered run gets there first.
 */
export function runBudgetFor(args, spent) {
  // An explicit --max 0 (e.g. indexing_max=0 on dispatch) is a hard stop:
  // the first-run share must never turn "send nothing" into 2,000 requests.
  if (!(args.max > 0)) return 0;
  const cap = spent === 0 && args.maxFirstRun > args.max ? args.maxFirstRun : args.max;
  return Math.max(0, Math.min(cap, DAILY_BUDGET - spent));
}

// ── Sitemaps ────────────────────────────────────────────────

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) { lastErr = err; }
    await sleep(1000 * attempt);
  }
  throw new Error(`${url}: ${lastErr?.message}`);
}

/** Every job-detail candidate across the live job sitemaps. Throws if any sitemap is unreadable. */
async function loadLiveJobUrls() {
  const index = await fetchText(`${SITE_URL}/sitemap.xml`);
  const sitemaps = parseJobSitemapIndex(index);
  if (sitemaps.length === 0) throw new Error('no job sitemap in the sitemap index');
  const byUrl = new Map();
  for (const sm of sitemaps) {
    for (const entry of parseSitemapUrlset(await fetchText(sm))) {
      if (!isJobDetailCandidate(entry.loc)) continue;
      const prev = byUrl.get(entry.loc);
      if (!prev || (entry.lastmod && (!prev.lastmod || entry.lastmod > prev.lastmod))) byUrl.set(entry.loc, entry);
    }
  }
  log('🗺️', `${byUrl.size} job-detail URLs in ${sitemaps.length} live job sitemaps`);
  return [...byUrl.values()];
}

async function liveCheck(type, url, item = {}) {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
    const html = res.status === 200 ? await res.text() : '';
    // A URL only the dataset knows must be the ACTIVE page of its job, not
    // just any 200 carrying JobPosting (see judgeDatasetLive).
    if (item.source === 'dataset' && type === 'URL_UPDATED') {
      return judgeDatasetLive({ status: res.status, html }, { id: item.id });
    }
    return judgeLive(type, { status: res.status, html });
  } catch {
    // Timeout or transport error: says nothing about the page, retry later.
    return 'transient';
  }
}

export const LIVE_CHECK_CONCURRENCY = 32;

/** Run live checks with a fixed worker pool so a full quota day fits the job deadline. */
export async function runLiveChecks(plan, { concurrency = LIVE_CHECK_CONCURRENCY, check = liveCheck } = {}) {
  const results = new Array(plan.length);
  if (plan.length === 0) return results;
  const requestedWorkers = Number.isFinite(concurrency) ? Math.floor(concurrency) : LIVE_CHECK_CONCURRENCY;
  const workerCount = Math.min(Math.max(1, requestedWorkers), plan.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= plan.length) return;
      const item = plan[index];
      results[index] = { item, verdict: await check(item.type, item.url, item) };
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ── Publish ─────────────────────────────────────────────────

async function publish(token, url, type, attempt = 1, beforeRequest = () => true) {
  if (!beforeRequest()) return { ok: false, status: 0, quotaExhausted: true, body: 'shared quota exhausted' };
  try {
    const res = await fetchWithTimeout(INDEXING_PUBLISH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type }),
    });
    if (res.ok) return { ok: true, status: res.status };
    if (res.status >= 500 && attempt <= MAX_RETRIES) {
      await sleep(500 * attempt);
      return publish(token, url, type, attempt + 1, beforeRequest);
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text.replace(/\s+/g, ' ').slice(0, 200) };
  } catch (err) {
    if (attempt <= MAX_RETRIES) {
      await sleep(500 * attempt);
      return publish(token, url, type, attempt + 1, beforeRequest);
    }
    return { ok: false, status: 0, body: err.message };
  }
}

/**
 * Tag every planned item with the source of its URL and pick the ones to
 * live-check: at most `maxChecks` in plan order, of which at most
 * `maxDatasetChecks` dataset-only. A dataset-only URL whose page is not
 * published yet costs a GET and no request; the cap keeps a large unpublished
 * set from consuming every check of the run and starving the sitemap URLs.
 */
export function selectLiveChecks(plan, datasetOnly, { maxChecks, maxDatasetChecks }) {
  const out = [];
  let datasetChecks = 0;
  for (const item of plan) {
    if (out.length >= maxChecks) break;
    const fromDataset = datasetOnly.has(item.url);
    if (fromDataset) {
      if (datasetChecks >= maxDatasetChecks) continue;
      datasetChecks += 1;
    }
    out.push({ ...item, source: fromDataset ? 'dataset' : 'sitemap', id: fromDataset ? datasetOnly.get(item.url) ?? null : null });
  }
  return out;
}

function readPriority(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    const list = Array.isArray(data) ? data : data.urls;
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch { return []; }
}

function summary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`); } catch { /* ignore */ }
}

export const TIERS = ['new', 'delete', 'priority', 'updated', 'backlog'];
export const SOURCES = ['sitemap', 'dataset'];

/**
 * One line + one summary table per run, whatever the outcome: sent per class,
 * skipped for dedup, quota left. `outcome` is the run verdict shown first.
 * `bySource` splits the sent requests of each class between URLs read from
 * the sitemaps and URLs only the dataset knows; `sources` is the input side
 * (URLs read from each source, `datasetError` when the dataset was skipped).
 */
export function formatRunReport({
  outcome, byTier = {}, bySource = {}, sources = null, dedupSkipped = 0, liveSkipped = 0, notLive = 0, failed = 0,
  spent = 0, budget = DAILY_BUDGET, today,
}) {
  const tiers = TIERS.map((t) => `${t}=${byTier[t] || 0}`).join(' ');
  const sent = TIERS.reduce((n, t) => n + (byTier[t] || 0), 0);
  const left = Math.max(0, budget - spent);
  const perSource = SOURCES.map((src) => `${src}: ${TIERS.map((t) => `${t}=${bySource[src]?.[t] || 0}`).join(' ')}`).join('; ');
  // Error/warning text comes from the network (CDN status, exception
  // messages): one line, no table separator, so it cannot break the summary.
  const clean = (v) => String(v).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  const input = sources
    ? (sources.datasetError
      ? `input: ${sources.sitemap} sitemap URLs, dataset unavailable (${clean(sources.datasetError)})`
      : `input: ${sources.sitemap} sitemap URLs + ${sources.datasetOnly} dataset-only of ${sources.dataset} dataset URLs${sources.datasetWarning ? ` (${clean(sources.datasetWarning)})` : ''}`)
    : null;
  return {
    line: `${outcome}: sent ${sent} (${tiers}) [${perSource}], skipped ${dedupSkipped} for dedup + ${liveSkipped} by live check (${notLive} dataset-only not published yet), failed ${failed}; quota ${spent}/${budget} used, ${left} left (day ${today} PT)${input ? `; ${input}` : ''}`,
    table: [
      '## Google Indexing API — job pages',
      '',
      `**${outcome}**`,
      '',
      '| new | delete | priority | updated | backlog | skipped: dedup | skipped: live check | failed | quota used | quota left |',
      '|---|---|---|---|---|---|---|---|---|---|',
      `| ${TIERS.map((t) => byTier[t] || 0).join(' | ')} | ${dedupSkipped} | ${liveSkipped} | ${failed} | ${spent}/${budget} | ${left} |`,
      '',
      '| source | new | delete | priority | updated | backlog |',
      '|---|---|---|---|---|---|',
      ...SOURCES.map((src) => `| ${src} | ${TIERS.map((t) => bySource[src]?.[t] || 0).join(' | ')} |`),
      ...(input ? ['', `${input}; ${notLive} dataset-only URL(s) not published yet (re-checked next quota day)`] : []),
    ],
  };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = quotaDayKey();
  log('📨', `Google Indexing API — JobPosting notifications (quota day ${today} PT, daily quota ${DAILY_BUDGET}${args.dryRun ? ', DRY RUN' : ''})`);

  const counts = { liveSkipped: 0, notLive: 0, failed: 0 };
  const byTier = {};
  const bySource = { sitemap: {}, dataset: {} };
  const countSent = (item) => {
    byTier[item.tier] = (byTier[item.tier] || 0) + 1;
    const src = bySource[item.source] || bySource.sitemap;
    src[item.tier] = (src[item.tier] || 0) + 1;
  };
  let ledger = null;
  let sources = null;
  let dedupSkipped = 0;
  const report = (outcome, level = 'notice') => {
    const r = formatRunReport({
      outcome, byTier, bySource, sources, dedupSkipped, liveSkipped: counts.liveSkipped, notLive: counts.notLive, failed: counts.failed,
      spent: ledger ? spentOn(ledger, today) : 0, today,
    });
    log('📊', r.line);
    console.log(`::${level} title=Indexing API (jobs)::${r.line}`);
    summary(r.table);
  };
  const fail = (outcome) => { report(outcome, 'error'); process.exitCode = 1; };

  // Sole bootstrap point of the shared ledger: the workflow pulls it from
  // Firestore first, and a pull that found nothing leaves no file — only then
  // does this run start from zero. A file that exists but does not parse still
  // holds an unknown spend: stop loudly and keep it.
  ledger = loadLedger(existsSync(args.ledger) ? readFileSync(args.ledger, 'utf-8') : null, today);
  if (!ledger) {
    fail(`Ledger ${args.ledger} is invalid — no request sent (inspect Firestore ci_state/indexing-api-jobs-ledger)`);
    return;
  }
  const spent = spentOn(ledger, today);
  const runBudget = runBudgetFor(args, spent);
  log('📊', `Budget: ${spent}/${DAILY_BUDGET} used today, this run may send ${Math.max(0, runBudget)}`);
  const priority = readPriority(args.priorityFile);

  let sitemapEntries;
  try { sitemapEntries = await loadLiveJobUrls(); } catch (err) {
    // The live site being unreachable says nothing about our configuration;
    // the next run retries with the ledger untouched. The dataset alone is
    // never enough: without the sitemaps every URL they list would look gone.
    report(`Live sitemaps unreadable (${err.message}) — nothing sent, ledger untouched`, 'warning');
    return;
  }
  const dataset = await loadDatasetJobEntries();
  if (dataset.error) {
    console.log(`::warning title=Indexing API (jobs)::Dataset unavailable (${dataset.error}) — sitemap URLs only`);
  } else {
    if (dataset.warning) console.log(`::warning title=Indexing API (jobs)::${dataset.warning}`);
    log('📦', `${dataset.entries.length} job-detail URLs from ${dataset.jobs} active jobs in the published dataset`);
  }
  const merged = mergeJobSources(sitemapEntries, dataset.entries);
  // Kept in `sources` so every report — early returns included — repeats the
  // dataset error/warning, not only the annotation printed above.
  sources = { ...merged.counts, datasetError: dataset.error, datasetWarning: dataset.warning || null };
  log('🔀', `${merged.entries.length} URLs after merge: ${merged.counts.sitemap} from sitemaps, ${merged.counts.datasetOnly} only in the dataset (${merged.counts.both} in both)`);
  observeSitemap(ledger, merged.entries, today, { datasetOnly: merged.datasetOnly });
  dedupSkipped = countDedupSkipped(ledger, { today, priority });
  const save = () => { if (!args.dryRun) writeLedgerFile(args.ledger, ledger); };
  const reserveRequest = () => {
    const reserved = reserveQuota(ledger, today);
    if (reserved) save();
    return reserved;
  };

  if (runBudget <= 0) { save(); report('Daily quota already spent — nothing sent'); return; }

  if (args.priorityFile) {
    log('🎯', existsSync(args.priorityFile)
      ? `${priority.length} priority URL(s) without Jobs rich result from ${args.priorityFile}`
      : `No ${args.priorityFile} (the GSC monitor did not run in this workflow run)`);
  }
  const plan = planSubmissions(ledger, { today, max: runBudget, priority });
  if (plan.length === 0) { save(); report('Nothing to notify'); return; }

  const token = args.dryRun ? null : await resolveOwnerToken(plan[0].url);
  if (!args.dryRun && !token) {
    save();
    fail('No credentials Google accepts as Search Console owner — nothing sent');
    return;
  }

  let sent = 0;
  let consecutive429 = 0;
  let verdict = 'Done';
  let fatal = false;
  // Bound the live fetches: landing pages share the job-detail URL shape, and
  // a backlog full of them must not turn one run into thousands of GETs.
  // Dataset-only URLs may take at most half of them (selectLiveChecks).
  const maxChecks = runBudget * 4;
  const checked = await runLiveChecks(selectLiveChecks(plan, merged.datasetOnly, { maxChecks, maxDatasetChecks: runBudget * 2 }));
  for (const { item, verdict: live } of checked) {
    if (sent >= runBudget) break;
    if (live !== 'ok') {
      counts.liveSkipped += 1;
      if (live === 'not-live') counts.notLive += 1;
      if (!args.dryRun && live !== 'transient') {
        recordOutcome(ledger, item, live, today);
        save();
      }
      continue;
    }
    if (args.dryRun) {
      sent += 1;
      countSent(item);
      log('  ', `would ${item.type} [${item.tier}/${item.source}] ${item.url}`);
      continue;
    }
    const res = await publish(token, item.url, item.type, 1, reserveRequest);
    if (res.quotaExhausted) { verdict = 'Shared daily quota exhausted'; break; }
    if (res.ok) {
      sent += 1;
      consecutive429 = 0;
      countSent(item);
      recordOutcome(ledger, item, 'sent', today, { quotaReserved: true });
      save();
      log('  ✅', `${item.type} [${item.tier}/${item.source}] ${item.url}`);
    } else {
      counts.failed += 1;
      log('  ⚠️', `${item.type} ${res.status} ${item.url} ${res.body || ''}`.trim());
      if (res.status === 401 || res.status === 403) {
        verdict = `Permission error ${res.status} from the Indexing API — run aborted`;
        fatal = true;
        break;
      }
      if (res.status === 429 && ++consecutive429 >= 2) {
        // Google's own counter is the truth: close the day so later callers skip.
        ledger.days[today] = DAILY_BUDGET;
        verdict = 'Google quota exceeded (429) — day closed, resumes after the PT reset';
        break;
      }
    }
    await sleep(150);
  }
  save();
  if (fatal) fail(verdict); else report(args.dryRun ? `${verdict} (dry run)` : verdict);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.log(`::error title=Indexing API (jobs)::Unhandled error: ${err.stack || err.message}`);
    process.exit(1);
  });
}
