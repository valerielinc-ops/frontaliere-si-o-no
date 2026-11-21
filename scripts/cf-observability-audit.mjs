#!/usr/bin/env node
/**
 * Weekly audit of the locale-router's Workers Logs.
 *
 * The other Cloudflare monitors read Analytics (status counts). This one reads
 * the logs themselves, the only source that says WHO generates the volume: the
 * ten findings of the 2026-10-30 audit became the ten checks below. Each failing
 * check opens one backlog issue with a stable title; a green run closes it.
 *
 * Counts come back from a sampled log store. Absolute thresholds are compared
 * after dividing by `head_sampling_rate`, while shares need no correction.
 */
import { createGithubIssue, resolveGithubIssue } from './lib/github-issue-creator.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';

export const WORKER_NAME = 'frontaliere-locale-router';
export const ISSUE_TITLE_PREFIX = 'Cloudflare observability: ';
export const SAMPLING_CUTOVER = '2026-12-01';
export const WINDOW_DAYS = 7;
// The receipt needs one rate-bearing settings mutation before its seven-day
// window to establish the state at the left boundary. Locale-router deploys
// normally provide several such records; without one the receipt fails closed.
export const SAMPLING_HISTORY_LOOKBACK_DAYS = 30;
// First full window after the fixes of 2026-10-30 are live. Earlier runs only
// print: the window still holds the old traffic, and each issue would start an
// autonomous fix for a problem already solved.
export const FIRST_BACKLOG_RUN = '2026-11-09';
export const DRY_RUN_COMMAND =
  'node scripts/cf-observability-audit.mjs --dry-run';

// Cloudflare Observability paid allowances, per billing cycle.
const INCLUDED_INGEST_GB = 50;
const INCLUDED_STORAGE_GB_MONTH = 10;
const RETENTION_DAYS = 7;

const INTERNAL_CRAWLER_UA = 'frontaliere-bing-tree-crawler';
export const WAF_BLOCKED_UAS = ['Baiduspider', 'CorsairBot', 'Chrome/48.0.2564.116', 'Chrome/99.0.4844.51'];
// The WAF rule scopes the legacy Chrome signatures to Chinese source IPs. A
// Workers Log is an invocation that made it past the WAF, so counting those UAs
// without the same country predicate falsely reports legitimate old browsers
// outside China as a firewall leak.
const WAF_BLOCKED_UA_COUNTRY = new Map([
  ['Chrome/48.0.2564.116', 'CN'],
  ['Chrome/99.0.4844.51', 'CN'],
]);
const VERSION_PATHS = ['/commit-hash.txt', '/build-id.txt'];
const AUTOMATED_UA_RE = /bot|crawl|spider|python|curl|wget|scrapy|go-http|axios|java\//i;
const WELCOMED_UA_RE =
  /googlebot|bingbot|applebot|gptbot|oai-searchbot|chatgpt|claudebot|claude-user|perplexity|duckduck|yandex|exasearchbot|reflectionbot|shapbot|frontaliere/i;

const USER_AGENT = '$workers.event.request.headers.user-agent';
const REQUEST_COUNTRY = '$workers.event.request.cf.country';
const EVENT_TYPE = '$metadata.type';
const LOG_MESSAGE = '$metadata.message';
const ORIGIN_FAILURE_MESSAGE_TOKEN = '"event":"origin_failure"';
const JOB_CANON_V2_SUCCESS_MESSAGE_TOKEN = '"event":"job_canon_v2_success"';
const JOB_CANON_V1_FALLBACK_MESSAGE_TOKEN = '"event":"job_canon_v1_fallback"';
const filter = (key, operation, value, type = 'string') => ({ key, operation, value, type });

function buildStructuredLogFilters(messageToken) {
  return [
    filter(EVENT_TYPE, 'eq', 'cf-worker-log'),
    filter(LOG_MESSAGE, 'includes', messageToken),
  ];
}

