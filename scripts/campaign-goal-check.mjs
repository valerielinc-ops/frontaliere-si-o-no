#!/usr/bin/env node
/**
 * campaign-goal-check.mjs — scheduled verification of the measurable goals
 * declared in the campaign backlog issues #4298-#4307
 * (valerielinc-ops/frontaliere-si-o-no). Only monitor-seo-ctr-by-template.yml
 * (CTR-by-template) and cwv-monitor.yml (Core Web Vitals) had scheduled
 * checks before this — the 9 goals below had none.
 *
 * Zero Claude invocations — deterministic provider queries only (AGENTS.md
 * quota-frugality rule).
 *
 * State machine per goal (data/campaign-goal-status.json):
 *   observing  → today < campaignStart + matureAfterDays. Log only, no
 *                provider query, no issue.
 *   passed     → evaluated once mature and met target. NEVER re-evaluated
 *                again (state is terminal — goal stays "passed" forever).
 *   failing    → evaluated, missed target. Opens/dedupes a GitHub issue via
 *                scripts/lib/github-issue-creator.mjs with a stable per-goal
 *                title ("Campaign goal FAILED: <id>"). Re-evaluated every run
 *                until it passes.
 *   error      → the provider query for this goal failed this run. Logged
 *                only — NEVER opens an issue by itself (a single broken goal
 *                must not spam issues on a live-still-maturing metric).
 *   unmeasurable → the goal's data source doesn't support the query on this
 *                plan/endpoint (currently only possible for bing_clicks).
 *                Logged with a note, no issue.
 *
 * Anti-watchdog-dead guard (mirrors scripts/cwv-monitor-check.mjs): a single
 * goal's provider failure is soft (state=error, no issue) — but if EVERY
 * goal sharing the same `source` fails to query in the same run, that source
 * is flagged "dead" (auth/host almost certainly broken) and the process
 * exits 1 so CI surfaces it loudly instead of silently reporting nothing
 * forever.
 *
 * Usage: node scripts/campaign-goal-check.mjs [--dry-run]
 *   --dry-run: evaluate + print the table, but never write state or open
 *              issues (used for local dry runs / tests).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runHogQL } from './lib/posthog-client.mjs';
import { checkPostHogLiveness, declareNotMeasurable, evaluateLiveness } from './lib/source-liveness.mjs';
import { aggregateFamilyRows } from './lib/seo-ctr-curve.mjs';
import { computeCtr } from './lib/analytics-opportunity-utils.mjs';
import { getServiceAccountToken, DEFAULT_GA4_PROPERTY_ID } from './lib/ga4-service-account.mjs';
import { getBingRankAndTrafficStats } from './lib/bing-webmaster.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATE_PATH = resolve(ROOT, 'data', 'campaign-goal-status.json');
const DAY_MS = 24 * 60 * 60 * 1000;

// The ONE legitimate absolute-date constant in this file (owner-declared
// campaign kickoff for issues #4298-#4307). Every maturity check derives
// from this + matureAfterDays, never from a second hardcoded date.
export const CAMPAIGN_START = '2026-07-17';

// Widest lookback any PostHog goal queries (evalErrorRate /
// evalCalcDeeplinkInputStart use 30 DAY; the two 14d goals declare
// `windowDays: 14` and are ruled on over their own window).
const POSTHOG_MAX_GOAL_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Pure date/state-machine helpers (exported for unit tests — no I/O, no env).
// ---------------------------------------------------------------------------

/** campaignStart ('YYYY-MM-DD') + matureAfterDays → 'YYYY-MM-DD'. */
export function computeMatureAt(campaignStart, matureAfterDays) {
  const start = new Date(`${campaignStart}T00:00:00Z`);
  return new Date(start.getTime() + matureAfterDays * DAY_MS).toISOString().slice(0, 10);
}

/** True once `now` reaches (UTC midnight of) matureAt. */
export function isMature(matureAt, now) {
  return now.getTime() >= new Date(`${matureAt}T00:00:00Z`).getTime();
}

/**
 * Decide what to do with a goal this run.
 * @returns {'skip-passed'|'observing'|'evaluate'}
 */
export function decideGoalAction({ matureAt, now, priorState }) {
  if (priorState === 'passed') return 'skip-passed';
  return isMature(matureAt, now) ? 'evaluate' : 'observing';
}

