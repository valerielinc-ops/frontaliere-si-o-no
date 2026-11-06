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
// First full window after the fixes of 2026-10-30 are live. Earlier runs only
// print: the window still holds the old traffic, and each issue would start an
// autonomous fix for a problem already solved.
export const FIRST_BACKLOG_RUN = '2026-11-09';
export const DRY_RUN_COMMAND =
  'source bin/rc-env.sh && node frontaliere-si-o-no/scripts/cf-observability-audit.mjs --dry-run';

// Cloudflare Observability paid allowances, per billing cycle.
const INCLUDED_INGEST_GB = 50;
const INCLUDED_STORAGE_GB_MONTH = 10;
const RETENTION_DAYS = 7;

const INTERNAL_CRAWLER_UA = 'frontaliere-bing-tree-crawler';
export const WAF_BLOCKED_UAS = ['Baiduspider', 'CorsairBot', 'Chrome/48.0.2564.116', 'Chrome/99.0.4844.51'];
const VERSION_PATHS = ['/commit-hash.txt', '/build-id.txt'];
const AUTOMATED_UA_RE = /bot|crawl|spider|python|curl|wget|scrapy|go-http|axios|java\//i;
const WELCOMED_UA_RE =
  /googlebot|bingbot|applebot|gptbot|oai-searchbot|chatgpt|claudebot|claude-user|perplexity|duckduck|yandex|exasearchbot|reflectionbot|frontaliere/i;

const share = (part, total) => (total > 0 ? part / total : 0);
const pct = (value) => `${(value * 100).toFixed(1)}%`;

export function estimateMonthlyLogVolume({ events, avgEventBytes }) {
  const ingestGb = (events * avgEventBytes * (30 / WINDOW_DAYS)) / 1e9;
  return { ingestGb, storageGbMonth: (ingestGb / 30) * RETENTION_DAYS };
}

/**
 * The ten checks. Pure: `s` is the snapshot built by collectSnapshot.
 * Returns only the failing ids' findings plus the list of all ids.
 */
export function evaluateChecks(s, now = new Date()) {
  const scale = s.samplingRate > 0 ? 1 / s.samplingRate : 1;
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
      title: '503 senza causa nei log',
      failed: s.count503 * scale >= 50 && s.originFailureLogs === 0,
      value: `${s.count503} 503 e ${s.originFailureLogs} righe origin_failure`,
      target: 'ogni 503 ha una riga origin_failure',
      fix: 'Verificare che il percorso che risponde 503 chiami `logEdgeFailure` in locale-router.js.',
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
        (volume.ingestGb > INCLUDED_INGEST_GB ||
          volume.storageGbMonth > INCLUDED_STORAGE_GB_MONTH ||
          s.samplingRate > 0.1),
      value: `~${volume.ingestGb.toFixed(0)} GB/mese, ~${volume.storageGbMonth.toFixed(1)} GB-mese, sampling ${s.samplingRate}`,
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

const STATUS = '$workers.event.response.status';
const USER_AGENT = '$workers.event.request.headers.user-agent';
const PATH = '$workers.event.path';
const filter = (key, operation, value, type = 'string') => ({ key, operation, value, type });

export async function collectSnapshot(now = Date.now()) {
  const timeframe = { from: now - WINDOW_DAYS * 864e5, to: now };
  const service = filter('$metadata.service', 'eq', WORKER_NAME);
  let id = 0;
  const query = async (filters, groupBy, limit = 50) => {
    const result = await telemetry({
      queryId: `cf-observability-audit-${++id}`,
      view: 'calculations',
      limit,
      timeframe,
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
  for (const ua of WAF_BLOCKED_UAS) blockedRequests[ua] = await count(filter(USER_AGENT, 'includes', ua));
  let versionRequests = 0;
  for (const path of VERSION_PATHS) versionRequests += await count(filter(PATH, 'eq', path));

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
    originFailureLogs: await count(filter('$metadata.message', 'includes', 'origin_failure')),
    internalCrawlerRequests: await count(filter(USER_AGENT, 'includes', INTERNAL_CRAWLER_UA)),
    versionRequests,
    blockedRequests,
    topUserAgents: ((await query([], USER_AGENT)).aggregates ?? []).map((row) => ({ ua: row.groupKey ?? '', count: row.value })),
    googlebotTotal: await count(filter(USER_AGENT, 'includes', 'Googlebot')),
    googlebot301: await count(filter(USER_AGENT, 'includes', 'Googlebot'), filter(STATUS, 'eq', 301, 'number')),
    avgEventBytes: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0,
    samplingRate: observability.logs?.head_sampling_rate ?? observability.head_sampling_rate ?? 1,
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