export function buildBlockedUaFilters(ua) {
  const filters = [filter(USER_AGENT, 'includes', ua)];
  const country = WAF_BLOCKED_UA_COUNTRY.get(ua);
  if (country) filters.push(filter(REQUEST_COUNTRY, 'eq', country));
  return filters;
}

export function buildOriginFailureLogFilters() {
  return buildStructuredLogFilters(ORIGIN_FAILURE_MESSAGE_TOKEN);
}

export function buildJobCanonV2SuccessLogFilters() {
  return buildStructuredLogFilters(JOB_CANON_V2_SUCCESS_MESSAGE_TOKEN);
}

export function buildJobCanonV1FallbackLogFilters() {
  return buildStructuredLogFilters(JOB_CANON_V1_FALLBACK_MESSAGE_TOKEN);
}

export function isOriginFailureLogEvent(event) {
  return event?.$metadata?.type === 'cf-worker-log'
    && typeof event.$metadata.message === 'string'
    && event.$metadata.message.includes(ORIGIN_FAILURE_MESSAGE_TOKEN);
}

const share = (part, total) => (total > 0 ? part / total : 0);
const pct = (value) => `${(value * 100).toFixed(1)}%`;

export function estimateMonthlyLogVolume({ events, avgEventBytes }) {
  const ingestGb = (events * avgEventBytes * (30 / WINDOW_DAYS)) / 1e9;
  return { ingestGb, storageGbMonth: (ingestGb / 30) * RETENTION_DAYS };
}

export function evaluateJobCanonV1Retirement(snapshot) {
  const observedDays = [...new Set(snapshot.jobCanonV2SuccessDays ?? [])].sort();
  const queryWindowDays = Number.isFinite(snapshot.queryWindowDays) ? snapshot.queryWindowDays : 0;
  const windowComplete = queryWindowDays >= WINDOW_DAYS && observedDays.length >= WINDOW_DAYS;
  const samplingHistoryBlockers = Array.isArray(snapshot.samplingHistory?.blockers)
    ? snapshot.samplingHistory.blockers
    : ['history:unavailable'];
  const samplingHistoryComplete = snapshot.samplingHistory?.complete === true
    && samplingHistoryBlockers.length === 0;
  const v2SampleIntervals = snapshot.jobCanonV2SampleIntervals ?? [];
  const v1SampleIntervals = snapshot.jobCanonV1SampleIntervals ?? [];
  const telemetrySamplingComplete = v2SampleIntervals.length === observedDays.length
    && v2SampleIntervals.length >= WINDOW_DAYS
    && [...v2SampleIntervals, ...v1SampleIntervals]
      .every((interval) => interval === 1);
  const v2SuccessLogs = Number.isFinite(snapshot.jobCanonV2SuccessLogs)
    ? snapshot.jobCanonV2SuccessLogs
    : 0;
  const v1FallbackLogs = Number.isFinite(snapshot.jobCanonV1FallbackLogs)
    ? snapshot.jobCanonV1FallbackLogs
    : 0;
  const blockers = [];
  if (!windowComplete) blockers.push(`v2-days:${observedDays.length}/${WINDOW_DAYS}`);
  if (snapshot.samplingRate !== 1) blockers.push(`sampling-current:${snapshot.samplingRate ?? 'unknown'}`);
  for (const blocker of samplingHistoryBlockers) blockers.push(`sampling-${blocker}`);
  if (!samplingHistoryComplete && samplingHistoryBlockers.length === 0) {
    blockers.push('sampling-history:incomplete');
  }
  if (!telemetrySamplingComplete) {
    const intervals = [...v2SampleIntervals, ...v1SampleIntervals];
    blockers.push(`sampling-telemetry:${intervals.length
      ? intervals.map((interval) => interval ?? 'unknown').join(',')
      : 'missing'}`);
  }
  if (v2SuccessLogs === 0) blockers.push('v2-success:0');
  if (v1FallbackLogs !== 0) blockers.push(`v1-fallback:${v1FallbackLogs}`);

  return {
    schemaVersion: 2,
    windowDays: WINDOW_DAYS,
    queryWindowDays,
    observedV2Days: observedDays.length,
    firstV2Day: observedDays[0] ?? null,
    lastV2Day: observedDays.at(-1) ?? null,
    v2SuccessLogs,
    v1FallbackLogs,
    samplingRate: snapshot.samplingRate ?? null,
    v2SampleIntervals,
    v1SampleIntervals,
    samplingHistory: snapshot.samplingHistory ?? null,
    ready: blockers.length === 0,
    blockers,
  };
}