// ---------------------------------------------------------------------------
// PostHog goals (#4298, #4304 x2, #4307) — HogQL via scripts/lib/posthog-client.mjs
// ---------------------------------------------------------------------------

async function hogqlRow(query) {
  const res = await runHogQL(query);
  const row = res?.results?.[0];
  if (!row) throw new Error('PostHog query returned no rows');
  return row;
}

function fmtPct(n) {
  return n === null || n === undefined || Number.isNaN(n) ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

function fmtNum(n) {
  return n === null || n === undefined || Number.isNaN(n) ? 'n/a' : (Math.round(n * 100) / 100).toString();
}

// #4298 — funnel: job_alert_cta_shown → job_alert_created, 14d, target >= 5%.
async function evalAlertFunnelConversion() {
  const [created, shown] = await hogqlRow(`
    SELECT
      countIf(event = 'job_alert_created') AS created,
      countIf(event = 'job_alert_cta_shown') AS shown
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY
  `);
  const shownN = Number(shown) || 0;
  const createdN = Number(created) || 0;
  const rate = shownN > 0 ? createdN / shownN : null;
  return {
    passed: rate !== null && rate >= 0.05,
    value: { rate, created: createdN, shown: shownN },
    targetDescription: '>= 5% (job_alert_created / job_alert_cta_shown, 14gg)',
    detail: `${createdN}/${shownN} = ${fmtPct(rate)}`,
  };
}

// #4304 — PostHog's native $dead_click, 14d, target < 5,991 (baseline 25,675
// at 30d, -50% target reproportioned to the 14d maturation window: 25675 *
// 14/30 * 0.5 ≈ 5,991). Note: a separate custom `dead_click` event also
// exists (2,746/30d per #4304) but the issue's declared target tracks the
// native $dead_click count specifically.
async function evalDeadClicksReduction() {
  const [deadClicks] = await hogqlRow(`
    SELECT count() AS dead_clicks
    FROM events
    WHERE event = '$dead_click'
      AND timestamp >= now() - INTERVAL 14 DAY
  `);
  const n = Number(deadClicks) || 0;
  const TARGET = 5991;
  return {
    passed: n < TARGET,
    value: { deadClicks: n },
    targetDescription: `< ${TARGET} $dead_click events (14gg, -50% su baseline riproporzionata da 25.675/30gg)`,
    detail: `${n} $dead_click (14gg)`,
  };
}

// #4304 — error rate, 30d, target < 1%. Counts persons touched by
// app_error/exception/$exception over persons touched by $pageview. Neither
// app_error nor exception/$exception carries an ad_blocker property (only
// the separate resource_load_error event does — services/analytics.ts), so
// this cannot be ad-blocker-filtered in HogQL; the measured rate may include
// some ad-blocker-triggered noise. Tolerance is accepted per the goal's own
// spec rather than blocking the check on an unavailable dimension.
async function evalErrorRate() {
  const [errorPersons, pageviewPersons] = await hogqlRow(`
    SELECT
      uniqIf(person_id, event IN ('app_error', 'exception', '$exception')) AS error_persons,
      uniqIf(person_id, event = '$pageview') AS pageview_persons
    FROM events
    WHERE timestamp >= now() - INTERVAL 30 DAY
  `);
  const pv = Number(pageviewPersons) || 0;
  const ep = Number(errorPersons) || 0;
  const rate = pv > 0 ? ep / pv : null;
  if (rate === null) {
    // 0 pageview-person su 30gg = blip/risposta vuota PostHog, non un sito
    // senza traffico: unmeasurable, niente FAILED spurio (review PR #4362).
    return {
      passed: false,
      unmeasurable: true,
      value: { rate: null, errorPersons: ep, pageviewPersons: pv },
      targetDescription: '< 1% (persone con errori / persone con $pageview, 30gg)',
      detail: 'risposta PostHog vuota (0 pageview persons) — riprovo al prossimo run',
    };
  }
  return {
    passed: rate < 0.01,
    value: { rate, errorPersons: ep, pageviewPersons: pv },
    targetDescription: '< 1% (persone con app_error|exception|$exception / persone con $pageview, 30gg)',
    detail: `${ep}/${pv} = ${fmtPct(rate)} (nota: nessuno dei 3 event type porta il tag ad_blocker, solo resource_load_error — tolleranza rumore ad-blocker non filtrabile accettata)`,
  };
}

// #4307 — calculator_deep_link_arrival sessions that also fire input_change
// or simulation_complete in the same $session_id, 30d, target >= 25%.
async function evalCalcDeeplinkInputStart() {
  const [arrivals, converted] = await hogqlRow(`
    SELECT
      uniq($session_id) AS arrivals,
      uniqIf($session_id, $session_id IN (
        SELECT DISTINCT $session_id FROM events
        WHERE event IN ('input_change', 'simulation_complete')
          AND timestamp >= now() - INTERVAL 30 DAY
      )) AS converted
    FROM events
    WHERE event = 'calculator_deep_link_arrival'
      AND timestamp >= now() - INTERVAL 30 DAY
  `);
  const a = Number(arrivals) || 0;
  const c = Number(converted) || 0;
  const rate = a > 0 ? c / a : null;
  return {
    passed: rate !== null && rate >= 0.25,
    value: { rate, arrivals: a, converted: c },
    targetDescription: '>= 25% (sessioni calculator_deep_link_arrival con input_change|simulation_complete stessa sessione, 30gg)',
    detail: `${c}/${a} = ${fmtPct(rate)}`,
  };
}

// ---------------------------------------------------------------------------
// Google auth — GSC (OAuth2 refresh token, SA fallback) and GA4 share one
// cached token per run (both goals sets only need read-only scopes).
// ---------------------------------------------------------------------------

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GSC_SITE = 'sc-domain:frontaliereticino.ch';

let googleTokenPromise = null;

async function getGoogleAccessToken() {
  if (googleTokenPromise) return googleTokenPromise;
  googleTokenPromise = (async () => {
    const id = process.env.GSC_CLIENT_ID;
    const secret = process.env.GSC_CLIENT_SECRET;
    const refresh = process.env.GSC_REFRESH_TOKEN;
    if (id && secret && refresh) {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: id,
          client_secret: secret,
          refresh_token: refresh,
          grant_type: 'refresh_token',
        }),
      });
      if (r.ok) return (await r.json()).access_token;
      console.warn(`[campaign-goal-check] GSC OAuth refresh failed (${r.status}); falling back to service account`);
    }
    const sa = await getServiceAccountToken([GSC_SCOPE, GA4_SCOPE]);
    if (sa) return sa;
    throw new Error('No Google credentials (GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN or GOOGLE_APPLICATION_CREDENTIALS)');
  })();
  return googleTokenPromise;
}

// ---------------------------------------------------------------------------
// GSC goals (#4303, #4306) — searchAnalytics.query, dataState:'all', 3d lag.
// ---------------------------------------------------------------------------

function gscWindow(days, lagDays = 3) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - lagDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function gscSearchAnalytics(token, body) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function gscPageFamilyPosition(token, pathContains, windowDays = 30) {
  const { startDate, endDate } = gscWindow(windowDays);
  const data = await gscSearchAnalytics(token, {
    startDate,
    endDate,
    dimensions: ['page'],
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: pathContains }] }],
    dataState: 'all',
    rowLimit: 25000,
  });
  const rows = (data.rows || []).map((r) => ({
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr ?? null,
    position: r.position ?? null,
  }));
  // minImpressions:0 — include the whole family in the weighted average,
  // matching the issue's baseline methodology (no per-page impression floor).
  return aggregateFamilyRows(rows, { minImpressions: 0 });
}

// #4303 — canton hub weighted-avg position, 30d (3d lag): svizzera hub < 20
// AND zurigo hub < 14.
async function evalCantonHubPositions() {
  const token = await getGoogleAccessToken();
  const [svizzera, zurigo] = await Promise.all([
    gscPageFamilyPosition(token, '/cerca-lavoro-svizzera/'),
    gscPageFamilyPosition(token, '/cerca-lavoro-zurigo/'),
  ]);
  const svPos = svizzera.avgPosition;
  const zhPos = zurigo.avgPosition;
  // Risposta GSC vuota (blip transiente, non errore HTTP): unmeasurable,
  // mai un FAILED spurio con issue (review PR #4362).
  if (svPos === null || zhPos === null) {
    return {
      passed: false,
      unmeasurable: true,
      value: { svizzeraPosition: svPos, zurigoPosition: zhPos },
      targetDescription: 'svizzera < 20 E zurigo < 14 (weighted-avg position, 30gg, lag 3gg)',
      detail: 'risposta GSC vuota per una o entrambe le famiglie — riprovo al prossimo run',
    };
  }
  const passed = svPos < 20 && zhPos < 14;
  return {
    passed,
    value: {
      svizzeraPosition: svPos, svizzeraPages: svizzera.pageCount,
      zurigoPosition: zhPos, zurigoPages: zurigo.pageCount,
    },
    targetDescription: 'svizzera < 20 E zurigo < 14 (weighted-avg position, 30gg, lag 3gg)',
    detail: `svizzera=${fmtNum(svPos)} (${svizzera.pageCount}pg) zurigo=${fmtNum(zhPos)} (${zurigo.pageCount}pg)`,
  };
}