/**
 * The ten checks. Pure: `s` is the snapshot built by collectSnapshot.
 * Returns only the failing ids' findings plus the list of all ids.
 */
export function evaluateChecks(s, now = new Date()) {
  const samplingKnown = Number.isFinite(s.samplingRate) && s.samplingRate > 0;
  const scale = samplingKnown ? 1 / s.samplingRate : 1;
  const volume = estimateMonthlyLogVolume({ events: s.total, avgEventBytes: s.avgEventBytes });
  const blocked = Object.values(s.blockedRequests).reduce((sum, n) => sum + n, 0);
  const unknownBots = s.topUserAgents.filter(
    ({ ua, count }) => AUTOMATED_UA_RE.test(ua) && !WELCOMED_UA_RE.test(ua) && share(count, s.total) > 0.05,
  );
  const checks = [
    {
      id: '5xx-burst',
      title: 'burst di 503 sul router',
      failed: s.max503PerBucket * scale >= 500,
      value: `${Math.round(s.max503PerBucket * scale)} 503 in un bucket (totale ${Math.round(s.count503 * scale)})`,
      target: 'meno di 500 per bucket',
      fix: 'Leggere le righe `origin_failure` del periodo per causa e path, poi correggere l\'origine o estendere lo stale-if-error.',
    },
    {
      id: 'origin-failure-cause',
      title: 'segnale origin_failure assente durante i 503',
      failed: s.count503 * scale >= 50 && s.originFailureLogs === 0,
      value: `${s.count503} eventi di invocazione 503 e ${s.originFailureLogs} eventi log origin_failure strutturati (aggregati separati)`,
      target: 'con 503 nel periodo, almeno un log origin_failure strutturato; nessuna pretesa di copertura 1:1 senza join per invocazione',
      fix: 'Verificare che i percorsi di errore chiamino `logEdgeFailure` e classificare separatamente gli eventi `cf-worker-log`.',
    },
    {
      id: 'internal-crawler-share',
      title: 'crawler interno oltre il 25% del traffico',
      failed: share(s.internalCrawlerRequests, s.total) > 0.25,
      value: pct(share(s.internalCrawlerRequests, s.total)),
      target: 'massimo 25%',
      fix: 'Controllare la cadenza settimanale del tree crawl in bing-seo-loop.yml.',
    },
    {
      id: '404-share',
      title: '404 oltre il 5% delle richieste',
      failed: share(s.count404, s.total) > 0.05,
      value: pct(share(s.count404, s.total)),
      target: 'massimo 5%',
      fix: 'Raggruppare i path 404 per famiglia e ricreare le pagine di ricerca o correggere i link che li generano.',
    },
    {
      id: 'version-files-share',
      title: 'file di versione oltre il 3% delle richieste',
      failed: share(s.versionRequests, s.total) > 0.03,
      value: pct(share(s.versionRequests, s.total)),
      target: 'massimo 3%',
      fix: 'Controllare chi chiama /commit-hash.txt e /build-id.txt: il client deve farlo solo con il badge visibile.',
    },
    {
      id: 'blocked-bot-leak',
      title: 'bot bloccati ancora serviti dal Worker',
      failed: blocked * scale >= 1000,
      value: JSON.stringify(s.blockedRequests),
      target: 'meno di 1000 a settimana',
      fix: 'Verificare la regola locale-bot-throttle in scripts/cf-locale-failover-setup.mjs e la sua applicazione alla zona.',
    },
    {
      id: 'unknown-bot-share',
      title: 'bot sconosciuto oltre il 5% del traffico',
      failed: unknownBots.length > 0,
      value: unknownBots.map(({ ua, count }) => `${ua.slice(0, 80)}: ${pct(share(count, s.total))}`).join('; ') || 'nessuno',
      target: 'nessun bot non governato sopra il 5%',
      fix: 'Decidere se accoglierlo in WELCOMED_UA_RE o bloccarlo in BLOCKED_CRAWLER_UAS.',
    },
    {
      id: 'googlebot-301-share',
      title: 'Googlebot spreca oltre il 10% del crawl in 301',
      // Baseline 8%, measured 2026-10-30: job URLs under a former canton that Google
      // re-checks. Only 15 of 11,355 were still in the sitemaps, so it decays alone.
      failed: share(s.googlebot301, s.googlebotTotal) > 0.1,
      value: pct(share(s.googlebot301, s.googlebotTotal)),
      target: 'massimo 10%',
      fix: 'Raggruppare i path 301 di Googlebot e aggiornare sitemap o link interni alla destinazione finale.',
    },
    {
      id: 'log-privacy-settings',
      title: 'query string non oscurate nei log',
      failed: s.redactQueryString !== true,
      value: `redact_query_string=${s.redactQueryString}`,
      target: 'redact_query_string=true',
      fix: 'Rieseguire scripts/cf-worker-observability-settings.mjs e verificare il passo in deploy-worker.yml.',
    },
    {
      id: 'log-budget',
      title: 'volume log oltre l\'allowance Cloudflare',
      // Volume is free before the cutover, and the owner keeps 100% sampling until
      // then: an earlier issue would invite an autonomous fix to lower it too soon.
      failed:
        now.toISOString().slice(0, 10) >= SAMPLING_CUTOVER &&
        (!samplingKnown ||
          volume.ingestGb > INCLUDED_INGEST_GB ||
          volume.storageGbMonth > INCLUDED_STORAGE_GB_MONTH ||
          s.samplingRate > 0.1),
      value: `~${volume.ingestGb.toFixed(0)} GB/mese, ~${volume.storageGbMonth.toFixed(1)} GB-mese, sampling ${s.samplingRate ?? 'unknown'}`,
      target: `massimo ${INCLUDED_INGEST_GB} GB e ${INCLUDED_STORAGE_GB_MONTH} GB-mese; sampling massimo 0.1 dal ${SAMPLING_CUTOVER}`,
      fix: 'Controllare la PR del cutover del sampling, poi ridurre il traffico che genera eventi prima di abbassare ancora il rate.',
    },
  ];
  return checks;
}