const BRAND_QUERY_TERMS = ['interdiscount', 'fielmann', 'fust', 'jysk', 'coop'];
const BRAND_QUERY_REGEX = `(?i)${BRAND_QUERY_TERMS.join('|')}`;
const BRAND_QUERY_REGEX_JS = new RegExp(BRAND_QUERY_TERMS.join('|'), 'i');

// #4306 — aggregate CTR across brand-name queries, 30d (3d lag), target > 2%.
async function evalBrandQueryCtr() {
  const token = await getGoogleAccessToken();
  const { startDate, endDate } = gscWindow(30);
  let rows;
  try {
    const data = await gscSearchAnalytics(token, {
      startDate,
      endDate,
      dimensions: ['query'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: BRAND_QUERY_REGEX }] }],
      dataState: 'all',
      rowLimit: 5000,
    });
    rows = data.rows || [];
  } catch (e) {
    console.warn(`[campaign-goal-check] brand_query_ctr: includingRegex fallita (${e.message}), fallback client-side su top query`);
    const data = await gscSearchAnalytics(token, {
      startDate, endDate, dimensions: ['query'], dataState: 'all', rowLimit: 25000,
    });
    rows = (data.rows || []).filter((r) => BRAND_QUERY_REGEX_JS.test(r.keys?.[0] || ''));
  }
  const totalClicks = rows.reduce((s, r) => s + (r.clicks || 0), 0);
  const totalImpressions = rows.reduce((s, r) => s + (r.impressions || 0), 0);
  const ctr = totalImpressions > 0 ? computeCtr(totalClicks, totalImpressions) : null;
  return {
    passed: ctr !== null && ctr > 0.02,
    value: { ctr, totalClicks, totalImpressions, matchedQueries: rows.length },
    targetDescription: '> 2% CTR aggregato su query brand interdiscount|fielmann|fust|jysk|coop (30gg, lag 3gg)',
    detail: `${totalClicks}/${totalImpressions} = ${fmtPct(ctr)} su ${rows.length} query`,
  };
}

// ---------------------------------------------------------------------------
// GA4 goals (#4299, #4305) — analyticsdata:runReport, built-in channel groups.
// ---------------------------------------------------------------------------

async function ga4SessionsByChannelGroup(token, channelGroupExact, windowDays) {
  const propertyId = process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  // Lag di 2gg: GA4 può non aver processato le ultime 24-48h — senza lag il
  // cron domenicale sottoconta la coda della finestra e può produrre un
  // falso "failing" a ridosso della soglia (review PR #4362; specchia il
  // lag 3gg lato GSC in gscWindow()).
  const GA4_LAG_DAYS = 2;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - GA4_LAG_DAYS);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: fmt(start), endDate: fmt(end) }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { value: channelGroupExact, matchType: 'EXACT' },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.rows || []).reduce((sum, r) => sum + Number(r.metricValues?.[0]?.value || 0), 0);
}

// #4299 — sessions via GA4's built-in "Email" channel group, 90d, target >= 7,350.
async function evalEmailSessions() {
  const token = await getGoogleAccessToken();
  const sessions = await ga4SessionsByChannelGroup(token, 'Email', 90);
  const TARGET = 7350;
  return {
    passed: sessions >= TARGET,
    value: { sessions },
    targetDescription: `>= ${TARGET} sessioni canale Email (90gg, 3x baseline 2.449)`,
    detail: `${sessions} sessioni`,
  };
}

// #4305 — sessions via GA4's built-in "AI Assistant" channel group, 90d,
// target >= 4,839. GA4 classifies this channel from its own referrer rules
// (sessionDefaultChannelGroup) — there is no custom AI-hostname allowlist in
// this codebase to extract/reuse (confirmed: only check-ai-visibility.mjs
// references AI hostnames, for an unrelated Perplexity API call).
async function evalAiSessions() {
  const token = await getGoogleAccessToken();
  const sessions = await ga4SessionsByChannelGroup(token, 'AI Assistant', 90);
  const TARGET = 4839;
  return {
    passed: sessions >= TARGET,
    value: { sessions },
    targetDescription: `>= ${TARGET} sessioni canale AI Assistant (90gg, 3x baseline 1.613)`,
    detail: `${sessions} sessioni`,
  };
}

// ---------------------------------------------------------------------------
// Bing goal (#4305) — GetRankAndTrafficStats via scripts/lib/bing-webmaster.mjs.
// ---------------------------------------------------------------------------

const BING_SITE_URL = 'https://frontaliereticino.ch'; // matches scripts/check-bing-status.mjs convention

// #4305 — organic clicks over the trailing 90d, target >= 500 (baseline 48).
// getBingRankAndTrafficStats returns null on any failure (bad key, endpoint
// not available on this plan, network) — treated as unmeasurable rather than
// failed, since a null response can't be distinguished from "not supported
// here" without a documented error payload.
async function evalBingClicks() {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) throw new Error('BING_API_KEY missing');
  const stats = await getBingRankAndTrafficStats(apiKey, BING_SITE_URL);
  if (!stats) {
    return {
      unmeasurable: true,
      note: 'GetRankAndTrafficStats non ha risposto (endpoint non disponibile su questo piano/key, o errore — vedi log run per il codice HTTP).',
    };
  }
  const cutoff = Date.now() - 90 * DAY_MS;
  const inWindow = stats.filter((s) => s.date && Date.parse(s.date) >= cutoff);
  const clicks = inWindow.reduce((sum, s) => sum + (s.clicks || 0), 0);
  const TARGET = 500;
  return {
    passed: clicks >= TARGET,
    value: { clicks, daysReturned: inWindow.length },
    targetDescription: `>= ${TARGET} click organici Bing (90gg, baseline 48)`,
    detail: `${clicks} click su ${inWindow.length} giorni restituiti`,
  };
}

// ---------------------------------------------------------------------------
// Goal registry
// ---------------------------------------------------------------------------

export const GOALS = [
  { id: 'alert_funnel_conversion', title: 'Alert funnel conversion (shown→created)', source: 'posthog', windowDays: 14, matureAfterDays: 14, issueRef: '#4298', evaluate: evalAlertFunnelConversion },
  { id: 'dead_clicks_reduction', title: 'Dead click $dead_click -50% (14gg)', source: 'posthog', windowDays: 14, matureAfterDays: 14, issueRef: '#4304', evaluate: evalDeadClicksReduction },
  { id: 'error_rate', title: 'Error rate < 1% (30gg)', source: 'posthog', windowDays: 30, matureAfterDays: 30, issueRef: '#4304', evaluate: evalErrorRate },
  { id: 'calc_deeplink_input_start', title: 'Calcolatore deep-link → input start >= 25%', source: 'posthog', windowDays: 30, matureAfterDays: 30, issueRef: '#4307', evaluate: evalCalcDeeplinkInputStart },
  { id: 'canton_hub_positions', title: 'Hub cantonali: svizzera<20 E zurigo<14', source: 'gsc', matureAfterDays: 30, issueRef: '#4303', evaluate: evalCantonHubPositions },
  { id: 'brand_query_ctr', title: 'CTR query brand > 2%', source: 'gsc', matureAfterDays: 30, issueRef: '#4306', evaluate: evalBrandQueryCtr },
  { id: 'email_sessions', title: 'Sessioni canale Email >= 7.350 (90gg)', source: 'ga4', matureAfterDays: 90, issueRef: '#4299', evaluate: evalEmailSessions },
  { id: 'ai_sessions', title: 'Sessioni canale AI Assistant >= 4.839 (90gg)', source: 'ga4', matureAfterDays: 90, issueRef: '#4305', evaluate: evalAiSessions },
  { id: 'bing_clicks', title: 'Click Bing >= 500 (90gg)', source: 'bing', matureAfterDays: 90, issueRef: '#4305', evaluate: evalBingClicks },
];

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