export function issueTitle(check) {
  return `${ISSUE_TITLE_PREFIX}${check.title}`;
}

export function buildIssueBody(check) {
  return [
    `Rilevato dall'audit settimanale di Workers Logs su \`${WORKER_NAME}\` (ultimi ${WINDOW_DAYS} giorni).`,
    '',
    `- Valore misurato: ${check.value}`,
    `- Obiettivo: ${check.target}`,
    '',
    buildScheda({
      causa: `Il controllo \`${check.id}\` e' fuori soglia: va confermato nei log quale traffico lo genera.`,
      fix: check.fix,
      metrica: `prima=${check.value} atteso=${check.target}`,
      comando: DRY_RUN_COMMAND,
      osservatore: 'cf-observability-audit.yml: ogni settimana rimisura, commenta se resta rossa e chiude la issue quando torna verde.',
      fallimento: issueTitle(check),
    }),
  ].join('\n');
}

async function telemetry(body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/observability/telemetry/query`;
  let lastError = 'no attempt';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (res.ok && json.success !== false) return json.result;
      lastError = `HTTP ${res.status} ${JSON.stringify(json.errors ?? [])}`;
    } catch {
      lastError = `HTTP ${res.status} non-JSON answer`;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
  }
  throw new Error(`telemetry query failed: ${lastError}`);
}

function logSamplingRate(value) {
  const rate = value?.observability?.logs?.head_sampling_rate;
  return Number.isFinite(rate) ? rate : null;
}

function auditMutationKind(entry) {
  const resourceType = entry?.resource?.type ?? '';
  const uri = entry?.raw?.uri?.split('?')[0] ?? '';
  if (resourceType === 'scripts.script-settings' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/script-settings`)) {
    return 'settings';
  }
  if (resourceType === 'scripts.settings' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/settings`)) {
    return 'settings';
  }
  if (resourceType === 'scripts.deployments' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/deployments`)) {
    return 'deployment';
  }
  if (resourceType === 'scripts.versions' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/versions`)) {
    return 'version';
  }
  return null;
}

function auditMutationTime(entry) {
  const timestamp = Date.parse(entry?.action?.time ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function evaluateSamplingHistory(entries, timeframe) {
  const blockers = [];
  const mutations = [];
  for (const entry of entries) {
    const kind = auditMutationKind(entry);
    if (!kind) continue;
    const actionType = entry?.action?.type;
    const method = entry?.raw?.method;
    const isMutation = ['create', 'update', 'delete'].includes(actionType)
      || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!isMutation || entry?.action?.result === 'failure') continue;
    if (entry?.action?.result !== 'success') {
      blockers.push(`${kind}:ambiguous-result`);
      continue;
    }
    const timestamp = auditMutationTime(entry);
    if (timestamp === null) {
      blockers.push(`${kind}:invalid-time`);
      continue;
    }
    const rate = kind === 'settings' ? logSamplingRate(entry.resource?.response) : null;
    mutations.push({ kind, timestamp, rate });
  }

  mutations.sort((a, b) => a.timestamp - b.timestamp);
  const settings = mutations.filter(({ kind }) => kind === 'settings');
  const baseline = settings.filter(({ timestamp }) => timestamp <= timeframe.from).at(-1) ?? null;
  if (!baseline) blockers.push('history:no-baseline');
  else if (baseline.rate !== 1) blockers.push(`history:baseline-rate:${baseline.rate ?? 'unknown'}`);

  const windowSettings = settings.filter(({ timestamp }) => timestamp > timeframe.from && timestamp <= timeframe.to);
  for (const mutation of windowSettings) {
    if (mutation.rate !== 1) blockers.push(`history:rate:${mutation.rate ?? 'unknown'}:${new Date(mutation.timestamp).toISOString()}`);
  }

  const windowDeployments = mutations.filter(
    ({ kind, timestamp }) => kind === 'deployment' && timestamp > timeframe.from && timestamp <= timeframe.to,
  );
  for (const deployment of windowDeployments) {
    const confirmed = windowSettings.some(({ timestamp, rate }) =>
      rate === 1 && timestamp >= deployment.timestamp && timestamp - deployment.timestamp <= 5 * 60e3,
    );
    if (!confirmed) blockers.push(`history:deployment-unconfirmed:${new Date(deployment.timestamp).toISOString()}`);
  }

  return {
    schemaVersion: 1,
    complete: blockers.length === 0,
    queryFrom: new Date(timeframe.auditFrom).toISOString(),
    windowFrom: new Date(timeframe.from).toISOString(),
    windowTo: new Date(timeframe.to).toISOString(),
    baselineAt: baseline ? new Date(baseline.timestamp).toISOString() : null,
    baselineRate: baseline?.rate ?? null,
    settingsMutations: windowSettings.length,
    versionUploads: mutations.filter(
      ({ kind, timestamp }) => kind === 'version' && timestamp > timeframe.from && timestamp <= timeframe.to,
    ).length,
    deployments: windowDeployments.length,
    blockers: [...new Set(blockers)],
  };
}

async function collectSamplingHistory(timeframe) {
  const entries = [];
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({
      since: new Date(timeframe.auditFrom).toISOString(),
      before: new Date(timeframe.to).toISOString(),
      direction: 'asc',
      limit: '1000',
      resource_id: WORKER_NAME,
      resource_product: 'workers',
    });
    if (cursor) params.set('cursor', cursor);
    // Audit Logs v2 carries the request/response of script-settings mutations.
    // The resource filters keep pagination bounded without assuming an action
    // name, which Cloudflare may change independently of the endpoint shape.
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/logs/audit?${params}`,
      { headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } },
    );
    const json = await res.json();
    if (!res.ok || json.success === false || !Array.isArray(json.result)) {
      throw new Error(`audit-logs HTTP ${res.status} ${JSON.stringify(json.errors ?? [])}`);
    }
    entries.push(...json.result);
    pages += 1;
    const nextCursor = json.result_info?.cursor ?? null;
    if (!nextCursor) {
      cursor = null;
      continue;
    }
    if (seenCursors.has(nextCursor)) throw new Error('audit-logs pagination returned a repeated cursor');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (pages >= 100) throw new Error('audit-logs pagination exceeded 100 pages');
  } while (cursor);

  const history = evaluateSamplingHistory(entries, timeframe);
  return { ...history, pages, records: entries.length };
}

const STATUS = '$workers.event.response.status';
const PATH = '$workers.event.path';

export async function collectSnapshot(now = Date.now()) {
  const timeframe = {
    auditFrom: now - (WINDOW_DAYS + SAMPLING_HISTORY_LOOKBACK_DAYS) * 864e5,
    from: now - WINDOW_DAYS * 864e5,
    to: now,
  };
  const service = filter('$metadata.service', 'eq', WORKER_NAME);
  let id = 0;
  const query = async (filters, groupBy, limit = 50) => {
    const result = await telemetry({
      queryId: `cf-observability-audit-${++id}`,
      view: 'calculations',
      limit,
      timeframe: { from: timeframe.from, to: timeframe.to },
      parameters: {
        datasets: [],
        filters: [service, ...filters],
        calculations: [{ operator: 'count' }],
        limit,
        groupBys: groupBy ? [{ type: 'string', value: groupBy }] : [],
        ...(groupBy ? { orderBy: { value: 'count', order: 'desc' } } : {}),
      },
    });
    return result.calculations?.[0] ?? {};
  };
  const count = async (...filters) => (await query(filters)).aggregates?.[0]?.value ?? 0;

  const all503 = await query([filter(STATUS, 'eq', 503, 'number')]);
  const buckets = (all503.series ?? []).map((point) =>
    (point.data ?? []).reduce((sum, row) => sum + (row.value ?? 0), 0),
  );
  const blockedRequests = {};
  for (const ua of WAF_BLOCKED_UAS) blockedRequests[ua] = await count(...buildBlockedUaFilters(ua));
  let versionRequests = 0;
  for (const path of VERSION_PATHS) versionRequests += await count(filter(PATH, 'eq', path));
  const jobCanonV2SuccessByDay = await query(
    buildJobCanonV2SuccessLogFilters(),
    LOG_MESSAGE,
    WINDOW_DAYS + 2,
  );
  const jobCanonV2SuccessRows = jobCanonV2SuccessByDay.aggregates ?? [];
  const jobCanonV2SuccessDays = jobCanonV2SuccessRows
    .map((row) => typeof row.groupKey === 'string'
      ? row.groupKey.match(/"day":"(\d{4}-\d{2}-\d{2})"/)?.[1]
      : null)
    .filter(Boolean);
  const jobCanonV1Fallback = await query(buildJobCanonV1FallbackLogFilters());
  const jobCanonV1FallbackRows = jobCanonV1Fallback.aggregates ?? [];
  const samplingHistory = await collectSamplingHistory(timeframe);

  const events = await telemetry({
    queryId: 'cf-observability-audit-size',
    view: 'events',
    limit: 100,
    timeframe: { from: now - 36e5, to: now },
    parameters: { datasets: [], filters: [service], calculations: [], groupBys: [] },
  });
  const sizes = (events.events?.events ?? []).map((e) => e.$metadata?.eventSize).filter(Number.isFinite);

  const settingsRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/script-settings`,
    { headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } },
  );
  const settings = await settingsRes.json();
  if (!settingsRes.ok || settings.success === false) throw new Error(`script-settings HTTP ${settingsRes.status}`);
  const observability = settings.result?.observability ?? {};

  return {
    total: await count(),
    count503: all503.aggregates?.[0]?.value ?? 0,
    max503PerBucket: Math.max(0, ...buckets),
    count404: await count(filter(STATUS, 'eq', 404, 'number')),
    // Invocation rows carry request-line messages (for example `GET https://…`),
    // while console.error rows are separate `cf-worker-log` events. The query
    // therefore measures the structured signal only; it cannot claim a 1:1
    // relationship with the independently aggregated response-status rows.
    originFailureLogs: await count(...buildOriginFailureLogFilters()),
    jobCanonV2SuccessLogs: jobCanonV2SuccessRows.reduce((sum, row) => sum + (row.value ?? 0), 0),
    jobCanonV2SuccessDays,
    jobCanonV2SampleIntervals: jobCanonV2SuccessRows.map((row) => row.sampleInterval ?? null),
    jobCanonV1FallbackLogs: jobCanonV1FallbackRows.reduce((sum, row) => sum + (row.value ?? 0), 0),
    jobCanonV1SampleIntervals: jobCanonV1FallbackRows
      .filter((row) => (row.value ?? 0) > 0)
      .map((row) => row.sampleInterval ?? null),
    samplingHistory,
    queryWindowDays: (timeframe.to - timeframe.from) / 864e5,
    internalCrawlerRequests: await count(filter(USER_AGENT, 'includes', INTERNAL_CRAWLER_UA)),
    versionRequests,
    blockedRequests,
    topUserAgents: ((await query([], USER_AGENT)).aggregates ?? []).map((row) => ({ ua: row.groupKey ?? '', count: row.value })),
    googlebotTotal: await count(filter(USER_AGENT, 'includes', 'Googlebot')),
    googlebot301: await count(filter(USER_AGENT, 'includes', 'Googlebot'), filter(STATUS, 'eq', 301, 'number')),
    avgEventBytes: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0,
    samplingRate: Number.isFinite(observability.logs?.head_sampling_rate)
      ? observability.logs.head_sampling_rate
      : null,
    redactQueryString: observability.redact_query_string,
  };
}