function loadState(path) {
  if (!existsSync(path)) return { goals: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.goals ? parsed : { goals: {} };
  } catch {
    return { goals: {} };
  }
}

function buildIssueBody({ goal, outcome, matureAt }) {
  return [
    `## Campaign goal FAILED — ${goal.title}`,
    '',
    `**Goal id:** \`${goal.id}\``,
    `**Source:** ${goal.source}`,
    `**Target:** ${outcome.targetDescription}`,
    `**Valore misurato:** ${outcome.detail}`,
    `**Matura da:** ${matureAt} (matureAfterDays=${goal.matureAfterDays} da CAMPAIGN_START=${CAMPAIGN_START})`,
    `**Issue campagna:** ${goal.issueRef}`,
    '',
    '_Fonte: scripts/campaign-goal-check.mjs, cron settimanale .github/workflows/campaign-goal-check.yml. Rivalutato ogni run finché non supera il target._',
  ].join('\n');
}

async function defaultCreateIssue({ title, description }) {
  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  return createGithubIssue({
    title,
    description,
    priority: 3,
    labels: ['seo', 'campaign-goal'],
    workflow: 'Campaign Goal Check',
  });
}

// ---------------------------------------------------------------------------
// Orchestration — injectable for tests (goals/now/state I/O/issue creator).
// ---------------------------------------------------------------------------

export async function runCampaignGoalCheck({
  goals = GOALS,
  now = new Date(),
  campaignStart = CAMPAIGN_START,
  stateFilePath = STATE_PATH,
  loadStateImpl = loadState,
  saveStateImpl = (path, state) => writeJsonAtomic(path, state),
  createIssueImpl = defaultCreateIssue,
  checkLivenessImpl = checkPostHogLiveness,
  dryRun = false,
} = {}) {
  const state = loadStateImpl(stateFilePath);
  state.goals = state.goals || {};
  const results = [];
  const sourceStats = new Map(); // source -> {attempted, errored}

  // Vitality guard (scripts/lib/source-liveness.mjs), probed lazily so a run
  // where no PostHog goal is mature never pays for the query.
  //
  // Only evalErrorRate had a zero-events guard; evalAlertFunnelConversion and
  // evalCalcDeeplinkInputStart turned "0 events" into rate=null → passed:false
  // → a "Campaign goal FAILED" issue, and evalDeadClicksReduction read 0 as
  // beating its 5991 target and latched `passed` forever (skip-passed never
  // re-evaluates). During the 2026-07-23 → 08-10 outage all three were reading
  // a dead source. `unmeasurable` is the honest verdict and opens no issue.
  // Probed once at the widest goal window; each goal is then ruled on over
  // its OWN window from the same daily counts, so a hole older than a 14d
  // goal's lookback doesn't make that goal abstain for nothing.
  let posthogProbe;
  // Declared at most once per run per window: four goals sharing one dead
  // source is one outage, not four alarms.
  const declaredWindows = new Set();
  const posthogNotMeasurable = async (goalWindowDays) => {
    if (posthogProbe === undefined) {
      posthogProbe = await checkLivenessImpl({ windowDays: POSTHOG_MAX_GOAL_WINDOW_DAYS, now });
    }
    const declareOnce = (verdict) => {
      if (!declaredWindows.has(verdict.windowDays)) {
        declaredWindows.add(verdict.windowDays);
        declareNotMeasurable('campaign-goal-check', verdict);
      }
      return verdict;
    };
    if (posthogProbe.credentialsMissing || posthogProbe.probeFailed) return declareOnce(posthogProbe);
    // Per-window re-ruling needs the daily counts. Without them (an injected
    // probe in a test, or a future source that reports only a verdict) the
    // probe's own answer stands — re-deriving from an empty map would read
    // "no data" as "dead" and abstain on a healthy source.
    if (!(posthogProbe.dailyCounts instanceof Map) || posthogProbe.dailyCounts.size === 0) {
      return posthogProbe.alive ? null : declareOnce(posthogProbe);
    }
    const verdict = evaluateLiveness({
      dailyCounts: posthogProbe.dailyCounts,
      windowDays: goalWindowDays ?? POSTHOG_MAX_GOAL_WINDOW_DAYS,
      now,
      source: 'posthog',
    });
    return verdict.alive ? null : declareOnce(verdict);
  };

  for (const goal of goals) {
    const prior = state.goals[goal.id] || {};
    const matureAt = computeMatureAt(campaignStart, goal.matureAfterDays);
    const action = decideGoalAction({ matureAt, now, priorState: prior.state });
    const base = { title: goal.title, source: goal.source, issueRef: goal.issueRef, matureAt };

    if (action === 'skip-passed') {
      results.push({ id: goal.id, state: 'passed', detail: prior.detail || '(già superato, non rivalutato)', matureAt });
      state.goals[goal.id] = { ...prior, ...base, state: 'passed' };
      continue;
    }

    if (action === 'observing') {
      state.goals[goal.id] = { ...prior, ...base, state: 'observing' };
      results.push({ id: goal.id, state: 'observing', detail: `matura il ${matureAt}`, matureAt });
      continue;
    }

    // action === 'evaluate'
    if (goal.source === 'posthog') {
      const dead = await posthogNotMeasurable(goal.windowDays);
      if (dead) {
        const note = `sorgente non misurabile: ${dead.reason}`;
        state.goals[goal.id] = { ...prior, ...base, state: 'unmeasurable', lastCheckAt: now.toISOString(), note };
        results.push({ id: goal.id, state: 'unmeasurable', detail: note, matureAt });
        continue;
      }
    }

    const stat = sourceStats.get(goal.source) || { attempted: 0, errored: 0 };
    stat.attempted += 1;
    sourceStats.set(goal.source, stat);

    try {
      const outcome = await goal.evaluate();

      if (outcome.unmeasurable) {
        state.goals[goal.id] = { ...prior, ...base, state: 'unmeasurable', lastCheckAt: now.toISOString(), note: outcome.note };
        results.push({ id: goal.id, state: 'unmeasurable', detail: outcome.note, matureAt });
        continue;
      }

      if (outcome.passed) {
        state.goals[goal.id] = {
          ...prior, ...base, state: 'passed', lastValue: outcome.value, detail: outcome.detail,
          targetDescription: outcome.targetDescription, lastCheckAt: now.toISOString(), passedAt: now.toISOString(),
        };
        results.push({ id: goal.id, state: 'passed', detail: outcome.detail, matureAt });
        continue;
      }

      state.goals[goal.id] = {
        ...prior, ...base, state: 'failing', lastValue: outcome.value, detail: outcome.detail,
        targetDescription: outcome.targetDescription, lastCheckAt: now.toISOString(),
      };
      results.push({ id: goal.id, state: 'failing', detail: outcome.detail, matureAt });
      if (!dryRun) {
        await createIssueImpl({
          title: `Campaign goal FAILED: ${goal.id}`,
          description: buildIssueBody({ goal, outcome, matureAt }),
        });
      }
    } catch (e) {
      stat.errored += 1;
      console.error(`[campaign-goal-check] ${goal.id} (${goal.source}) query failed: ${e.message}`);
      state.goals[goal.id] = { ...prior, ...base, state: 'error', lastCheckAt: now.toISOString(), lastError: e.message };
      results.push({ id: goal.id, state: 'error', detail: e.message, matureAt });
    }
  }

  state.generatedAt = now.toISOString();
  state.campaignStart = campaignStart;
  if (!dryRun) saveStateImpl(stateFilePath, state);

  const deadSources = [...sourceStats.entries()]
    .filter(([, s]) => s.attempted > 0 && s.errored === s.attempted)
    .map(([source]) => source);

  return { results, state, deadSources };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const STATE_ICON = { observing: '⏳', passed: '✅', failing: '❌', error: '⚠️', unmeasurable: '❔' };

function printTable(results) {
  console.log('\nCampaign goal status\n');
  for (const r of results) {
    const icon = STATE_ICON[r.state] || '·';
    console.log(`${icon} ${r.id.padEnd(28)} ${r.state.padEnd(12)} matura ${r.matureAt}  ${r.detail}`);
  }
  console.log('');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { results, deadSources } = await runCampaignGoalCheck({ dryRun });
  printTable(results);
  if (deadSources.length > 0) {
    console.error(`[campaign-goal-check] FATAL: tutte le query sono fallite per source: ${deadSources.join(', ')} — auth/host probabilmente rotto`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`[campaign-goal-check] fatal: ${e.message}`);
    process.exitCode = 1;
  });
}