export function isReportOnly(now = new Date()) {
  return now.toISOString().slice(0, 10) < FIRST_BACKLOG_RUN;
}

export async function main({ dryRun = process.argv.includes('--dry-run') || isReportOnly() } = {}) {
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID) {
    throw new Error('CF_API_TOKEN / CF_ACCOUNT_ID missing');
  }
  const snapshot = await collectSnapshot();
  if (snapshot.total === 0) throw new Error('no events in the window: refusing a green run without data');
  const jobCanonReceipt = evaluateJobCanonV1Retirement(snapshot);
  console.log(`[cf-observability-audit] receipt job-canon-v1-retirement ${JSON.stringify(jobCanonReceipt)}`);
  const checks = evaluateChecks(snapshot);
  for (const check of checks) {
    console.log(`[cf-observability-audit] ${check.failed ? 'FAIL' : 'ok  '} ${check.id}: ${check.value}`);
    if (dryRun) continue;
    if (check.failed) {
      await createGithubIssue({
        title: issueTitle(check),
        description: buildIssueBody(check),
        priority: check.id === '5xx-burst' ? 2 : 3,
        labels: ['monitoring', 'cloudflare-observability'],
        workflow: 'Cloudflare Observability Audit',
        exactTitle: true,
      });
    } else {
      resolveGithubIssue(issueTitle(check), { exactTitle: true, workflow: 'Cloudflare Observability Audit' });
    }
  }
  return checks;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
